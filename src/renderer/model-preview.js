/**
 * model-preview.js — 「模型/动画显示在预览画布上」的接线层（卡 t_fa17801d）
 *
 * 数学与绘制在 model-view.js（纯函数 + canvas），本文件负责：
 *   1. 把导入的 .bbmodel 文本变成场景，并把贴图读进来（相对路径按模型目录解析）
 *   2. 把导入的 .animation.json 变成可采样的轨道，选中一条动画
 *   3. 按播放头时刻把姿态画到 **预览画布**（#previewCanvas）上，并在播放时自己驱动
 *   4. 给出元信息文案与调试快照（自动化验收靠它，不靠肉眼看截图）
 *
 * 为什么单独一个文件：app.js 目前多张卡并行在改，改动面越小越不容易互相踩。
 * app.js 只需在 boot 时 init(host) 一次，然后在「导入/同步」几个点上调用它。
 */
'use strict';

(function () {

const MV = () => window.MCS_MODELVIEW;
const P = () => window.MCS_PARSERS;

let host = null;          // { canvas, state, readBinaryFile, status, openModal, assetIssue, revalidate, renderTimeline, setMetaText, applyStage }
let driver = null;        // rAF 句柄
let loadToken = 0;        // 贴图异步加载的取消令牌

const S = {
  scene: null,
  textures: {},           // textureIndex → Image
  textureReport: null,    // { total, loaded, missing:[{name, path, reason}] }
  tracks: null,           // 当前动画的可采样轨道（parsers.extractAnimationTracks 的一条）
  animName: null,
  anims: [],              // 文件里全部动画（名字/时长）
  // 动画目录（卡 t_96cd9241）：两档列表与画布读的是**同一份**「能播的动画」清单，
  // 来源两类 —— 导入的 .animation.json（source='file'）与模型 .bbmodel 自带动画
  // （source='model'）。每条都带 bones（可采样轨道）、expressions（未求值的表达式清单）
  // 与 stats（关键帧数 / 表达式的处数）。列表按名字选中，画布就播那一条。
  catalog: [],
  selectedKey: null,      // `${source}:${name}`；null = 不播任何动画（画布回静止姿态）
  modelPath: null,
  animPath: null,
  animSource: null,       // 'file' | 'model' | null
  lastMs: null,
  lastStats: null,        // 最近一次渲染的画布指纹（验收用）
  lastView: null,         // 最近一次渲染用的视角（角度/缩放/位移，验收用）
  draws: 0,
};

function init(h) {
  host = h;
  return api;
}

// ---------------------------------------------------------------------------
// 画布尺寸：模型预览跟着预览区大小走（GIF 模式仍然是 GIF 自己的像素尺寸）
// ---------------------------------------------------------------------------
function stageBox() {
  const el = host && host.stageEl && host.stageEl();
  const w = Math.max(120, Math.round((el && el.clientWidth ? el.clientWidth : 480) - 8));
  const h = Math.max(80, Math.round((el && el.clientHeight ? el.clientHeight : 240) - 8));
  return { width: w, height: h };
}

function numOr(x, def) {
  return (typeof x === 'number' && Number.isFinite(x)) ? x : def;
}

/**
 * 定出这次渲染用的视角。
 * 顺序：opts（自动化测试临时覆盖）→ host.view()（app.js 从 STATE.doc.visual 校验出来的唯一真相）
 *      → DEFAULT_VIEW（老工程缺字段时 = 改动前的观感，逐像素一致）。
 * 注意映射：工程字段 angle.x 是俯仰（pitch）、angle.y 是左右（yaw）、angle.z 是画面内滚转（roll）。
 */
function resolveView(o) {
  const dv = MV().DEFAULT_VIEW;
  const fromHost = (host && host.view) ? (host.view() || {}) : {};
  const pick = (key) => (o[key] != null ? o[key] : fromHost[key]);
  return {
    yaw: numOr(pick('yaw'), dv.yaw),
    pitch: numOr(pick('pitch'), dv.pitch),
    roll: numOr(pick('roll'), 0),
    zoom: numOr(pick('zoom'), 1),
    panX: numOr(pick('panX'), 0),
    panY: numOr(pick('panY'), 0),
  };
}

/** 渲染到预览画布；ms 省略时用当前播放头 */
function render(ms, opts) {
  const o = opts || {};
  const canvas = host && host.canvasEl ? host.canvasEl() : null;
  if (!canvas || !S.scene) return null;
  const st = host.state();
  const at = ms == null ? (st.playheadMs || 0) : ms;
  const box = stageBox();

  // 尺寸：模型模式由我们接管（GIF 模式不要碰，那是 GIF 的像素尺寸）
  canvas.style.width = box.width + 'px';
  canvas.style.height = box.height + 'px';

  // 视角（卡 t_c54d031b）：角度 / 缩放 / 位移只有一份真相（STATE.doc.visual），
  // 由 app.js 校验后经 host.view() 递进来。调整页与音效页都读它 —— 两个页面各存一份
  // 必然对不上，那正是本卡要消灭的现象。opts 里的同名字段只给自动化测试做临时覆盖。
  const v = resolveView(o);
  const pose = S.tracks ? P().sampleAnimationPose(S.tracks, at) : null;
  const proj = MV().renderToCanvas(canvas, S.scene, pose, {
    width: box.width,
    height: box.height,
    dpr: window.devicePixelRatio || 1,
    textures: S.textures,
    background: '#101216',
    yaw: v.yaw,
    pitch: v.pitch,
    roll: v.roll,
    zoom: v.zoom,
    pan: { x: v.panX, y: v.panY },
  });

  S.lastMs = at;
  S.lastView = v;
  S.draws++;
  if (o.measure) {
    S.lastStats = Object.assign(MV().canvasStats(canvas), {
      visibleFaces: proj.visibleFaces,
      culledFaces: proj.culledFaces,
      posed: !!pose,
      atMs: Math.round(at),
    });
  }
  if (host.setMetaText) host.setMetaText(metaText(at));
  return { proj, pose, stats: S.lastStats };
}

/** 预览区那行元信息 */
function metaText(ms) {
  if (!S.scene) return '视觉：无';
  const st = host.state();
  const at = ms == null ? (st.playheadMs || 0) : ms;
  const sc = S.scene;
  const texTotal = S.textureReport ? S.textureReport.total : sc.textureRefs.length;
  const texOk = S.textureReport ? S.textureReport.loaded : 0;
  let t = `视觉：模型「${sc.name || '(无名)'}」(${sc.stats.cubeCount} 立方体 / ${sc.stats.boneCount} 骨骼`;
  t += texTotal ? `, 贴图 ${texOk}/${texTotal}` : ', 无贴图';
  t += ')';
  if (S.tracks) {
    const len = S.tracks.lengthMs || 0;
    const done = len > 0 && at >= len - 1;
    t += ` · 动画 ${S.animName} (${(len / 1000).toFixed(2)}s)`;
    t += done ? ' · 已放完，停在末帧姿态' : ` · ${(at / 1000).toFixed(2)}s`;
  } else if (S.anims.length) {
    t += ` · 文件里有 ${S.anims.length} 条动画，选中：${S.animName || '(无)'}`;
  }
  return t;
}

/** 画布快照（自动化验收 + 人工排查都用这个，别去猜像素） */
function snapshot() {
  const canvas = host && host.canvasEl ? host.canvasEl() : null;
  const st = host ? host.state() : { visualMode: 'none' };
  return {
    mode: st.visualMode,
    hasScene: !!S.scene,
    modelPath: S.modelPath,
    cubeCount: S.scene ? S.scene.stats.cubeCount : 0,
    boneCount: S.scene ? S.scene.stats.boneCount : 0,
    faceCount: S.scene ? S.scene.stats.faceCount : 0,
    texturedFaces: S.scene ? S.scene.stats.texturedFaces : 0,
    textures: S.textureReport,
    animPath: S.animPath,
    animName: S.animName,
    animSource: S.animSource,
    animCount: S.anims.length,
    animLengthMs: S.tracks ? S.tracks.lengthMs : 0,
    posedBones: S.tracks ? Object.keys(S.tracks.bones) : [],
    // 动画目录（两档列表的数据源）：验收直接读它，不靠数 DOM
    catalog: S.catalog.map(catalogRow),
    catalogCount: S.catalog.length,
    selectedKey: S.selectedKey,
    lastMs: S.lastMs,
    view: S.lastView,          // 最近一次渲染实际用的角度/缩放/位移（调整页与音效页必须一致）
    draws: S.draws,
    canvasVisible: !!(canvas && canvas.style.display !== 'none'),
    canvas: canvas ? { width: canvas.width, height: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight } : null,
    stats: S.lastStats,
    metaText: canvas ? null : null,
  };
}

// ---------------------------------------------------------------------------
// 动画目录（卡 t_96cd9241）
//
// 为什么要有目录这一层：以前 loadAnimationText() 只把「最长的那条」塞进 S.tracks，
// 模型自带动画更是连轨道都没有 —— 于是界面上想列两条都无从列起。现在所有来源都
// 登记成同一种条目，两档列表、画布采样、metaText 读的都是它。
// ---------------------------------------------------------------------------
function entryKey(e) { return e.source + ':' + e.name; }

/** 列表/验收用的一行摘要（不含轨道本体，避免快照过大） */
function catalogRow(e) {
  const st = e.stats || {};
  return {
    key: entryKey(e),
    name: e.name,
    source: e.source,
    file: e.file || null,
    lengthMs: e.lengthMs || 0,
    loop: e.loop === undefined ? null : e.loop,
    boneCount: Object.keys(e.bones || {}).length,
    keyCount: st.keyCount || 0,
    timeCount: st.timeCount || 0,
    exprCount: st.exprCount || 0,
    otherCount: st.otherCount || 0,
    expressions: (e.expressions || []).map((x) => ({
      bone: x.bone, channel: x.channel, t: x.t, raw: x.raw, axes: x.axes,
      kept: x.kept, isExpr: x.isExpr, kind: x.kind,
      note: P().expressionNote ? P().expressionNote(x) : '',
    })),
  };
}

/**
 * 登记某一来源的全部动画（替换该来源的旧条目，另一来源原样保留）。
 * @param source 'file'（导入的 .animation.json）| 'model'（.bbmodel 自带动画）
 * @param list   parsers.extractAnimationTracks / extractBBModelAnimationTracks 的 animations
 * @param sourcePath 该来源的文件路径（列表里要显示「来源：xxx.json / 模型内置」）
 */
function setCatalogSource(source, list, sourcePath) {
  S.catalog = S.catalog.filter((e) => e.source !== source);
  for (const a of (list || [])) {
    S.catalog.push({
      name: a.name,
      source: source,
      file: source === 'file' ? (sourcePath || null) : null,
      modelPath: source === 'model' ? (sourcePath || null) : null,
      lengthMs: a.lengthMs || 0,
      loop: a.loop === undefined ? null : a.loop,
      bones: a.bones || {},
      expressions: a.expressions || [],
      stats: a.stats || P().animationStats(a),
    });
  }
  // 按时长降序：列表第一行 = 最长那条（沿用「默认选最长」的老行为）
  S.catalog.sort((a, b) => (b.lengthMs - a.lengthMs) || a.name.localeCompare(b.name));
  if (S.selectedKey && !S.catalog.some((e) => entryKey(e) === S.selectedKey)) clearSelection();
  return S.catalog;
}

/** 取消选中：画布回模型的静止姿态（不是「悄悄留着上一个动画的样子」） */
function clearSelection() {
  S.selectedKey = null;
  S.tracks = null;
  S.animName = null;
  S.animPath = null;
  S.animSource = null;
}

/** 选中一条（传 null = 不播） */
function select(entry) {
  if (!entry) { clearSelection(); return null; }
  S.selectedKey = entryKey(entry);
  // S.tracks 存**整条目录项**（含 bones / lengthMs / expressions / stats），不是它的 bones 映射：
  // 采样 sampleAnimationPose(S.tracks) 要 .bones，元信息与快照要 .lengthMs / .bones
  //（卡 t_96cd9241 拆分目录层时这里曾错写成 entry.bones，界面一选中就抛
  //  「Cannot convert undefined or null to object」—— 自验探针逮到的）
  S.tracks = entry;
  S.animName = entry.name;
  S.animPath = entry.file || null;
  S.animSource = entry.source;
  return entry;
}

/** 按名字（可带文件路径）在目录里找一条 */
function find(name, file) {
  if (!name) return null;
  if (file != null) {
    const exact = S.catalog.find((e) => e.name === name && (e.file === file || e.modelPath === file));
    if (exact) return exact;
  }
  return S.catalog.find((e) => e.name === name) || null;
}

/** 当前选中的条目（null = 没有） */
function selectedEntry() {
  return S.selectedKey ? (S.catalog.find((e) => entryKey(e) === S.selectedKey) || null) : null;
}

/** 把最后一次渲染的像素指纹也带上（回归用：两个时刻必须不同） */
function fingerprint() {
  const canvas = host && host.canvasEl ? host.canvasEl() : null;
  if (!canvas) return null;
  return MV().canvasStats(canvas);
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/**
 * 模型文本 → 场景 + 贴图。返回给弹窗用的报告行。
 * @returns { ok, report:[字符串], issues:[{level,message}] }
 */
async function loadModelText(text, filePath) {
  const bbInfo = P().parseBBModel(text);          // 调用方负责诊断：解析失败会抛
  const scene = MV().buildScene(bbInfo);
  const token = ++loadToken;

  S.scene = scene;
  S.modelPath = filePath;
  S.textures = {};
  S.textureReport = { total: scene.textureRefs.length, loaded: 0, missing: [] };
  S.lastStats = null;

  // 模型自带的 animations 也登记进动画目录（卡 t_96cd9241）：以前只在弹窗里报一句
  // 「模型内动画（N 条）：…」，画布上根本选不了 —— 现在两档列表里直接能选来播。
  setCatalogSource('model', P().extractBBModelAnimationTracks(text).animations, filePath);

  const modelDir = String(filePath || '').replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  const urls = await MV().resolveTextureDataUrls(scene, modelDir, host.readBinaryFile);
  const issues = [];
  if (urls.length) {
    const imgs = await Promise.all(urls.map((u) => MV().loadImage(u.dataUrl)));
    if (token !== loadToken) return { ok: true, report: [], issues: [], stale: true };
    urls.forEach((u, i) => {
      const img = imgs[i];
      if (img) S.textures[u.index] = img;
      else {
        S.textureReport.missing.push({ index: u.index, path: u.path || null, reason: u.error || '解码失败' });
        const ref = scene.textureRefs[u.index] || {};
        issues.push({
          level: 'warn',
          message: `模型的贴图「${ref.name || u.index}」没读到（${u.error || '解码失败'}），预览里用该立方体的纯色代替。`,
        });
      }
    });
  }
  S.textureReport.loaded = Object.keys(S.textures).length;

  const report = [];
  report.push(`模型：${scene.name || '(无名)'}　标识：${bbInfo.modelIdentifier || '(无)'}`);
  report.push(`格式版本：${bbInfo.formatVersion} / ${bbInfo.modelFormat}`);
  report.push(`尺寸：${bbInfo.resolution.width}×${bbInfo.resolution.height}　` +
    `元素：${scene.stats.cubeCount} 个立方体（${scene.stats.faceCount} 个面）　骨骼：${scene.stats.boneCount} 根`);
  report.push('');
  report.push(`✔ 已画到预览画布：${scene.stats.cubeCount} 个立方体 / ${scene.stats.boneCount} 根骨骼，` +
    `其中 ${scene.stats.texturedFaces} 个面贴了贴图`);
  if (scene.textureRefs.length) {
    report.push(`贴图：${S.textureReport.loaded}/${S.textureReport.total} 张读到了` +
      (S.textureReport.missing.length ? `（${S.textureReport.missing.length} 张读不到，用纯色代替）` : ''));
  }
  report.push('');
  report.push(`骨骼（${scene.bones.filter((b) => b.exported).length} 根导出）：`);
  report.push('  ' + scene.bones.filter((b) => b.exported).map((b) => b.name).join(', '));
  const texIssues = P().checkTextures(bbInfo.textures);
  if (texIssues.length) {
    report.push('');
    report.push('贴图来源检查：');
    for (const t of texIssues) report.push(`  [${t.level.toUpperCase()}] ${t.name}: ${t.message}`);
  }
  if (bbInfo.animations.length) {
    report.push('');
    report.push(`模型内动画（${bbInfo.animations.length} 条）：`);
    for (const a of bbInfo.animations) {
      report.push(`  ${a.name}  loop=${a.loop}  ${a.lengthMs}ms  ${a.animators.length} 骨骼通道`);
    }
    report.push('  （在「① 模型/GIF 调整」右栏的动画列表里可以直接选它们，画布上按播放头摆姿态）');
  }

  return { ok: true, report, issues, scene, bbInfo };
}

/**
 * 动画文本 → 可采样轨道。
 * @returns { ok, report:[字符串], issues:[], tracks, anims, chosen }
 */
function loadAnimationText(text, filePath) {
  const tracksDoc = P().extractAnimationTracks(text);
  const parsed = P().parseAnimationJson(text);
  // 先把这一来源的全部动画登记进目录（两档列表读它）；模型自带的动画原样保留。
  setCatalogSource('file', tracksDoc.animations, filePath);
  S.anims = tracksDoc.animations.map((a) => ({ name: a.name, lengthMs: a.lengthMs, bones: Object.keys(a.bones).length }));
  S.animPath = filePath;

  // 选中哪一条：沿用原来的产品行为 —— 最长的那条（时间轴要对齐它）
  const chosen = tracksDoc.animations.length
    ? tracksDoc.animations.reduce((a, b) => (a.lengthMs >= b.lengthMs ? a : b))
    : null;
  select(chosen ? S.catalog.find((e) => e.source === 'file' && e.name === chosen.name) : null);

  const report = [];
  report.push(`文件：${filePath}`);
  report.push(`格式版本：${tracksDoc.formatVersion}`);
  report.push(`动画条数：${tracksDoc.animations.length}　已选中：${S.animName || '(无)'}`);
  if (S.scene) {
    report.push(`✔ 已套用到预览画布上的模型「${S.scene.name || '(无名)'}」—— 拖播放头 / 播放即可看到骨骼动作`);
  } else {
    report.push('⚠ 还没导入模型：这次只解析了动画。先「导入模型」(.bbmodel) 才能在画布上看到动作。');
  }
  report.push('');
  for (const a of parsed.animations) {
    report.push(`── ${a.name}`);
    report.push(`   时长：${a.lengthMs}ms (${a.lengthSec}s)　循环：${loopText(a.loop)}　骨骼：${a.boneNames.length} 个`);
    const tr = tracksDoc.animations.find((x) => x.name === a.name);
    if (tr) {
      const chans = Object.keys(tr.bones).map((bn) => `${bn}[${Object.keys(tr.bones[bn]).join('/')}]`);
      report.push(`   可采样通道：${chans.join(' ') || '(无)'}`);
      // 表达式帧不静默丢（卡 t_96cd9241）：弹窗里也逐处说清「这一处不会动、按什么处理」
      if (tr.expressions.length) {
        report.push(`   ⚠ 含 ${tr.stats.exprCount} 处表达式（本期不求值，按前一帧保持），逐处列出：`);
        for (const e of tr.expressions) report.push(`     · ${P().expressionNote(e)}`);
      }
    }
    report.push(`   关键帧时间点（${a.keyTimesMs.length} 个）：${a.keyTimesMs.slice(0, 30).join(', ')}${a.keyTimesMs.length > 30 ? ' …' : ''}`);
    if (tr) report.push(`   采样到的关键帧：${tr.stats.keyCount} 个 / 时间点 ${tr.stats.timeCount} 个`);
  }

  const issues = [];
  for (const a of tracksDoc.animations) {
    if (a.lengthMs <= 0 && Object.keys(a.bones).length) {
      issues.push({ level: 'warn', message: `动画「${a.name}」没有任何关键帧时间点（长度 0），预览里会一直是静止姿态。` });
    }
  }
  return { ok: true, report, issues, tracks: chosen, anims: S.anims, chosen };
}

function loopText(loop) {
  if (loop === true) return 'loop（循环）';
  if (loop === 'hold_on_last_frame') return 'hold_on_last_frame（停在末帧）';
  if (loop === false) return 'once（播放一次）';
  return String(loop);
}

function clear() {
  loadToken++;
  S.scene = null;
  S.textures = {};
  S.textureReport = null;
  clearSelection();
  S.catalog = [];
  S.anims = [];
  S.modelPath = null;
  S.animPath = null;
  S.lastMs = null;
  S.lastStats = null;
  S.lastView = null;
  S.draws = 0;
  stopDriver();
}

// ---------------------------------------------------------------------------
// 播放驱动（只在「模型模式 + 正在播放」时跑；GIF/视频的驱动器动不了这里）
// ---------------------------------------------------------------------------

/** 可以自己走时钟吗：有音效时要等音频真的在响（和 GIF 一条规矩） */
function canDrive() {
  const st = host.state();
  if (st.visualMode !== 'model' || !S.scene) return false;
  if (st.transport !== 'playing' || st.scrubbing) return false;
  if (st.doc.clips.length && !host.audioPlaying()) return false;
  return true;
}

function startDriver() {
  if (driver) return;
  const step = () => {
    driver = null;
    if (!canDrive()) return;
    const ms = host.clockMs();
    if (S.lastMs == null || Math.abs(ms - S.lastMs) >= 8) render(ms);
    driver = requestAnimationFrame(step);
  };
  driver = requestAnimationFrame(step);
}

function stopDriver() {
  if (driver) { cancelAnimationFrame(driver); driver = null; }
}

const api = {
  init,
  loadModelText,
  loadAnimationText,
  render,
  metaText,
  snapshot,
  fingerprint,
  clear,
  startDriver,
  stopDriver,
  stageBox,
  // 动画目录（卡 t_96cd9241）：登记 / 选中 / 查询
  setCatalogSource,
  catalogRow,
  select,
  find,
  selectedEntry,
  clearSelection,
  get catalog() { return S.catalog; },
  get selectedKey() { return S.selectedKey; },
  get scene() { return S.scene; },
  get tracks() { return S.tracks; },
  get animName() { return S.animName; },
  get state() { return S; },
};

window.MCS_MODELPREVIEW = api;

})();
