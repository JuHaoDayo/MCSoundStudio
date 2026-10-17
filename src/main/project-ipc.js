/**
 * project-ipc.js —— 「工程库」相关的 IPC 注册（主进程）
 *
 * 为什么单独拆一个文件：
 *   本卡（t_fa17801d）和卡 t_7ee2bf5b（内置离线教程窗口）在同一个共享工作目录里
 *   并行改 src/main/main.js，实测发生过「整文件写入把对方刚插入的一段覆盖掉」。
 *   所以本卡只在 main.js 末尾留一行 `require('./project-ipc');`，
 *   其余全部搬到这里 —— 被覆盖的代价从「几十行」降到「一行」，收尾也更好核对。
 *
 * 依赖方向：
 *   project-ipc.js → electron（app / ipcMain / shell / dialog）
 *   project-ipc.js → ./project-library.js（**纯 Node，不含 electron**，可脱离窗口测）
 *   反过来 project-library.js 绝不 require 本文件，否则 Node 测试就跑不起来了。
 */
'use strict';

const { app, ipcMain, shell, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const projectLib = require('./project-library');

/** 工程库目录：userData/projects（一层 *.timeline.json） */
function projectsDir() {
  return path.join(app.getPath('userData'), 'projects');
}

/** 「最近打开/保存过」的索引文件 */
function recentIndexPath() {
  return path.join(app.getPath('userData'), 'recent-projects.json');
}

/**
 * 列出工程 = 工程库目录里的全部 + 最近打开过的（按路径去重）。
 * 最近记录里文件已经不在的，保留一条 missing（界面灰显 + 写明原因），
 * 不能让工程静默消失 —— 用户会以为工具把文件弄丢了。
 */
ipcMain.handle('list-projects', async () => {
  try {
    const dir = projectsDir();
    const scan = projectLib.scanProjects(dir);
    const recents = projectLib.loadRecentIndex(recentIndexPath());
    const entries = projectLib.mergeProjects(scan, recents);
    return {
      ok: true,
      projectsDir: dir,
      dirExists: !!scan.ok,
      scanReason: scan.reason || null,
      error: scan.error || null,
      recentIndexPath: recentIndexPath(),
      entries,
      skipped: scan.skipped || [],
      recentCount: recents.length,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/** 记一条「最近工程」（保存 / 打开工程时由渲染进程调用） */
ipcMain.handle('record-project', async (_evt, payload) => {
  try {
    const p = payload && payload.path;
    if (!p) return { ok: false, error: '缺少路径' };
    const list = projectLib.recordRecent(recentIndexPath(), {
      path: p,
      name: (payload && payload.name) || '',
      at: Date.now(),
    });
    return { ok: true, count: list.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/**
 * 存入工程库之前的一步：工程库里已经有同名工程吗？有就先弹一次确认（卡 t_5a1c18be 第一条）。
 *
 * 为什么必须在**事前**问：默认工程名固定是「未命名时序」，
 * 「新建 → 保存到工程库」连着来两次是新手最常见的连招 ——
 * 以前是直接覆盖，先存的那份内容就没了，而用户只看到事后一行
 * 「已更新工程库里的同名工程：<很长的路径>」，很容易当成普通的「已保存」。
 *
 * payload.currentPath（= 渲染进程的 SAVE_PATH）指向的就是撞名的那个文件时（卡 t_26c09aac 第三条），
 * 说明用户只是「改完想存回自己那份」，默认键必须放在「更新这份」：
 * 默认「另存为」会让每次保存都凭空多出一张 X (2)、X (3)… 卡片，而改动其实两份都该是同一份。
 *
 * 返回：
 *   { ok:true, conflict:false, action:'new' }                              库里没有同名 → 直接存
 *   { ok:true, conflict:true, action:'overwrite'|'rename'|'cancel', name, mine } 用户选的那一条
 *   mine=true 表示撞名的那个文件就是用户正在编辑的这份（对话框文案与默认键随之变化）
 * 渲染进程拿到 action 后再决定「用哪个名字写内容」，这样文件名、文件里的 doc.name、
 * 界面上的工程名三处才一致（改名这件事只有渲染进程能做，主进程不碰工程内容）。
 */
ipcMain.handle('resolve-library-save-name', async (_evt, payload) => {
  try {
    const name = (payload && payload.name) || '未命名时序';
    const dir = projectsDir();
    const currentPath = (payload && payload.currentPath) || '';
    const existing = projectLib.findLibraryProject(dir, name);
    const fileName = projectLib.libraryFileName(name);
    if (!existing) {
      return { ok: true, conflict: false, action: 'new', name, fileName, path: path.join(dir, fileName), altName: null, existing: null, mine: false };
    }

    // 撞名的文件 = 正在编辑的这份？（Windows 大小写不敏感，用 normKey 比）
    const mine = !!currentPath && projectLib.normKey(currentPath) === projectLib.normKey(existing.path);
    const altName = projectLib.nextFreeProjectName(dir, name);
    const altFileName = projectLib.libraryFileName(altName);
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const res = await dialog.showMessageBox(win || undefined, mine ? {
      type: 'question',
      title: '更新你正在编辑的这份工程',
      message: `这是你正在编辑的那份工程：「${name}」`,
      detail: '文件：\n' + existing.path + '\n\n'
        + '「覆盖（更新这份）」= 把当前内容写回这个文件（原来那份的内容被替换，不能撤销）\n'
        + `「另存为新名字」= 这份内容改名成「${altName}」另存一份，原来那个文件保持不动\n`
        + '「取消」= 什么都不做，这次不保存',
      buttons: ['覆盖（更新这份）', `另存为新名字（${altName}）`, '取消'],
      defaultId: 0,        // 默认「更新这份」：用户改完再存 = 就是想存回自己那份
      cancelId: 2,
      noLink: true,
    } : {
      type: 'warning',
      title: '工程库里已有同名工程',
      message: `工程库里已有同名工程「${name}」`,
      detail: '已存在的文件：\n' + existing.path + '\n\n'
        + '「覆盖」= 用当前工程替换它（那一份的内容就没了，不能撤销）\n'
        + `「另存为新名字」= 原来那份留着，当前工程改名为「${altName}」再存\n`
        + '「取消」= 什么都不做，这次不保存',
      buttons: ['覆盖', `另存为新名字（${altName}）`, '取消'],
      defaultId: 1,        // 默认停在「另存为新名字」：回车不会把别人的工程顶掉
      cancelId: 2,
      noLink: true,
    });
    const response = res && res.response;
    if (response === 0) {
      return { ok: true, conflict: true, action: 'overwrite', name, fileName, path: existing.path, altName, existing, mine };
    }
    if (response === 1) {
      return { ok: true, conflict: true, action: 'rename', name: altName, fileName: altFileName, path: path.join(dir, altFileName), altName, existing, mine };
    }
    return { ok: true, conflict: true, action: 'cancel', name, fileName, path: existing.path, altName, existing, mine };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/**
 * 把当前工程存进工程库。
 * 同名覆盖要如实返回 overwrote=true —— 界面会写明「已覆盖同名工程」，
 * 不能让用户以为新存了一份而旧的还在。
 * payload.expectNew=true 表示调用方已经问过用户、并拿到了一个算好的空名字：
 * 这时候再撞上同名（另一份刚好写进来）就如实报错，绝不静默覆盖。
 */
ipcMain.handle('save-project-to-library', async (_evt, payload) => {
  try {
    const name = (payload && payload.name) || '未命名时序';
    const content = (payload && payload.content) == null ? '' : String(payload.content);
    const dir = projectsDir();
    fs.mkdirSync(dir, { recursive: true });
    const fileName = projectLib.safeFileName(name) + '.timeline.json';
    const full = path.join(dir, fileName);
    const overwrote = fs.existsSync(full);
    if (overwrote && payload && payload.expectNew) {
      return {
        ok: false, conflict: true, path: full, dir, fileName,
        error: `工程库里已经有「${fileName}」了（刚有同名工程写进来）`,
      };
    }
    fs.writeFileSync(full, content, 'utf8');
    projectLib.recordRecent(recentIndexPath(), { path: full, name, at: Date.now() });
    return { ok: true, path: full, dir, fileName, name, overwrote, sizeBytes: Buffer.byteLength(content, 'utf8') };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/** 在文件管理器里打开工程库目录 */
ipcMain.handle('open-projects-folder', async () => {
  const dir = projectsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) return { ok: false, error: err, dir };
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: e.message, dir };
  }
});

/**
 * 让用户从磁盘挑一个工程文件（工程总览里的「打开工程文件…」）。
 * 复用 pick-files + 读取，但把「不是工程」的判断放在这里，
 * 这样总览和顶栏「打开」走的是同一套诊断文案。
 */
ipcMain.handle('pick-project-file', async () => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const res = await require('electron').dialog.showOpenDialog(win || undefined, {
    properties: ['openFile'],
    title: '打开工程（timeline.json）',
    filters: [
      { name: 'MCSoundStudio 工程', extensions: ['json'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const p = res.filePaths[0];
  const read = projectLib.readProjectFile(p);
  if (!read.ok) return { ok: false, path: p, error: read.error };
  let content;
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, path: p, error: '读取失败：' + e.message };
  }
  return { ok: true, path: p, content, meta: read.meta };
});

module.exports = { projectsDir, recentIndexPath };
