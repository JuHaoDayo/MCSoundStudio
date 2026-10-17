/**
 * Help：内置离线教程窗口 + 作者外链（卡 t_7ee2bf5b）
 *
 * 「Help 不得为空」的落地方式：顶部「? Help」打开的是一份**真正的 HTML 文档** ——
 * src/renderer/help.html。它零外部资源（样式全内联），所以：
 *   · 程序里断网也能正常排版打开；
 *   · 同一个文件直接双击、用浏览器打开也照样看（交付/给同事传阅都行）；
 *   · 打包后它在 app.asar 里，BrowserWindow.loadFile 照样读得到（已用 portable exe 实测）。
 *
 * 「作者」按钮走 shell.openExternal —— 用系统默认浏览器打开，不在程序里内嵌网页；
 * 教程页里任何开新窗口 / 跳外链的请求也会被拦下来交给系统浏览器（见下面的
 * setWindowOpenHandler / will-navigate），否则 Electron 的默认行为是在自己内部再开一个窗口。
 *
 * 为什么是**独立文件 + 自注册**，而不是写进 src/main/main.js：
 *   卡 t_fa17801d（工程总览 / 工程导入）当时正在改 main.js，两块改动落在同一文件里会互相覆盖。
 *   做成模块后 main.js 只需要末尾一行 `require('./help');`。
 */
const { ipcMain, BrowserWindow, shell } = require('electron');
const path = require('path');

/** 内置教程页（开发时在工程里；打包后在 app.asar 内，loadFile 支持 asar 路径） */
const HELP_PAGE = path.join(__dirname, '..', 'renderer', 'help.html');

/** 作者主页（与 help.html 里的 AUTHOR_URL 保持一致，改的时候两边一起改） */
const AUTHOR_URL = 'https://space.bilibili.com/50955238';

let helpWindow = null;

/**
 * 只放行 http/https。
 * 渲染进程 / 教程页理论上能把任意字符串传进来，不能让它变成
 * 「用系统默认程序打开任意文件 / 任意协议」的入口。
 */
function isAllowedExternal(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (e) {
    return false;
  }
}

/** 用系统默认浏览器打开外部链接，返回真实结果（教程页会把它显示出来，也是自动化的取证点）。 */
async function openExternal(url) {
  const target = String(url || '');
  if (!isAllowedExternal(target)) {
    return { ok: false, error: '只支持 http/https 链接：' + target, url: target };
  }
  try {
    await shell.openExternal(target);
    return { ok: true, url: target };
  } catch (e) {
    return { ok: false, error: e.message, url: target };
  }
}

/** 打开使用教程窗口；已经开着就聚焦它（不叠一堆窗口）。 */
function openHelpWindow() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.focus();
    return { ok: true, reused: true, file: HELP_PAGE };
  }
  helpWindow = new BrowserWindow({
    width: 1000,
    height: 880,
    minWidth: 640,
    minHeight: 460,
    backgroundColor: '#14161a',
    title: 'MCSoundStudio 使用教程',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  helpWindow.setMenuBarVisibility(false);

  helpWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  helpWindow.webContents.on('will-navigate', (e, url) => {
    const strip = (s) => String(s).split('#')[0];
    // 页内锚点（目录跳转）不是导航，放行
    if (strip(url) === strip(helpWindow.webContents.getURL())) return;
    e.preventDefault();
    openExternal(url);
  });

  helpWindow.loadFile(HELP_PAGE);
  helpWindow.on('closed', () => { helpWindow = null; });
  return { ok: true, reused: false, file: HELP_PAGE };
}

ipcMain.handle('open-help', () => {
  try {
    return openHelpWindow();
  } catch (e) {
    // 打不开窗口时渲染进程会退回内置弹窗（Help 不会变空）
    return { ok: false, error: e.message, file: HELP_PAGE };
  }
});

ipcMain.handle('open-external', (_evt, url) => openExternal(url));

module.exports = { HELP_PAGE, AUTHOR_URL, openHelpWindow, openExternal };
