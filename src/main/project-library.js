/**
 * project-library.js —— 工程库（.timeline.json）扫描与元数据提取
 *
 * 为什么单独一个文件、而且**不 require electron**：
 *   「工程总览」要列出的东西（工程名 / 总长 / 片段数 / 轨道数 / 视觉参考 / 缩略条）
 *   全部来自磁盘上的 timeline.json 本身，不需要窗口。
 *   把这部分留在主进程的纯 Node 里，就能用 `node scripts/project-library-test.js`
 *   真跑一遍（写真实工程文件 → 扫描 → 逐字段比对），不必为了验一个
 *   「列目录 + 读 json」去启动 Electron 窗口。
 *
 * 边界：本文件只用 node 的 fs / path，不许出现 electron / DOM。
 *   scripts/run-core-regression.js 的非窗口清单会跑它的测试脚本。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RECENT_LIMIT = 20;                 // 最近工程最多记这么多条
const PROJECT_FILE_RE = /\.timeline\.json$/i;

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

/** Windows 上大小写不敏感，去重/比较前统一规范化 */
function normKey(p) {
  const abs = path.resolve(String(p || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** 工程名 → 安全的文件名（不覆盖别人的路径分隔符/非法字符） */
function safeFileName(name) {
  const s = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return s || '未命名时序';
}

/** 工程名 → 工程库里的文件名（存/取都必须走这一个函数，不然会算出两个文件） */
function libraryFileName(name) {
  return safeFileName(name) + '.timeline.json';
}

/**
 * 工程库里这个名字对应的文件在不在？在就返回 { path, fileName, sizeBytes, mtimeMs }，否则 null。
 * 用来回答「保存当前到工程库之前要不要先问一句同名覆盖」（卡 t_5a1c18be 第一条）。
 */
function findLibraryProject(dir, name) {
  const d = path.resolve(String(dir || ''));
  const fileName = libraryFileName(name);
  const full = path.join(d, fileName);
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return null;          // 恰好有个同名目录 → 不算工程
    return { path: full, fileName, sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } catch (e) {
    return null;                            // 不存在 / 读不到都当「没有」
  }
}

/**
 * 撞名时给一个能用的新名字：`X (2)`、`X (3)`…
 * （括号和空格 safeFileName 都保留，所以生成的还是合法文件名；
 *   默认工程名固定，「新建 → 存」连来两次必然走到这里。）
 *
 * 名字**已经带 ` (n)` 后缀**时接着往后顺延（卡 t_26c09aac 第三条）：
 * `X (2)` → `X (3)`，而不是在整串名字上再套一层 ——
 * 套娃出来的「`X (2) (2)`」在卡片上读不出和 (2) 的区别，等于把用户搞糊涂。
 */
function nextFreeProjectName(dir, name) {
  const d = path.resolve(String(dir || ''));
  const base = safeFileName(name);
  const m = /^(.*?)\s*\((\d+)\)$/.exec(base);     // 末尾是 (n) 的话，看它原本叫什么
  const stem = (m && m[1]) ? m[1] : base;
  const from = m ? Math.max(Number(m[2]) + 1, 2) : 2;
  for (let i = from; i < from + 1000; i++) {
    const candidate = stem + ' (' + i + ')';
    if (!findLibraryProject(d, candidate)) return candidate;
  }
  return stem + ' (' + Date.now() + ')';   // 1000 个同名工程都占满了：极罕见，兜底不撞名
}

// ---------------------------------------------------------------------------
// 元数据提取
// ---------------------------------------------------------------------------

/**
 * 一份 timeline.json 的内容 → 总览要展示的元数据（纯函数，喂给测试）。
 * 返回 { ok:true, meta } 或 { ok:false, error }（error 是给人看的中文）。
 */
function describeDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: '内容不是一个 JSON 对象' };
  }
  if (!Array.isArray(doc.clips) || !doc.config || typeof doc.config !== 'object') {
    return { ok: false, error: '缺少 clips / config 字段，不是 MCSoundStudio 的 timeline.json' };
  }

  const tracks = Array.isArray(doc.tracks) ? doc.tracks : [];
  const visual = doc.visual || {};

  // 手改过 / 第三方生成的工程里，clips[] 可能夹着非对象条目（null / 数字 —— 写出被截断时
  // 很常见）。以前这里直接读 c.startMs，抛出去会**整张工程总览打空**（一个坏文件把
  // 所有工程都藏了，比单个工程打不开更糟）。按「一条空片段」算：和编辑器导入后的
  // 片段数保持一致（那边会把它补成一条默认片段，而不是丢掉）。
  const clips = doc.clips.map((c) => ((c && typeof c === 'object') ? c : {}));

  // 片段实际占用的时间范围（缩略条要按这个画，不然全靠 config.totalMs 会画歪）
  let firstMs = Infinity;
  let lastMs = 0;
  let usedTracks = 0;
  const trackUse = {};
  for (const c of clips) {
    const start = Number(c.startMs) || 0;
    const dur = Number(c.durationMs) || 0;
    // 片段末端 = 起点 + 条长。（「循环播放」已在卡 t_6b5016ec 里整体移除：
    // 老工程里夹带的 loop / loopEndMs 不再参与缩略条宽度计算，按普通片段算。）
    const end = start + dur;
    if (start < firstMs) firstMs = start;
    if (end > lastMs) lastMs = end;
    const t = String(c.track || '');
    trackUse[t] = (trackUse[t] || 0) + 1;
  }
  usedTracks = Object.keys(trackUse).length;

  const clipKinds = { event: 0, file: 0 };
  for (const c of clips) {
    if (c.kind === 'event') clipKinds.event++;
    else clipKinds.file++;
  }

  const totalMs = Math.max(0, Number(doc.config.totalMs) || 0);

  return {
    ok: true,
    meta: {
      name: String(doc.name || '').trim() || '未命名时序',
      version: doc.version || 1,
      totalMs,
      // 缩略条：按**实际片段占位**算宽度，空工程也要能看出「是空的」
      contentEndMs: clips.length ? Math.round(lastMs) : 0,
      firstClipMs: clips.length ? Math.round(firstMs) : null,
      clipCount: clips.length,
      trackCount: tracks.length,
      usedTrackCount: usedTracks,
      clipKinds,
      bpm: Number(doc.config.bpm) || 0,
      gridMs: Number(doc.config.gridMs) || 50,
      gridMode: doc.config.gridMode || 'ms',
      visualKind: visual.kind || 'none',
      visualPath: visual.path || visual.animFile || null,
      animName: visual.animName || null,
      naturalMs: visual.naturalMs != null ? Number(visual.naturalMs) : null,
      // 缩略条数据（渲染端只负责画，不再重新解析工程）
      bars: clips.map((c) => ({
        track: String(c.track || ''),
        startMs: Number(c.startMs) || 0,
        durationMs: Math.max(0, Number(c.durationMs) || 0),
        kind: c.kind === 'event' ? 'event' : 'file',
      })),
      trackNames: tracks.map((t) => String(t.name || '')),
    },
  };
}

/**
 * 读一个工程文件 → { ok, meta, path, fileName, sizeBytes, mtimeMs } / { ok:false, error }
 * 文件不存在 / 不是 JSON / 不是工程，都返回能直接显示给用户的 error。
 */
function readProjectFile(filePath) {
  const p = path.resolve(String(filePath || ''));
  const fileName = path.basename(p);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch (e) {
    return { ok: false, path: p, fileName, error: '文件不存在或读不到：' + p };
  }
  if (!stat.isFile()) return { ok: false, path: p, fileName, error: '不是一个文件：' + p };

  const base = { path: p, fileName, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };

  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return Object.assign({}, base, { ok: false, error: '读取失败：' + e.message });
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return Object.assign({}, base, { ok: false, error: '不是合法的 JSON：' + e.message });
  }
  let d;
  try {
    d = describeDoc(doc);
  } catch (e) {
    // describeDoc 的约定是「永远返回 ok/error，不抛」（见它的注释）。真抛了也不能让
    // 一个坏文件把整张工程总览打空 —— 如实点名这个文件、其余工程照常列出。
    return Object.assign({}, base, { ok: false, error: '这个文件读不出工程信息：' + (e && e.message ? e.message : String(e)) });
  }
  if (!d.ok) return Object.assign({}, base, { ok: false, error: d.error });
  return Object.assign({}, base, { ok: true, meta: d.meta });
}

// ---------------------------------------------------------------------------
// 工程库目录扫描
// ---------------------------------------------------------------------------

/**
 * 扫描工程库目录（不递归：工程都在一层）。
 * 返回 { ok, dir, entries:[…按修改时间倒序], skipped:[{file, error}] }
 */
/** Node 的原始英文错误 → 给非开发者看的中文说明（原始信息附在后面，方便排查） */
function explainScanError(e, dir) {
  const code = (e && e.code) || '';
  const raw = (e && e.message) ? e.message : String(e || '');
  const head = {
    ENOTDIR: '这个路径被一个同名文件占住了，程序建不了工程库目录',
    EACCES: '没有权限读这个目录',
    EPERM: '系统不允许读这个目录',
    EBUSY: '这个目录正被别的程序占用',
  }[code];
  if (!head) return `读不到工程库目录：${raw}`;
  return `${head}（${dir}）。原始信息：${raw}`;
}

function scanProjects(dir) {
  const d = path.resolve(String(dir || ''));
  let names;
  try {
    names = fs.readdirSync(d);
  } catch (e) {
    // 第一次使用时目录不存在是正常情况；路径被同名文件占住、权限不足等则必须如实交给界面。
    const missing = e && e.code === 'ENOENT';
    return {
      ok: false,
      dir: d,
      reason: missing ? 'missing-dir' : 'unreadable-dir',
      error: missing ? '' : explainScanError(e, d),
      entries: [],
      skipped: [],
    };
  }
  const entries = [];
  const skipped = [];
  for (const n of names) {
    if (!PROJECT_FILE_RE.test(n)) continue;
    const r = readProjectFile(path.join(d, n));
    if (r.ok) entries.push(r);
    else skipped.push({ file: n, error: r.error });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { ok: true, dir: d, entries, skipped };
}

// ---------------------------------------------------------------------------
// 最近工程索引（userData/recent-projects.json）
// ---------------------------------------------------------------------------

function loadRecentIndex(indexPath) {
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const doc = JSON.parse(raw);
    const list = Array.isArray(doc) ? doc : (doc && doc.entries) || [];
    return list
      .filter((e) => e && e.path)
      .map((e) => ({ path: String(e.path), name: e.name ? String(e.name) : '', at: Number(e.at) || 0 }));
  } catch (e) {
    return [];   // 索引坏了就当没有：这只是便利功能，不能拦住工程库
  }
}

/** 记一条最近工程（去重 → 置顶 → 截断），返回新列表；写盘失败不抛异常 */
function recordRecent(indexPath, entry) {
  const list = loadRecentIndex(indexPath).filter((e) => normKey(e.path) !== normKey(entry.path));
  list.unshift({ path: String(entry.path), name: entry.name ? String(entry.name) : '', at: Number(entry.at) || Date.now() });
  const cut = list.slice(0, RECENT_LIMIT);
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify({ version: 1, entries: cut }, null, 2), 'utf8');
  } catch (e) { /* 忽略写失败 */ }
  return cut;
}

/**
 * 合并「工程库目录里的工程」+「最近打开过的工程」。
 *   - 同一个文件只出现一次：优先用工程库那份（inLibrary=true）
 *   - 最近记录里的文件被删/被移走 → 保留一条 missing 记录，界面上灰着显示原因，
 *     而不是让它静默消失（用户会以为工具把工程弄丢了）
 */
function mergeProjects(libraryScan, recents) {
  const byKey = new Map();
  const out = [];

  for (const e of (libraryScan && libraryScan.entries) || []) {
    const item = {
      path: e.path,
      fileName: e.fileName,
      sizeBytes: e.sizeBytes,
      mtimeMs: e.mtimeMs,
      inLibrary: true,
      inRecents: false,
      missing: false,
      meta: e.meta,
      error: null,
    };
    byKey.set(normKey(e.path), item);
    out.push(item);
  }

  for (const r of recents || []) {
    const key = normKey(r.path);
    const exists = byKey.get(key);
    if (exists) {
      exists.inRecents = true;
      if (r.name) exists.recentName = r.name;
      if (r.at > (exists.recentAt || 0)) exists.recentAt = r.at;
      continue;
    }
    const read = readProjectFile(r.path);
    const item = read.ok
      ? {
        path: read.path, fileName: read.fileName, sizeBytes: read.sizeBytes, mtimeMs: read.mtimeMs,
        inLibrary: false, inRecents: true, recentName: r.name || '', recentAt: r.at || 0,
        missing: false, meta: read.meta, error: null,
      }
      : {
        path: r.path, fileName: path.basename(r.path), sizeBytes: 0, mtimeMs: 0,
        inLibrary: false, inRecents: true, recentName: r.name || '', recentAt: r.at || 0,
        missing: true, meta: null, error: read.error,
      };
    byKey.set(key, item);
    out.push(item);
  }

  // 排序：工程库在前，各自按「修改时间 / 最近打开」倒序
  out.sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    const ta = a.inLibrary ? a.mtimeMs : (a.recentAt || a.mtimeMs);
    const tb = b.inLibrary ? b.mtimeMs : (b.recentAt || b.mtimeMs);
    return tb - ta;
  });
  return out;
}

module.exports = {
  RECENT_LIMIT,
  PROJECT_FILE_RE,
  normKey,
  safeFileName,
  libraryFileName,
  findLibraryProject,
  nextFreeProjectName,
  describeDoc,
  readProjectFile,
  scanProjects,
  loadRecentIndex,
  recordRecent,
  mergeProjects,
};
