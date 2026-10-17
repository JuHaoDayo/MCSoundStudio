const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcs', {
  scanSoundDir: (dir) => ipcRenderer.invoke('scan-sound-dir', dir),
  readTextFile: (p) => ipcRenderer.invoke('read-text-file', p),
  readBinaryFile: (p) => ipcRenderer.invoke('read-binary-file', p),
  readRawBytes: (p) => ipcRenderer.invoke('read-raw-bytes', p),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  pickFiles: (opts) => ipcRenderer.invoke('pick-files', opts),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  saveMany: (opts) => ipcRenderer.invoke('save-many', opts),
  saveManyToDir: (opts) => ipcRenderer.invoke('save-many-to-dir', opts),
  setTitle: (title) => ipcRenderer.invoke('set-title', title),
  getBundledSoundsDir: () => ipcRenderer.invoke('get-bundled-sounds-dir'),
  openAudioFolder: () => ipcRenderer.invoke('open-audio-folder'),
  setDirty: (d) => ipcRenderer.invoke('set-dirty', d),
  confirmUnsavedChanges: () => ipcRenderer.invoke('confirm-unsaved-changes'),
  onRequestSave: (cb) => ipcRenderer.on('request-save', () => cb()),
  // 输入法组字期间 Ctrl+S 由主进程转发（渲染进程 keydown 看不到那个 's'）
  onSaveShortcut: (cb) => ipcRenderer.on('save-shortcut', (_e, payload) => cb(payload)),
  loadVanillaLibrary: () => ipcRenderer.invoke('load-vanilla-library'),
  loadVanillaDescriptions: () => ipcRenderer.invoke('load-vanilla-descriptions'),
  // 工程库 / 工程总览（卡 t_fa17801d）
  //   实现见 src/main/project-ipc.js + src/main/project-library.js
  listProjects: () => ipcRenderer.invoke('list-projects'),
  pickProjectFile: () => ipcRenderer.invoke('pick-project-file'),
  recordProject: (payload) => ipcRenderer.invoke('record-project', payload),
  // 存入工程库前先问一次「是不是要覆盖同名工程」（卡 t_5a1c18be）
  resolveLibrarySaveName: (payload) => ipcRenderer.invoke('resolve-library-save-name', payload),
  saveProjectToLibrary: (payload) => ipcRenderer.invoke('save-project-to-library', payload),
  openProjectsFolder: () => ipcRenderer.invoke('open-projects-folder'),
  // 内置离线使用教程窗口（src/renderer/help.html）+ 作者外链（走系统默认浏览器）
  // 实现见 src/main/help.js（卡 t_7ee2bf5b）
  openHelp: () => ipcRenderer.invoke('open-help'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // 导出系统信息（卡 t_20c2e144）：系统 / 显卡 / 屏幕 / 库规模 + 首次加载耗时 → 用户选的 txt。
  // 实现见 src/main/sysinfo.js。payload 只带「只有渲染进程知道」的部分（库规模与耗时）。
  exportSystemInfo: (payload) => ipcRenderer.invoke('export-system-info', payload),
  // 同一条生成逻辑，但不弹框、不写盘 —— 自动化取证与 QA 复核对齐用。
  collectSystemInfo: (payload) => ipcRenderer.invoke('collect-system-info', payload),
});
