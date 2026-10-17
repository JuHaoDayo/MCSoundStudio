const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 所有可写运行数据都落在 appDir()/data/，而不是用户配置目录或系统临时目录。
// 优先级：
//   1) MCS_STARTUP_USER_DATA —— 启动回归探针用的强隔离口（scripts/verify-portable-startup.js）
//   2) MCS_USER_DATA_DIR     —— 显式指定数据目录（开发环境或自定义部署用）
//   3) 打包运行（用户双击 exe）：exe 同级的 data\ —— 免安装目录版的数据就在程序旁边，
//      不再写 %USERPROFILE%\AppData\Roaming\mcsound-studio（迁移前的老行为）。
//   4) 开发运行（electron .）：仓库根目录 data\，不再写 %APPDATA%\Electron；
//      显式环境变量仍优先，供开发测试隔离 userData 使用。
const startupProbeFile = process.env.MCS_STARTUP_PROBE_FILE || '';
const userDataOverride = process.env.MCS_STARTUP_USER_DATA || process.env.MCS_USER_DATA_DIR || '';
const userDataDir = userDataOverride || path.join(appDir(), 'data');
if (userDataDir) {
  // 这些路径都在 app ready 前钉住；避免 userData 以外的 Chromium 会话、日志、崩溃转储
  // 或 Electron 临时文件悄悄回落到 %LOCALAPPDATA% / %TEMP%。
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const writablePaths = {
      userData: userDataDir,
      sessionData: path.join(userDataDir, 'session'),
      crashDumps: path.join(userDataDir, 'crash-dumps'),
      temp: path.join(userDataDir, 'temp'),
    };
    for (const dir of Object.values(writablePaths)) fs.mkdirSync(dir, { recursive: true });
    for (const [name, dir] of Object.entries(writablePaths)) app.setPath(name, dir);
    app.setAppLogsPath(path.join(userDataDir, 'logs'));
  } catch (e) { /* 建不出来时交给 Electron 默认行为，启动本身不能被数据目录问题阻断。 */ }
}
function reportStartupProbe(stage, details) {
  if (!startupProbeFile) return;
  try {
    fs.appendFileSync(startupProbeFile, JSON.stringify({
      stage,
      at: new Date().toISOString(),
      ...details,
    }) + '\n', 'utf8');
  } catch (e) { /* 探针写失败不能影响真实启动 */ }
}

const isDev = process.argv.includes('--dev');

let mainWindow = null;

function createWindow() {
  let startupProbeCreated = false;
  let startupProbeLoaded = false;
  function maybeAutoQuitStartupProbe() {
    if (process.env.MCS_STARTUP_AUTO_QUIT === '1' && startupProbeCreated && startupProbeLoaded) {
      setImmediate(() => app.quit());
    }
  }

  mainWindow = new BrowserWindow({
    width: 1560,
    height: 940,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#14161a',
    title: 'MCSoundStudio - 音效时序编辑器',
    // 窗口/任务栏图标。开发时读工程里的 build/icon.png；
    // 打包后该路径在 asar 里也有（files 已包含 build/），取不到就算了 —— 
    // exe 本身已嵌入 icon.ico，不影响文件图标。
    icon: (() => {
      const p = path.join(__dirname, '..', '..', 'build', 'icon.png');
      try { return fs.existsSync(p) ? p : undefined; } catch (e) { return undefined; }
    })(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 允许加载本地音频文件（file:// 音频在渲染进程播放）
      webSecurity: false,
    },
  });
  reportStartupProbe('browser-window-created', { visible: mainWindow.isVisible() });
  startupProbeCreated = true;

  mainWindow.once('ready-to-show', () => {
    reportStartupProbe('ready-to-show', { visible: mainWindow.isVisible() });
  });
  mainWindow.webContents.once('did-finish-load', () => {
    reportStartupProbe('did-finish-load', {
      url: mainWindow.webContents.getURL(),
      visible: mainWindow.isVisible(),
    });
    startupProbeLoaded = true;
    // 回归脚本只在已创建可见窗口且 loadFile 完成后请求正常退出，避免残留测试进程占用下一轮。
    maybeAutoQuitStartupProbe();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  attachSaveShortcutBridge(mainWindow);

  // 必须在 BrowserWindow 真正销毁前拦住关闭。以前只在 app.before-quit 里问，
  // 用户点窗口右上角 × 时，closed 已先发生，选「取消 / 返回保存」也回不到编辑器。
  let allowClose = false;
  mainWindow.on('close', (event) => {
    if (allowClose || reallyQuitting || !hasUnsavedChanges) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['取消', '不保存直接退出', '返回保存'],
      defaultId: 2,
      cancelId: 0,
      title: '有未保存的改动',
      message: '当前工程还没保存，确定要退出吗？',
      detail: '选择「返回保存」会留在编辑器里，你可以先按 Ctrl+S 保存。\n'
            + '选择「不保存直接退出」会丢弃这次的改动。',
    });
    if (choice === 1) {
      reallyQuitting = true;
      allowClose = true;
      mainWindow.close();
    } else if (choice === 2 && !mainWindow.isDestroyed()) {
      mainWindow.focus();
    }
    // choice === 0：保持窗口和当前文档原样不动。
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 渲染进程通过 IPC 告诉主进程「当前有没有未保存的改动」，
// 关窗时据此决定是否弹二次确认。
let hasUnsavedChanges = false;
// 用户已经确认过「不保存直接退出」：之后不再拦窗口关闭 / 应用退出。
let reallyQuitting = false;

// ---------------------------------------------------------------------------
// 输入法组字期间把 Ctrl+S / Ctrl+Shift+S 转发给渲染进程
//
// 为什么必须放在主进程（实测数据，mcs-qa 卡 t_e3735e8c）：
//   搜索框里用中文输入法打拼音、候选框还开着时按 Ctrl+S，渲染进程收到的是
//   {key:'Process', keyCode:229, ctrlKey:true} —— app.js 里 `e.key === 's'`
//   永远不成立 → 既不保存、也不落盘、状态栏一个字都不变，用户却以为存过了
//   （状态栏里恰好挂着上一条「已保存工程：…」）。
//   而主进程 before-input-event 里，keyDown 同样是被吞掉的 'Process'，
//   但 keyUp 那一拍会带真实的 key='s' + control=true，所以这条路接得回来。
//
// 只在「这一次 Ctrl+字母的 keyDown 确实被输入法吞成 Process」时才转发：
// 普通情况下渲染进程自己就保存了，转发会让一次按键保存两次
// （Ctrl+Shift+S 会连弹两次「另存为」）。
// ---------------------------------------------------------------------------
function attachSaveShortcutBridge(win) {
  let imeSwallowedCtrlDownAt = 0;    // 最近一次「被输入法吞掉的 Ctrl+字母 keyDown」的时间戳
  const IME_WINDOW_MS = 3000;        // 超过这个时间就不再认，避免把两次按键串成一次

  win.webContents.on('before-input-event', (_e, input) => {
    // 只关心带 Ctrl（macOS 上是 Cmd）的组合；注意 keyUp 的 Control 键自身
    // 报的是 control=false，所以这个判断必须在这里，不能只看 key。
    if (!input.control && !input.meta) return;

    if (input.type === 'keyDown') {
      // key='Process' = 输入法把字母吞了；正常的 Ctrl+S，keyDown 就带真实的 's'。
      imeSwallowedCtrlDownAt = String(input.key) === 'Process' ? Date.now() : 0;
      return;
    }
    if (input.type !== 'keyUp') return;
    if (String(input.key || '').toLowerCase() !== 's') return;

    if (!imeSwallowedCtrlDownAt || Date.now() - imeSwallowedCtrlDownAt > IME_WINDOW_MS) return;
    imeSwallowedCtrlDownAt = 0;
    if (!win.isDestroyed()) {
      win.webContents.send('save-shortcut', { saveAs: !!input.shift });
    }
  });
}

ipcMain.handle('set-dirty', (e, dirty) => {
  hasUnsavedChanges = !!dirty;
  return true;
});

// 新建 / 打开工程前，渲染进程复用这一份原生三选确认。保存动作必须由渲染进程
// 执行（它掌握当前工程内容与 SAVE_PATH）；这里仅返回用户选择，避免主进程拿旧快照。
ipcMain.handle('confirm-unsaved-changes', (event) => {
  if (!hasUnsavedChanges) return 'continue';
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const choice = dialog.showMessageBoxSync(win || undefined, {
    type: 'warning',
    buttons: ['保存并继续', '不保存继续', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: '有未保存的改动',
    message: '当前工程还没保存，要先保存再继续吗？',
    detail: '继续会切换到另一份工程或新建工程。选择「不保存继续」会丢弃当前改动。',
  });
  return ['save', 'discard', 'cancel'][choice] || 'cancel';
});

app.on('before-quit', (e) => {
  if (reallyQuitting) return;
  if (!hasUnsavedChanges) return;
  e.preventDefault();
  const win = BrowserWindow.getAllWindows()[0];
  const choice = dialog.showMessageBoxSync(win || undefined, {
    type: 'warning',
    buttons: ['取消', '不保存直接退出', '返回保存'],
    defaultId: 2,
    cancelId: 0,
    title: '有未保存的改动',
    message: '当前工程还没保存，确定要退出吗？',
    detail: '选择「返回保存」会回到编辑器（然后按 Ctrl+S 保存）。\n'
          + '选择「不保存直接退出」会丢弃这次的改动。',
  });
  if (choice === 1) {
    reallyQuitting = true;
    app.quit();
  } else if (choice === 2 && win) {
    // 这里是应用级退出（例如系统菜单）才会走到；窗口尚在，返回编辑器即可。
    win.focus();
  }
  // choice === 0（取消）：什么都不做，停在编辑器里
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC: 文件系统桥接
// ---------------------------------------------------------------------------

/** 递归扫描音频目录，返回 {relPath, absPath, ext, size} 列表 */
function scanAudioDir(root, base, out, depth) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      scanAudioDir(full, base, out, depth + 1);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (['.ogg', '.wav', '.mp3', '.fsb', '.flac', '.m4a'].includes(ext)) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch (e) { /* ignore */ }
        out.push({
          relPath: path.relative(base, full).split(path.sep).join('/'),
          absPath: full,
          ext,
          size,
          name: path.basename(ent.name, ext),
        });
      }
    }
  }
  return out;
}

ipcMain.handle('scan-sound-dir', async (_evt, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) {
      return { ok: false, error: '目录不存在: ' + dirPath };
    }
    const files = scanAudioDir(dirPath, dirPath, [], 0);
    return { ok: true, root: dirPath, files };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/** 读取任意文本文件（.bbmodel / .animation.json / timeline.json） */
ipcMain.handle('read-text-file', async (_evt, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content, path: filePath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/** 读取二进制文件为 base64（贴图等） */
ipcMain.handle('read-binary-file', async (_evt, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : 'application/octet-stream';
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, path: filePath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/**
 * 读原始字节（不是 dataUrl）。
 * GIF 逐帧解析需要原始二进制，dataUrl 要先 base64 解码太绕。
 * 返回 Uint8Array —— Electron 的 structured clone 支持。
 */
ipcMain.handle('read-raw-bytes', async (_evt, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    return { ok: true, bytes: new Uint8Array(buf), path: filePath, size: buf.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/** 选择目录 */
ipcMain.handle('pick-directory', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择音效目录',
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: res.filePaths[0] };
});

/** 选择文件（可多选，可过滤） */
ipcMain.handle('pick-files', async (_evt, opts) => {
  const filters = (opts && opts.filters) || [
    { name: '所有支持的文件', extensions: ['ogg', 'wav', 'mp3', 'gif', 'png', 'mp4', 'webm', 'mov', 'bbmodel', 'json'] },
  ];
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters,
    title: (opts && opts.title) || '选择文件',
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, paths: res.filePaths };
});

/** 保存文件 */
ipcMain.handle('save-file', async (_evt, { defaultName, defaultPath, content, filters }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    // 允许调用方指定「默认落到哪个目录」（工程库），defaultName 仍然只是文件名
    defaultPath: defaultPath || defaultName,
    filters: filters || [{ name: '所有文件', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/** 保存多个文件到一个目录 */
ipcMain.handle('save-many', async (_evt, { files }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择导出目录',
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const outDir = res.filePaths[0];
  const written = [];
  try {
    for (const f of files) {
      const full = path.join(outDir, f.name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content, 'utf8');
      written.push(full);
    }
    return { ok: true, dir: outDir, written };
  } catch (e) {
    return { ok: false, error: String(e), written };
  }
});

/** 设置窗口标题 */
ipcMain.handle('set-title', async (_evt, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(String(title || 'MCSoundStudio'));
  return { ok: true };
});

/** 写文件到指定目录（自动化测试用，跳过目录选择对话框） */
ipcMain.handle('save-many-to-dir', async (_evt, { dir, files }) => {
  // 默认导出目录：免安装目录的 data\exports\，不写入用户配置目录。
  // 真实用户导出走目录选择对话框，这里只是自动化测试省略 dir 时的兜底。
  const outDir = dir || path.join(app.getPath('userData'), 'exports');
  const written = [];
  try {
    for (const f of files) {
      const full = path.join(outDir, f.name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content, 'utf8');
      written.push(full);
    }
    return { ok: true, dir: outDir, written };
  } catch (e) {
    return { ok: false, error: String(e), written };
  }
});

/** 获取内置音效库目录 */
ipcMain.handle('get-bundled-sounds-dir', async () => {
  const devPath = path.join(__dirname, '..', '..', 'sounds');
  const prodPath = path.join(process.resourcesPath || '', 'sounds');
  if (fs.existsSync(devPath)) return { ok: true, path: devPath };
  if (fs.existsSync(prodPath)) return { ok: true, path: prodPath };
  return { ok: false, error: '未找到内置音效库' };
});

/** 加载原版音效库索引（sounds/vanilla/library.json） */
ipcMain.handle('load-vanilla-library', async () => {
  const devPath = path.join(__dirname, '..', '..', 'sounds', 'vanilla', 'library.json');
  const prodPath = path.join(process.resourcesPath || '', 'sounds', 'vanilla', 'library.json');
  const p = fs.existsSync(devPath) ? devPath : (fs.existsSync(prodPath) ? prodPath : null);
  if (!p) {
    return {
      ok: false,
      error: '未找到 sounds/vanilla/library.json，请先运行 scripts/build-vanilla-library.js 构建',
    };
  }
  try {
    const lib = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 音频目录的查找顺序很重要（见 findAudioDir）：
    //   1) exe 所在目录旁边的 audio/  ← 用户自己放音频用的，最优先
    //   2) exe 旁边的 sounds/vanilla/audio
    //   3) 包内 resources/sounds/vanilla/audio ← 打包进来的内置原版音频
    //   4) library.json 同级的 audio/ ← 开发环境
    // 单文件 portable 版每次启动会把资源解到 %TEMP% 的随机目录，
    // 所以「exe 旁边」不能靠 process.resourcesPath 推出来，只能用 exe 自身路径；
    // 内置音频反过来只能用 process.resourcesPath 找。两条路都要留着。
    const audioDir = findAudioDir(p);
    rebindVariantPaths(lib, audioDir);
    return { ok: true, library: lib, path: p, audioStatus: audioDirStatus(audioDir) };
  } catch (e) {
    return { ok: false, error: '解析 library.json 失败: ' + e.message };
  }
});

/**
 * 「exe 真正所在目录」。
 *
 * 单文件 portable 版有个坑：它会把自身解压到 %TEMP%\<随机>\ 再运行，
 * 所以 app.getPath('exe') 指向的是那个临时目录，不是用户双击的文件位置。
 * electron-builder 为此提供了 PORTABLE_EXECUTABLE_DIR 环境变量，指向真实目录。
 * 必须优先用它，否则会把音频找成 %TEMP% 下的空目录。
 */
function appDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return path.dirname(process.env.PORTABLE_EXECUTABLE_FILE);
  }
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  return path.join(__dirname, '..', '..');   // 开发时
}

/**
 * 找音频目录。按优先级返回第一个存在的候选，都不存在时返回首选位置
 * （用于给用户提示「该把音频放哪」）。
 *
 * 候选 3 是「打进包里的内置原版音频」：
 *   打包时 extraResources 把 sounds/ 整个复制到 resources/ 下，所以内置音频的
 *   落点是 <resourcesPath>/sounds/vanilla/audio。
 *   - 单文件 portable 版每次启动把自己解到 %TEMP%\<随机>\ 再运行，
 *     process.resourcesPath 指向那个临时目录 —— 所以内置音频只能靠 resourcesPath
 *     找，靠 exe 路径（appDir）是找不到的；
 *   - 安装版（nsis）同理是 <安装目录>\resources\sounds\vanilla\audio。
 * 前两个候选仍然排在前面，给「用户自己在 exe 旁边放音频」留出路子。
 */
function findAudioDir(libraryPath) {
  const candidates = [
    path.join(appDir(), 'audio'),                 // exe 旁边的 audio/  ← 用户自己放的，最优先
    path.join(appDir(), 'sounds', 'vanilla', 'audio'), // exe 旁边保留目录结构
  ];
  // 包内内置音频（extraResources 的落点）。开发环境没有 resourcesPath，跳过。
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'sounds', 'vanilla', 'audio'));
  }
  candidates.push(path.join(path.dirname(libraryPath), 'audio')); // 元数据同级（开发环境）
  for (const c of candidates) {
    if (hasOgg(c)) return c;
  }
  // 没有可用的：优先提示「exe 旁边放音频」
  return candidates[0];
}

/** 递归看目录里有没有 .ogg（数几个就够，不必全扫）。 */
function hasOgg(dir, limit = 1) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const stack = [dir];
  let guard = 0;
  while (stack.length && guard++ < 20000) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      if (ent.isDirectory()) stack.push(path.join(cur, ent.name));
      else if (ent.name.toLowerCase().endsWith('.ogg')) {
        n++;
        if (n >= limit) return n;
      }
    }
  }
  return n;
}

/**
 * 把变体的 absPath 重绑到本机实际音频目录。
 * 优先用 absPath 里的相对部分拼到新目录；缺失时退回按变体 file 字段拼。
 */
function rebindVariantPaths(lib, audioDir) {
  if (!lib || !Array.isArray(lib.events)) return 0;
  const norm = (s) => String(s).replace(/\\/g, '/');
  const root = norm(audioDir);
  let n = 0;
  for (const ev of lib.events) {
    for (const v of (ev.variants || [])) {
      // 变体记录里已有相对路径形式（如 ambient/nether/.../basaltground1）
      const rel = v.relPath || v.file;
      let target = null;
      if (rel) {
        target = path.join(audioDir, rel + (path.extname(rel) ? '' : '.ogg'));
      } else if (v.absPath) {
        // 从旧绝对路径里抠出 audio/ 之后的部分
        const seg = norm(v.absPath).split('/vanilla/audio/')[1];
        if (seg) target = path.join(audioDir, seg);
      }
      if (target) { v.absPath = target; n++; }
    }
  }
  lib.audioRoot = root;
  return n;
}

/**
 * 检查音频目录是否可用。
 * 正常情况下内置原版音频已经打进包（见 findAudioDir 的候选 3），这里会返回 ok=true。
 * 只有「包内音频缺失/被删」或「用户自放的目录是空壳」时才会报不可用，
 * 此时要明确告诉用户「元数据在、音频不在」以及该怎么做，避免他以为程序坏了。
 */
function audioDirStatus(dir) {
  if (!fs.existsSync(dir)) {
    return {
      ok: false,
      dir,
      reason: 'missing-dir',
      hint: `没有找到试听音频文件夹。\n`
        + `请把音频文件夹（内部是 block/ mob/ ambient/ 等子目录的 .ogg 文件）放到这里：\n`
        + `    ${dir}\n`
        + '放好后重启程序即可试听。\n'
        + '音效库的名称、分类、事件 ID 已内置，即使不放音频也能正常编排和导出。',
    };
  }
  let n = 0;
  try {
    // 必须递归统计：音频是按 block/ mob/ ambient/ 等子目录组织的，
    // 只数顶层文件会误判成「空目录」，让用户看到假的「试听不可用」提示。
    const stack = [dir];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of entries) {
        if (ent.isDirectory()) stack.push(path.join(cur, ent.name));
        else if (ent.name.toLowerCase().endsWith('.ogg')) n++;
      }
      // 数够了就不用继续扫（3717 个文件全扫一遍没必要）
      if (n > 0) break;
    }
  } catch (e) { /* 忽略 */ }
  if (!n) {
    return {
      ok: false,
      dir,
      reason: 'empty-dir',
      hint: `音频文件夹里没有找到 .ogg 文件：\n    ${dir}\n`
        + '把音频放进去（支持子文件夹）后重启程序即可试听。\n'
        + '不影响拖拽编排和导出。',
    };
  }
  return { ok: true, dir, count: n };
}

/** 让用户一键打开（必要时先创建）试听音频应该放的文件夹。 */
ipcMain.handle('open-audio-folder', async () => {
  const dir = findAudioDir(
    path.join(process.resourcesPath || '', 'sounds', 'vanilla', 'library.json'),
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) return { ok: false, error: err, dir };
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: e.message, dir };
  }
});

/** 加载原版音效的中文描述表 */
ipcMain.handle('load-vanilla-descriptions', async () => {
  const devPath = path.join(__dirname, '..', '..', 'sounds', 'vanilla', 'descriptions.json');
  const prodPath = path.join(process.resourcesPath || '', 'sounds', 'vanilla', 'descriptions.json');
  const p = fs.existsSync(devPath) ? devPath : (fs.existsSync(prodPath) ? prodPath : null);
  if (!p) return { ok: false, error: '未找到 descriptions.json', descriptions: {} };
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ok: true, descriptions: doc.descriptions || {}, stats: doc.stats };
  } catch (e) {
    return { ok: false, error: '解析 descriptions.json 失败: ' + e.message, descriptions: {} };
  }
});

// ---------------------------------------------------------------------------
// 内置离线使用教程窗口 + 作者外链（卡 t_7ee2bf5b）
//
// 放在文件末尾、单独一个模块里，是为了跟卡 t_fa17801d（工程总览 / 工程导入）的
// main.js 改动错开：那边改的是文件顶部和各 IPC 注册处，这里只多这一行 require。
// 模块自己注册 ipcMain.handle('open-help' / 'open-external')，加载即生效
// （ipcMain 的 handler 在 app ready 之前注册也没问题）。
// ---------------------------------------------------------------------------
require('./help');

// ---------------------------------------------------------------------------
// 工程库 / 工程总览（卡 t_fa17801d）
//
// 同样只留一行 require：IPC 注册全在 ./project-ipc.js，
// 目录扫描与元数据提取在 ./project-library.js（纯 Node，不含 electron）。
// 这么拆是因为本卡与卡 t_7ee2bf5b 并行改这个文件，
// 整文件写入曾经覆盖掉对方刚插入的一段 —— 一行 hookup 最不容易被踩掉。
// ---------------------------------------------------------------------------
require('./project-ipc');

// ---------------------------------------------------------------------------
// 系统信息导出（卡 t_20c2e144）
//
// 同样是「一行 require」的自注册模块：系统 / 显卡 / 屏幕 / 库规模的采集与
// 「另存为 txt」对话框都在 ./sysinfo.js 里，本文件只留这一行 hookup，
// 免得与别的卡并行改这个热点文件时互相覆盖。
// 模块自己注册 ipcMain.handle('export-system-info' / 'collect-system-info')。
// ---------------------------------------------------------------------------
require('./sysinfo');
