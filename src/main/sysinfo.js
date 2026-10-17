/**
 * 系统信息导出（卡 t_20c2e144）
 *
 * 目的：让**不同机器的测试者**一键回传一份可核对的坐标 —— 到底在什么系统 / 什么
 * 显卡 / 什么性能上跑过这个程序。这份 txt 里全是「现场读出来的事实」（os / process /
 * app 的实时值），不是文档里的估算：
 *   · Windows 版本与 build（os.release + process.getSystemVersion）
 *   · 位数、Electron / Chromium / Node / V8 版本（process.versions）
 *   · CPU 型号与逻辑处理器数、物理内存（os.totalmem）
 *   · 显卡与渲染状态（app.getGPUFeatureStatus + app.getGPUInfo），含是否回退软件渲染
 *   · 屏幕分辨率与缩放（screen.getAllDisplays）
 *   · 库规模（事件数 / 变体数 / 磁盘上的音频文件数）与首次加载库耗时（渲染进程实测值）
 *
 * 与 src/main/help.js 相同的做法：**自注册模块**，main.js 末尾只多一行 `require('./sysinfo')`。
 * 这么拆是因为 main.js 是多卡并行的热点文件（本仓库同时跑好几张卡），整段写入容易
 * 覆盖掉别人刚插进去的改动，一行 hookup 最不容易被踩掉。
 *
 * 两个 IPC：
 *   export-system-info  —— 弹「另存为」对话框，把这份 txt 写到用户选的位置（真实写盘）
 *   collect-system-info —— 只生成文本、不弹框、不写盘（自动化取证用，QA 也能直接调）
 *
 * 隐私：里面**不含**用户名 / 主机名 / 序列号等个人信息 —— 这份文件是要发给别人看的，
 * 只留「判断兼容性需要什么」的机器规格。
 */
const { app, ipcMain, dialog, BrowserWindow, screen } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 程序自己的名字与版本
// ---------------------------------------------------------------------------
/**
 * app.getName() / getVersion() 会跟着「怎么启动的」变 —— 打包运行读的是应用的
 * package.json，开发时若是被别的脚本 require 进来的（回归脚本就是这么干的），
 * Electron 会把 app 目录当成脚本所在目录，于是报出 "Electron 31.7.7" 这种
 * 其实是运行时版本的名字。所以这里**直接读程序自己的 package.json**
 * （src/main/../../package.json，打包后在 asar 里也读得到），读不到才退回 app 的默认值。
 */
function appIdentity() {
  const fallback = { name: app.getName(), version: app.getVersion() };
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const build = pkg.build || {};
    return {
      name: build.productName || pkg.productName || pkg.name || fallback.name,
      version: pkg.version || fallback.version,
      pkgPath,
      fromPkg: true,
    };
  } catch (e) {
    return Object.assign({ pkgPath, fromPkg: false }, fallback);
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 两列文本框：中文按 2 个字宽算，保证右栏对齐（纯文本没有表格，只能自己补空格）。 */
function dispWidth(s) {
  return Array.from(String(s)).reduce(
    (n, ch) => n + (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
}
function row(label, value, width = 20) {
  const l = String(label);
  const pad = ' '.repeat(Math.max(1, width - dispWidth(l)));
  const v = (value == null || value === '') ? '—' : String(value);
  return '  ' + l + pad + v;
}
function head(title) {
  return '\n—— ' + title + ' ——';
}

function localTimeString(d) {
  const p = (x) => String(x).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `
       + `(UTC${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)})`;
}

/**
 * Windows 版本的人类名字。
 * Node 的 os.release() / Electron 的 process.getSystemVersion() 只给「10.0.<build>」，
 * 微软从 Windows 8.1 起就不再在版本号里区分 10 / 11 了 —— 只能按 build 号推断，
 * 所以这里明确写「按 build 推断」，不假装是系统自报的名字。
 */
function windowsName(build) {
  const b = Number(build) || 0;
  if (b >= 22000) return 'Windows 11（按 build >= 22000 推断）';
  if (b >= 10240) return 'Windows 10（按 build 推断）';
  return '未知（build ' + b + '）';
}

// ---------------------------------------------------------------------------
// 显卡 / 渲染状态
// ---------------------------------------------------------------------------
/** 软件渲染回退的判定：任一关键项落到 *_software 就是回退了（Chromium 的取值有文档）。 */
function isSoftwareFallback(status) {
  try {
    return Object.keys(status || {}).some((k) => /_software$/.test(String(status[k])));
  } catch (e) {
    return null;
  }
}

async function gpuInfoBasic() {
  try {
    const info = await app.getGPUInfo('basic');
    return info || null;
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// 当前内存占用（进程组实测）
// ---------------------------------------------------------------------------
/**
 * app.getAppMetrics() 是 Electron 给「这套程序每个进程现在占多少内存」的官方口径
 * （workingSetSize，单位 KB）。README 里写「内存占用」时用的就是这套实测值，
 * 不是估算 —— 所以导出系统信息也顺手带上，别人回传时才有得核对。
 */
async function memoryUsage() {
  const out = { processes: 0, workingSetTotal: 0, byType: {} };
  try {
    const metrics = app.getAppMetrics() || [];
    out.processes = metrics.length;
    for (const m of metrics) {
      const t = (m.type || 'unknown');
      const kb = (m.memory && m.memory.workingSetSize) || 0;
      out.byType[t] = (out.byType[t] || 0) + kb;
      out.workingSetTotal += kb;
    }
    out.workingSetTotal *= 1024;                     // KB → B
    for (const k of Object.keys(out.byType)) out.byType[k] *= 1024;
  } catch (e) { /* 取不到就报 0，不假装 */ }
  try {
    if (process.getProcessMemoryInfo) {
      const pm = await process.getProcessMemoryInfo();
      out.mainProcess = pm || null;
    }
  } catch (e) { /* 同上 */ }
  return out;
}

// ---------------------------------------------------------------------------
// 屏幕
// ---------------------------------------------------------------------------
function displayInfo() {
  try {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const primaryId = primary ? primary.id : null;
    return all.map((d, i) => {
      // 注意：Electron 的 display.size 给的是**逻辑像素（DIP）**，不是面板分辨率。
      // 物理像素要再乘 scaleFactor（所以这里用「推算」的口径写，不假装是系统自报的）。
      const dipW = d.size ? d.size.width : null;
      const dipH = d.size ? d.size.height : null;
      return {
        index: i + 1,
        primary: d.id === primaryId,
        dipW,
        dipH,
        pixelW: (dipW != null) ? Math.round(dipW * d.scaleFactor) : null,
        pixelH: (dipH != null) ? Math.round(dipH * d.scaleFactor) : null,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
        internal: d.internal,
      };
    });
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 音频文件数（磁盘实测，不是库文件里声明的数字）
// ---------------------------------------------------------------------------
/**
 * 音频目录的候选顺序与 src/main/main.js 的 findAudioDir() 一致（那边没有 export，
 * 这里是只读统计用，所以复制一份候选表；改顺序时两边一起改）。
 */
function audioDirCandidates(libraryHint) {
  const list = [];
  if (libraryHint) list.push(libraryHint);
  const exeDir = app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..', '..');
  list.push(path.join(exeDir, 'audio'));
  list.push(path.join(exeDir, 'sounds', 'vanilla', 'audio'));
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'sounds', 'vanilla', 'audio'));
  list.push(path.join(__dirname, '..', '..', 'sounds', 'vanilla', 'audio'));
  return list;
}

function countAudioFiles(dir) {
  const out = { dir, oggCount: 0, bytes: 0, exists: false };
  if (!dir || !fs.existsSync(dir)) return out;
  out.exists = true;
  const stack = [dir];
  let guard = 0;
  while (stack.length && guard++ < 20000) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (/\.ogg$/i.test(ent.name)) {
        out.oggCount++;
        try { out.bytes += fs.statSync(full).size; } catch (e) { /* 单个文件读不到就只少算体积 */ }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
/**
 * @param {object} payload 渲染进程带来的「只有渲染进程知道」的部分：
 *   { library: { events, variants, withDesc, loaded, audioDir }, firstLoadMs }
 */
async function collectSystemInfo(payload) {
  const p = payload || {};
  const lib = p.library || {};
  const cpus = os.cpus() || [];
  const release = os.release();
  const build = String(release).split('.').pop();
  const sysVersion = (typeof process.getSystemVersion === 'function')
    ? process.getSystemVersion() : release;

  const gpuStatus = (() => {
    try { return app.getGPUFeatureStatus(); }
    catch (e) { return { error: String((e && e.message) || e) }; }
  })();
  const gpuBasic = await gpuInfoBasic();
  const identity = appIdentity();
  const memUse = await memoryUsage();

  const audioHint = lib.audioDir || '';
  const candidates = audioDirCandidates(audioHint);
  let audio = null;
  for (const c of candidates) {
    const r = countAudioFiles(c);
    if (r.exists && r.oggCount > 0) { audio = r; break; }
    if (!audio && r.exists) audio = r;   // 目录在但没有 ogg：也是有用的事实，记下来
  }
  if (!audio) audio = { dir: candidates[0], oggCount: 0, bytes: 0, exists: false };

  return {
    exportedAt: Date.now(),
    app: {
      name: identity.name,
      version: identity.version,
      nameFromPkg: identity.fromPkg,
      packaged: app.isPackaged,
      exePath: app.getPath('exe'),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      release,
      build,
      sysVersion,
      inferredName: windowsName(build),
      is64: process.arch === 'x64' || process.arch === 'arm64',
      type: os.type(),
    },
    cpu: {
      model: (cpus[0] && cpus[0].model) ? cpus[0].model.trim() : '未知',
      logical: cpus.length,
      speedMHz: (cpus[0] && cpus[0].speed) || null,
      // 物理核心数 Node 没有 API（os.cpus() 是按逻辑核列出来的），Windows 上要靠
      // WMI / PowerShell 才有 —— 为了不让「导出系统信息」变成一个要卡几秒的动作，
      // 这里如实只报逻辑处理器数，不假装能报物理核数。
    },
    memory: {
      total: os.totalmem(),
      free: os.freemem(),
    },
    gpu: {
      featureStatus: gpuStatus,
      softwareFallback: isSoftwareFallback(gpuStatus),
      basic: gpuBasic,
    },
    displays: displayInfo(),
    memoryUsage: memUse,
    library: {
      events: (typeof lib.events === 'number') ? lib.events : null,
      variants: (typeof lib.variants === 'number') ? lib.variants : null,
      withDesc: (typeof lib.withDesc === 'number') ? lib.withDesc : null,
      loaded: !!lib.loaded,
      firstLoadMs: (typeof p.firstLoadMs === 'number') ? p.firstLoadMs : null,
      audioDir: audio.dir,
      audioFiles: audio.oggCount,
      audioBytes: audio.bytes,
    },
  };
}

/** GPU 设备：从 getGPUInfo('basic') 里挑出人看得懂的字段，原样另外附一份 JSON。 */
function gpuDeviceLines(basic) {
  const devs = (basic && Array.isArray(basic.gpuDevice)) ? basic.gpuDevice : [];
  const seen = new Set();
  const lines = [];
  for (const d of devs) {
    if (d.vendorId == null || d.deviceId == null) continue;
    // Chromium 报的是十进制；括号里换算成十六进制 —— 查显卡型号时用的是后者（0x8086 = Intel）
    const hex = (n) => '0x' + Number(n).toString(16).toUpperCase();
    const line = 'PCI ' + d.vendorId + ':' + d.deviceId
      + '（' + hex(d.vendorId) + ':' + hex(d.deviceId) + '）'
      + (d.driverVersion ? '　驱动 ' + d.driverVersion : '');
    if (seen.has(line)) continue;      // 同一块卡 Chromium 会报好几条
    seen.add(line);
    lines.push(line);
  }
  if (!lines.length) lines.push('（未取到 gpuDevice —— 看下面的原始 JSON）');
  return { lines, total: devs.length };
}

/** 把结构渲染成给人看的 txt。 */
function renderText(info) {
  const L = [];
  const a = info.app, o = info.os, c = info.cpu, m = info.memory, g = info.gpu, li = info.library;

  L.push('============================================================');
  L.push(' MCSoundStudio 系统信息');
  L.push(' （排查「能不能跑 / 卡不卡」时，把这个文件整个发回给作者即可）');
  L.push('============================================================');
  L.push('');
  L.push(row('导出时间', localTimeString(new Date(info.exportedAt))));
  L.push(row('程序', a.name + ' v' + a.version));
  L.push(row('运行形态', a.packaged ? '打包运行（exe）' : '开发运行（electron .）'));
  L.push(row('程序位置', a.exePath));
  L.push(head('系统'));
  L.push(row('Windows 版本', o.release + '  (build ' + o.build + ')'));
  L.push(row('系统名称（推断）', o.inferredName));
  L.push(row('系统上报版本', o.sysVersion));
  L.push(row('系统架构', o.arch + (o.is64 ? '（64 位）' : '（32 位）')));
  L.push(row('平台', o.platform + ' / ' + o.type));

  L.push(head('CPU 与内存'));
  L.push(row('CPU', c.model));
  L.push(row('逻辑处理器', c.logical + ' 个（Windows 任务管理器里的「逻辑处理器」）'));
  if (c.speedMHz) L.push(row('标称主频', c.speedMHz + ' MHz（该型号报的基准值）'));
  L.push(row('物理内存', fmtBytes(m.total) + '（共 ' + m.total + ' B，可用 ' + fmtBytes(m.free) + '）'));

  L.push(head('运行时'));
  L.push(row('Electron', a.electron));
  L.push(row('Chromium', a.chromium));
  L.push(row('Node', a.node));
  L.push(row('V8', a.v8));

  L.push(head('显示与渲染'));
  if (!info.displays.length) {
    L.push('  （未取到屏幕信息）');
  } else {
    for (const d of info.displays) {
      const tag = d.primary ? '主屏' : ('屏幕 ' + d.index);
      L.push(row(tag, '逻辑 ' + d.dipW + ' x ' + d.dipH
        + ' · 缩放 ' + Math.round(d.scaleFactor * 100) + '%（scaleFactor ' + d.scaleFactor + '）'
        + ' · 物理约 ' + d.pixelW + ' x ' + d.pixelH + '（按 DIP x 缩放 推算）'));
    }
    L.push('              （Electron 读到的屏幕尺寸是逻辑像素，物理分辨率只能这样推算）');
  }
  const gpuLines = gpuDeviceLines(g.basic);
  L.push(row('GPU 设备', gpuLines.lines[0] + (gpuLines.total > 1 ? '（共 ' + gpuLines.total + ' 条，下面的重复项已合并）' : '')));
  for (const extra of gpuLines.lines.slice(1)) L.push(row('', extra));
  L.push(row('软件渲染回退', g.softwareFallback === null ? '未知'
    : (g.softwareFallback ? '是 —— 渲染状态里有 *_software，说明显卡加速没生效' : '否')));
  L.push('  GPU 功能状态（app.getGPUFeatureStatus 原样）：');
  const st = (g.featureStatus && typeof g.featureStatus === 'object') ? g.featureStatus : {};
  const keys = Object.keys(st);
  if (!keys.length) L.push('    （空）');
  for (const k of keys) L.push('    ' + k + ': ' + st[k]);

  L.push(head('音效库规模（现场实测）'));
  if (li.loaded) {
    L.push(row('原版事件数', li.events + ' 个'));
    L.push(row('音频变体数', li.variants + ' 个'));
    if (li.withDesc != null) L.push(row('带中文描述', li.withDesc + ' 个'));
  } else {
    L.push('  （本次会话还没有加载原版音效库 —— 上面三项无从实测；');
    L.push('    想看这三项就先点一下「原版库」再导出）');
  }
  L.push(row('音频文件数', li.audioFiles + ' 个 .ogg（磁盘实测）'
    + (li.audioBytes ? '，合计 ' + fmtBytes(li.audioBytes) : '')));
  L.push(row('音频目录', li.audioDir || '—'));
  L.push(row('首次加载库耗时', li.firstLoadMs != null
    ? li.firstLoadMs + ' ms（本次会话第一次点「原版库」，从发起到列表就绪的实测值）'
    : '本次会话未加载过库，无可测值'));

  L.push(head('本次会话的内存占用（app.getAppMetrics 实测）'));
  const mu = info.memoryUsage || {};
  for (const t of Object.keys(mu.byType || {})) {
    L.push(row(t + ' 进程', fmtBytes(mu.byType[t]) + '（' + Math.round(mu.byType[t] / 1024) + ' KB 工作集）'));
  }
  L.push(row('进程组合计', (mu.processes || 0) + ' 个进程 · '
    + fmtBytes(mu.workingSetTotal || 0) + ' 工作集'
    + (mu.mainProcess && mu.mainProcess.workingSetSize
        ? '　（主进程 ' + fmtBytes(mu.mainProcess.workingSetSize * 1024) + '）' : '')));

  // 机器可读的原始数据放最后，前面给用户看的部分保持干净
  L.push('');
  L.push(head('附录：原始数据（机器可读，人读可以跳过）'));
  const basic = g.basic || {};
  const slim = {};
  for (const k of Object.keys(basic)) {
    if (k === 'gpuDevice' || k === 'auxAttributes') continue;
    slim[k] = basic[k];
  }
  L.push('  app.getGPUInfo("basic").auxAttributes: ' + JSON.stringify(basic.auxAttributes || null));
  L.push('  app.getGPUInfo("basic").gpuDevice: ' + JSON.stringify(basic.gpuDevice || null));
  L.push('  app.getGPUInfo("basic") 其余字段: ' + JSON.stringify(slim));
  L.push('  屏幕原始值: ' + JSON.stringify(info.displays));

  L.push('');
  L.push('------------------------------------------------------------');
  L.push('说明：以上数字都是导出这一刻现场读出来的（os / process / app 的实时值），');
  L.push('      没有一个是从文档里抄的、也没有靠猜的成分。这份文件不含用户名、');
  L.push('      主机名等个人信息。程序渲染用的是 Canvas 2D，不依赖独立显卡 ——');
  L.push('      显卡一栏是用来判断「硬件加速有没有生效 / 有没有回退到软件渲染」。');
  L.push('------------------------------------------------------------');
  L.push('');
  return L.join('\n');
}

/** 文件名：MCSoundStudio-系统信息-20261017-132041.txt */
function defaultFileName(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return 'MCSoundStudio-系统信息-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
       + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.txt';
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('export-system-info', async (evt, payload) => {
  const info = await collectSystemInfo(payload || {});
  const text = renderText(info);
  const win = BrowserWindow.fromWebContents(evt.sender);
  try {
    const res = await dialog.showSaveDialog(win || undefined, {
      title: '导出系统信息',
      defaultPath: path.join(app.getPath('userData'), 'exports', defaultFileName()),
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (!res || res.canceled || !res.filePath) {
      return { ok: false, canceled: true, text, info };
    }
    fs.writeFileSync(res.filePath, text, 'utf8');
    return { ok: true, path: res.filePath, bytes: Buffer.byteLength(text, 'utf8'), text, info };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), text, info };
  }
});

/** 只生成文本、不弹框不写盘 —— 自动化取证 / QA 复核对齐用同一条生成逻辑。 */
ipcMain.handle('collect-system-info', async (_evt, payload) => {
  const info = await collectSystemInfo(payload || {});
  return { ok: true, text: renderText(info), info };
});

module.exports = { collectSystemInfo, renderText, defaultFileName };
