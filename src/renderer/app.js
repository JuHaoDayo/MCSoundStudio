/**
 * app.js — 主应用逻辑
 *
 * 职责：
 *  - 状态管理（document / 选中片段 / 音效库）
 *  - 时间轴渲染与拖拽交互
 *  - 属性面板双向绑定
 *  - 校验与导出
 */

'use strict';

(function () {

// timeline.js / parsers.js / audio.js 导出到 window 上的 API
const MCS = window.MCS;
const MCS_PARSERS = window.MCS_PARSERS;
const AudioEngine = window.MCS_AUDIO;

// 常用函数取出为局部引用（避免与这些文件里的全局名字冲突）
const makeClip = MCS.makeClip;
const makeTrack = MCS.makeTrack;
const makeDocument = MCS.makeDocument;
const snapMs = MCS.snapMs;
const msToTick = MCS.msToTick;
const validate = MCS.validate;
const exportMarkdown = MCS.exportMarkdown;
const exportModSDKPython = MCS.exportModSDKPython;
const exportSoundDefinitions = MCS.exportSoundDefinitions;
const exportAnimationSoundEffects = MCS.exportAnimationSoundEffects;
const exportTimelineJson = MCS.exportTimelineJson;
// 片段几何：条长 ↔ 倍速 / 非破坏性裁剪 / 淡入淡出（卡 t_47b9fab2）
// 这几个 helper 住在 timeline.js 里，拖拽、属性面板、播放器三处共用同一套，
// 免得「拖出来的值」和「播出来的值」算得不一样。
const MIN_DURATION_MS = MCS.MIN_DURATION_MS;
// 片段左端多宽算「头部裁剪区」（Alt + 在这一带按下 = 裁剪头；不按 Alt = 移动片段）
const TRIM_HEAD_ZONE_PX = 8;
const MIN_RATE = MCS.MIN_RATE;
const MAX_RATE = MCS.MAX_RATE;
const FADE_PRESETS = MCS.FADE_PRESETS;
const rateOf = MCS.rateOf;
const srcTotalMs = MCS.srcTotalMs;
const srcOutMs = MCS.srcOutMs;
const contentMs = MCS.contentMs;
const isTrimmed = MCS.isTrimmed;
const audibleMs = MCS.audibleMs;
const setStretchedDuration = MCS.setStretchedDuration;
const setTrimmedTail = MCS.setTrimmedTail;
const setTrimmedHead = MCS.setTrimmedHead;
const normalizeFades = MCS.normalizeFades;
const fadePresetById = MCS.fadePresetById;
const applyFadePreset = MCS.applyFadePreset;
const matchFadePreset = MCS.matchFadePreset;
// 导入容错：把外部工程（手改 / 第三方生成 / 旧版本）缺的字段补齐（卡 t_59ec2202）
const normalizeImportedDoc = MCS.normalizeImportedDoc;

const parseAnimationJson = MCS_PARSERS.parseAnimationJson;
const detectAnimationDirtyData = MCS_PARSERS.detectAnimationDirtyData;
const parseBBModel = MCS_PARSERS.parseBBModel;
const crossCheckBones = MCS_PARSERS.crossCheckBones;
const checkTextures = MCS_PARSERS.checkTextures;

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
const STATE = {
  doc: makeDocument({ name: '未命名时序' }),
  library: [],              // [{name, absPath, relPath, ext, size, group}]
  selectedClipId: null,
  selectedClipIds: new Set(), // 多选集合（框选 / Ctrl+点击 / Shift+范围）；selectedClipId 是「主选中」
  zoom: 0.25,               // px per ms
  bbInfo: null,             // .bbmodel 解析结果
  animInfos: [],            // 动画列表
  animFile: null,
  issues: [],
  favorites: new Set(),     // 收藏的音效 key
  dirty: false,             // 有未保存的改动（显示在窗口标题）
  assetIssues: [],          // 模型/贴图/动画导入过程中的问题（revalidate 会合并）
  gifAnim: null,            // GIF 解析出的帧（用于暂停 / seek）
  gifFrames: [],
  gifPlayer: null,          // GIF 播放控制器
  playheadMs: 0,            // 当前播放头位置（暂停后续播用）
  // 'playing' | 'stopped' | 'scrubbing' | 'ended' —— 传输控制的唯一真相来源。
  // 不能只看 AudioEngine.isPlaying()：音频自然播完、音频文件缺失、
  // 播放到总长自动停止时，引擎状态会和按钮显示不一致，
  // 那样"点暂停"可能被当成"重新播放"（用户看到 GIF 又开始动）。
  //   scrubbing：用户正按住标尺拖播放头，音频已经停了（松手后会回到 playing）
  //   ended    ：已播到总长末尾、停在最后一帧（再点播放要从 0 重新播）
  transport: 'stopped',
  // 用户正按住标尺拖播放头。这期间任何时钟都不许改写播放头，
  // 否则往回拉会被音频时钟顶回原位（GIF 看着"不倒退"）。
  scrubbing: false,
  openGroups: new Set(['cat:block']),   // 已展开的分组（折叠状态持久化）
  selectedTrack: null,      // 当前选中的轨道名（视觉高亮 + 新建片段默认落这里）
  // -------------------------------------------------------------------------
  // 预览画布里「现在显示的是什么」（卡 t_fa17801d）
  //   'none' | 'gif' | 'video' | 'image' | 'model'
  // 模型导入后画的就是同一个 #previewCanvas；同时存在模型与 GIF/视频时，
  // 用预览区那枚「看模型 / 看 GIF」按钮切换，两边都不丢（GIF 行为不变）。
  // -------------------------------------------------------------------------
  visualMode: 'none',
  gifRenderer: null,        // GIF 渲染器（切回 GIF 时要按 GIF 尺寸重画一次）
  videoMs: 0,
  // -------------------------------------------------------------------------
  // 工作页的两个步骤（卡 t_c54d031b）
  //   'adjust' = ① 模型/GIF 调整（摆角度 / 选动画 / 放 GIF）
  //   'sound'  = ② 音效（时间轴 + 音效库 + 片段属性）—— 默认停在这里，与改动前一致
  // 两个页面画的是**同一块画布**、读的是**同一份状态**（STATE.doc.visual），
  // 切页只换右栏控件，不动播放头 / 播放状态 / 总长 / 选中片段 / 撤销栈。
  // -------------------------------------------------------------------------
  // 动画两档（卡 t_96cd9241）：每档各自记着「上次选的那条」（运行期记忆，不写工程文件；
  // 文件里只有当前档的 animName / animFile / animMode）。key = `来源:动画名`。
  animSel: { keyframe: null, molang: null },
  step: 'sound',
  // ---------------------------------------------------------------------------
  // 「导出系统信息」（卡 t_20c2e144）要的两个实测值 —— 只有渲染进程知道：
  //   libraryLoadMs：本次会话**第一次**成功加载原版库的耗时（ms），只记第一次；
  //   libraryMeta  ：那一次加载到的真实规模（事件数 / 变体数 / 带中文描述数）。
  // 都保持 null 表示「这次会话还没加载过库」，导出的 txt 里会如实写「未加载」。
  // ---------------------------------------------------------------------------
  libraryLoadMs: null,
  libraryMeta: null,
};

// ---------------------------------------------------------------------------
// 预览画布的「显示模式」开关
//
// 铁律：GIF / 视频 / 图片的既有行为一个字都不许变 —— 这里只负责「谁可见」，
// 以及把画布尺寸在「GIF 自己的像素尺寸」和「模型的自适应尺寸」之间切干净
// （GIF 的 renderTo 是 1:1 往画布左上角贴，画布尺寸被改过就必须还原）。
// ---------------------------------------------------------------------------
function setVisualMode(mode) {
  STATE.visualMode = mode || 'none';
  applyVisualStage();
  updateVisualSwitchButton();
  updateVisualMeta(STATE.playheadMs || 0);
  if (mode === 'model') {
    MCS_MODELPREVIEW.render(STATE.playheadMs || 0);
    if (STATE.transport === 'playing') MCS_MODELPREVIEW.startDriver();
  } else {
    MCS_MODELPREVIEW.stopDriver();
  }
  return STATE.visualMode;
}

/** 按当前模式决定 stage 里四个元素谁可见 */
function applyVisualStage() {
  const canvas = $('previewCanvas');
  const video = $('previewVideo');
  const img = $('previewGif');
  const empty = $('previewEmpty');
  if (!canvas) return;
  const mode = STATE.visualMode;

  canvas.style.display = (mode === 'gif' || mode === 'model') ? 'block' : 'none';
  if (video) video.style.display = mode === 'video' ? 'block' : 'none';
  if (img) img.style.display = mode === 'image' ? 'block' : 'none';
  if (empty) empty.style.display = mode === 'none' ? 'block' : 'none';

  if (mode === 'none') {
    // 画布上不留上一份模型的残影：「移除模型 / 移除画面」之后，画布本身也该是空的
    // （它这会儿虽然被藏起来了，但任何读画布像素的检查都该看到「什么都没有」）。
    if (canvas.width && canvas.height) {
      const g = canvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  if (mode === 'gif') {
    // 回到 GIF：还原画布像素尺寸（模型模式把它改成过预览区大小）
    canvas.style.width = '';
    canvas.style.height = '';
    if (STATE.gifAnim) {
      canvas.width = STATE.gifAnim.width;
      canvas.height = STATE.gifAnim.height;
    }
    if (STATE.gifPlayer) STATE.gifPlayer.seek(STATE.gifPlayer.getTime());   // 强制重画当前帧
  }
}

/** 「看模型 / 看画面」按钮：两个槽都非空时才出现才能来回切（不是死按钮） */
function updateVisualSwitchButton() {
  const b = $('btnVisualSwitch');
  if (!b) return;
  const v = STATE.doc.visual || {};
  const img = $('previewGif');
  // 两个槽都要"真的还有东西"：
  //   - 模型：文档里记着 modelPath，且场景真的画得出来（文件没了就不该给一个点了没反应的按钮）
  //   - 画面：运行时还握着播放器/视频，图片则看 src 属性本身
  // 注意图片这一支必须用 getAttribute('src')：清空时用的是 img.src = ''，
  // 而 img.src 读回来会被解析成当前页面的 URL（非空字符串），
  // 用它判断就会出现「只导入了一个模型，却冒出一个『看画面』按钮」——点了是一片空白。
  const hasModel = !!v.modelPath && !!MCS_MODELPREVIEW.scene;
  const other = STATE.gifPlayer ? 'gif'
    : (STATE.videoEl ? 'video'
      : ((img && img.getAttribute('src')) ? 'image' : null));
  if (!hasModel || !other) {
    b.style.display = 'none';
    updateVisualRemovalButtons();
    return;
  }
  b.style.display = '';
  b.dataset.target = STATE.visualMode === 'model' ? other : 'model';
  b.textContent = STATE.visualMode === 'model' ? '看画面' : '看模型';
  b.title = STATE.visualMode === 'model'
    ? '切回 GIF、视频或图片预览（两边都保留，随时切回来）'
    : '把导入的模型画到预览画布上（按播放头套用动画）';
  updateVisualRemovalButtons();
}

/** 预览栏里把模型与画面素材分开删除，两个按钮不会互相替代。 */
function updateVisualRemovalButtons() {
  const v = STATE.doc.visual || {};
  const media = $('btnRemoveMedia');
  const model = $('btnRemoveModel');
  const mediaKind = v.mediaPath ? v.kind : null;
  if (media) {
    media.style.display = mediaKind && mediaKind !== 'model' && mediaKind !== 'none' ? '' : 'none';
    media.textContent = mediaKind === 'video' ? '移除视频' : (mediaKind === 'image' ? '移除图片' : '移除 GIF');
  }
  if (model) model.style.display = v.modelPath ? '' : 'none';
  // 调整页的素材槽跟着同一份状态走（卡 t_c54d031b）：删掉素材后槽里不该还留着名字。
  // 挂在这里是因为所有「素材变了」的路径最后都会走到 updateVisualRemovalButtons()。
  updateVisualSlots();
}

/** 切换按钮的执行体（也给自动化测试留一个入口） */
function switchVisualTarget() {
  const b = $('btnVisualSwitch');
  const target = (b && b.dataset.target) || (STATE.visualMode === 'model' ? 'gif' : 'model');
  if (target === 'model' && !MCS_MODELPREVIEW.scene) return null;
  return setVisualMode(target);
}

/** 清掉画面素材的运行时对象，避免删除后播放头还继续驱动已经不存在的播放器。 */
function clearMediaRuntime() {
  const video = $('previewVideo');
  if (video) {
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) { /* 无媒体时忽略 */ }
  }
  const img = $('previewGif');
  if (img) img.removeAttribute('src');
  STATE.gifPlayer = null;
  STATE.gifRenderer = null;
  STATE.gifAnim = null;
  STATE.gifFrames = [];
  STATE.gifNativeMs = 0;
  STATE.gifTotalMs = 0;
  STATE.videoEl = null;
  STATE.videoMs = 0;
  setTailHints(false);
}

/** 真正移除一个素材槽；文档改动走 markDirty，因此 Ctrl+Z 会恢复删除前的引用。 */
function removeVisualAsset(slot, ask) {
  const v = STATE.doc.visual || (STATE.doc.visual = {});
  const removingMedia = slot === 'media';
  const path = removingMedia ? v.mediaPath : v.modelPath;
  if (!path) {
    status(removingMedia ? '当前没有可移除的画面素材' : '当前没有可移除的模型');
    return false;
  }
  const label = removingMedia
    ? (v.kind === 'video' ? '视频' : (v.kind === 'image' ? '图片' : 'GIF'))
    : '模型';
  if (ask !== false && !window.confirm(`确定移除当前${label}吗？文件本身不会删除；按 Ctrl+Z 可以恢复。`)) return false;

  // 停掉播放与时钟后再拆运行时引用，删除时不会留着「已放完」或旧画面同步提示。
  if (STATE.transport === 'playing' || STATE.transport === 'scrubbing') stopTransport();
  else stopVisualDrivers();
  if (removingMedia) {
    clearMediaRuntime();
    v.mediaPath = null;
    v.dataUrl = null;
    if (v.modelPath) {
      v.kind = 'model';
      v.path = v.modelPath;
      setVisualMode('model');
    } else {
      v.kind = 'none';
      v.path = null;
      setVisualMode('none');
    }
    $('metaDuration').textContent = '总时长：--';
  } else {
    MCS_MODELPREVIEW.clear();
    STATE.bbInfo = null;
    STATE.animInfos = [];
    STATE.assetIssues = STATE.assetIssues.filter((i) => !i.fromModel && !i.fromTexture && !i.fromAnim);
    v.modelPath = null;
    v.animFile = null;
    v.animName = null;
    if (v.mediaPath) {
      v.path = v.mediaPath;
      setVisualMode(v.kind);
    } else {
      v.kind = 'none';
      v.path = null;
      setVisualMode('none');
    }
    $('metaBones').textContent = '骨骼：--';
  }
  updateVisualSwitchButton();
  updateVisualRemovalButtons();
  revalidate();
  markDirty('visualDelete');
  status(`已移除${label}，文件还在原位置`, '按 Ctrl+Z 可以恢复；保存后会记住这次移除');
  return true;
}

// ---------------------------------------------------------------------------
// 工作页的两个步骤（卡 t_c54d031b）：① 模型/GIF 调整 ↔ ② 音效
//
// 铁律（规格 §1.3）：
//   · 两个页面画的是**同一块画布**（#previewCanvas + model-view.js），不是两套渲染；
//   · 角度 / 缩放 / 位移 / 动画模式 / 选中动画只有**一份状态**，就存在 STATE.doc.visual 里
//     （所以它天然跟着工程文件走）—— 两个页面都读它，「调整页一个角度、音效页另一个角度」
//     这类问题从根上不留；
//   · 切页不动播放头、播放/暂停状态、时间轴总长、选中片段、撤销栈。
// ---------------------------------------------------------------------------
const VIEW_DEFAULT = { x: -20, y: -32, z: 0, zoom: 1, panX: 0, panY: 0 };
// ↑ 必须等于 model-view.js 的 DEFAULT_VIEW（yaw -32 / pitch -20）：老工程没有这些字段时
//   落到这里，观感与改动前逐像素一致。
const ANGLE_MIN = -180, ANGLE_MAX = 180;      // 角度读数范围（规格 §2.1）
const VIEW_ZOOM_MIN = 0.25, VIEW_ZOOM_MAX = 4; // 缩放范围（1 = 自动铺满 = 现在的观感）
const DRAG_DEG_PER_PX = 0.4;                   // 拖动灵敏度：横向约 900px 转一整圈

/** 只认真正的有限数：字符串 / NaN / null 一律当「没写」（规格 §4 的校验要求） */
function numOrDef(x, def) {
  return (typeof x === 'number' && Number.isFinite(x)) ? x : def;
}
function clampNum(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
/** 角度归一到 -180~180（拖动可以连着转好几圈，读数不能越界） */
function wrapAngle(a) {
  let v = numOrDef(a, 0) % 360;
  if (v > 180) v -= 360;
  if (v < -180) v += 360;
  return Math.round(v * 100) / 100;
}
function fmtDeg(n) { return (Math.round(numOrDef(n, 0) * 10) / 10) + '°'; }

/**
 * 从工程文件里取视角并**做校验**（规格 §4）：
 *   · 缺字段 → 默认值（老工程打开后的观感与改动前完全一致）；
 *   · 非法值（字符串 / NaN / 超范围）→ 回落默认值 / 夹到范围，绝不把 NaN / undefined 写回文件；
 *   · 缺失字段不做迁移写回（只读，不动文件）。
 * 字段映射：angle.x = 上下（pitch）、angle.y = 左右（yaw）、angle.z = 画面内滚转（roll）。
 */
function viewFromVisual(v) {
  const src = (v && typeof v === 'object') ? v : {};
  const ang = (src.angle && typeof src.angle === 'object') ? src.angle : {};
  const pan = (src.pan && typeof src.pan === 'object') ? src.pan : {};
  return {
    x: clampNum(numOrDef(ang.x, VIEW_DEFAULT.x), ANGLE_MIN, ANGLE_MAX),
    y: clampNum(numOrDef(ang.y, VIEW_DEFAULT.y), ANGLE_MIN, ANGLE_MAX),
    z: clampNum(numOrDef(ang.z, VIEW_DEFAULT.z), ANGLE_MIN, ANGLE_MAX),
    zoom: clampNum(numOrDef(src.zoom, VIEW_DEFAULT.zoom), VIEW_ZOOM_MIN, VIEW_ZOOM_MAX),
    panX: clampNum(numOrDef(pan.x, VIEW_DEFAULT.panX), -4000, 4000),
    panY: clampNum(numOrDef(pan.y, VIEW_DEFAULT.panY), -4000, 4000),
    // 动画两档 / 播放方式：界面在卡 t_96cd9241，字段先按规格 §4 落位；
    // 缺省值就是现在的行为（关键帧动画 / 跟随播放头），所以老工程不会因此变样。
    animMode: src.animMode === 'molang' ? 'molang' : 'keyframe',
    animName: (typeof src.animName === 'string' && src.animName) ? src.animName : null,
    playMode: src.playMode === 'standalone' ? 'standalone' : 'follow',
  };
}

/** 当前视角（唯一真相 = 文档；两个页面都读这一个） */
function currentView() { return viewFromVisual(STATE.doc.visual); }

/**
 * 交给渲染层（model-view.js）的那份视角：把工程字段名映射成渲染参数名。
 * 映射关系：angle.x = 上下 → pitch、angle.y = 左右 → yaw、angle.z = 画面内滚转 → roll。
 * 这里是唯一一处映射，画布上看到的与研究面板里的读数必然同源。
 */
function rendererView() {
  const v = currentView();
  return { yaw: v.y, pitch: v.x, roll: v.z, zoom: v.zoom, panX: v.panX, panY: v.panY };
}

/**
 * 写回视角字段：只写用户真的动过的角度 / 缩放 / 位移，
 * 外加两个预留字段（动画模式 / 播放方式）的当前值 —— 用户改过这一页，文件里就该记着口径。
 * @returns 校验、夹取之后的视角（界面读数用这个，不用输入框里的原始字符串）
 */
function writeView(patch) {
  const v = STATE.doc.visual || (STATE.doc.visual = {});
  const next = Object.assign(currentView(), patch || {});
  v.angle = {
    x: clampNum(numOrDef(next.x, VIEW_DEFAULT.x), ANGLE_MIN, ANGLE_MAX),
    y: clampNum(numOrDef(next.y, VIEW_DEFAULT.y), ANGLE_MIN, ANGLE_MAX),
    z: clampNum(numOrDef(next.z, VIEW_DEFAULT.z), ANGLE_MIN, ANGLE_MAX),
  };
  v.zoom = clampNum(numOrDef(next.zoom, VIEW_DEFAULT.zoom), VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
  v.pan = {
    x: clampNum(numOrDef(next.panX, VIEW_DEFAULT.panX), -4000, 4000),
    y: clampNum(numOrDef(next.panY, VIEW_DEFAULT.panY), -4000, 4000),
  };
  v.animMode = next.animMode === 'molang' ? 'molang' : 'keyframe';
  v.playMode = next.playMode === 'standalone' ? 'standalone' : 'follow';
  return viewFromVisual(v);
}

/** 视角变了：按同一份状态重画画布 + 刷右栏读数（两个页面共用这一条路径） */
function applyView(patch) {
  const view = writeView(patch);
  if (STATE.visualMode === 'model' && MCS_MODELPREVIEW.scene) {
    MCS_MODELPREVIEW.render(STATE.playheadMs || 0);
  }
  renderViewFields(view);
  return view;
}

/** 右栏「角度」区的读数（三个数字框 + 缩放滑杆 + 倍数） */
function renderViewFields(view) {
  const v = view || currentView();
  const setNum = (id, val) => {
    const el = $(id);
    // 用户正在这个框里打字时不抢他的光标（值相同也不写）
    if (el && el.value !== String(val) && document.activeElement !== el) el.value = val;
  };
  setNum('inpAngleX', v.x);
  setNum('inpAngleY', v.y);
  setNum('inpAngleZ', v.z);
  const rng = $('rngAngleZoom');
  if (rng && Number(rng.value) !== v.zoom) rng.value = v.zoom;
  const val = $('angleZoomVal');
  if (val) val.textContent = v.zoom.toFixed(2) + '×';
}

/** 重置角度：回默认视角（= 现在的默认观感），一步可撤销 */
function resetView(announce) {
  beginUndoBatch('view');
  applyView({ x: VIEW_DEFAULT.x, y: VIEW_DEFAULT.y, z: VIEW_DEFAULT.z,
              zoom: VIEW_DEFAULT.zoom, panX: 0, panY: 0 });
  markDirty('view');
  endUndoBatch();
  if (announce) {
    status('角度已重置为默认视角', 'X=-20° / Y=-32° / Z=0° / 缩放 1.00× —— 和刚导入模型时看到的一样');
  }
  return currentView();
}

/** 导入素材后自动落在调整页（规格 §1.1）：导入本来就是「我要调素材」的动作 */
function landOnAdjust(opts) {
  if (opts && opts.noStep) return null;
  // keepMode：只把「当前页」挪到调整页，**不碰**画布上正在显示的东西。
  // 导入动作自己知道该显示什么（导入模型 → 模型；导入 GIF/视频/图片 → 那件素材），
  // 这里要是顺手 setVisualMode('model')，就会出现「导入一张图片，看到的却是模型」
  // （卡 t_fad69070 明确修过「两个槽互不顶替」，不能在这里退回去）。
  return setStep('adjust', { quiet: true, keepMode: true });
}

let PREVIEW_EMPTY_SOUND_HTML = null;
/**
 * 空状态文案跟着页面走（规格 §2.2）：
 *   调整页 → 逐字说清「先导入什么」；音效页 → 保持原来的 GIF 引导（观感不变）。
 */
function renderPreviewEmptyText() {
  const el = $('previewEmpty');
  if (!el) return;
  if (PREVIEW_EMPTY_SOUND_HTML == null) PREVIEW_EMPTY_SOUND_HTML = el.innerHTML;
  if (STATE.step === 'adjust') {
    el.innerHTML = '<div class="pe-icon">🧊</div>'
      + '<div>还没有素材</div>'
      + '<div class="pe-sub">点「导入模型」选 .bbmodel（负责动画姿态）</div>'
      + '<div class="pe-sub">点「导入 GIF/视频」选画面参考（负责对齐画面）</div>';
  } else if (el.innerHTML !== PREVIEW_EMPTY_SOUND_HTML) {
    el.innerHTML = PREVIEW_EMPTY_SOUND_HTML;
  }
}

/** 只显示文件名：槽里给用户看的是「哪个文件」，不是一整条路径 */
function baseName(p) {
  const s = String(p == null ? '' : p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 画布上真的有一个「画得出来」的模型吗。
 * 注意与「槽里有模型」区分：空模型 .bbmodel（纯贴图工程 / 没有任何立方体）也会有 scene，
 * 但切到模型模式只会得到一块空画布 —— 那种情况不要硬切。
 */
function hasRenderableModel() {
  if (!MCS_MODELPREVIEW.scene) return false;
  const sn = MCS_MODELPREVIEW.snapshot ? MCS_MODELPREVIEW.snapshot() : null;
  return !!sn && (sn.cubeCount || 0) > 0;
}

/**
 * 画布上现在摆的是「画面素材」（GIF / 视频 / 图片）吗。
 * 用来避免切页 / 导入时把人家正在看的画面素材顶掉（两个槽互不顶替）。
 */
function isMediaMode() {
  return STATE.visualMode === 'gif' || STATE.visualMode === 'video' || STATE.visualMode === 'image';
}

/**
 * 调整页两个素材槽的文案（规格 §2.2）。
 * 「显示什么」全部来自文档 + 运行时真实对象，不另存一份 —— 删掉素材后槽里不该还留着名字。
 */
function updateVisualSlots() {
  const v = STATE.doc.visual || {};
  const sn = (window.MCS_MODELPREVIEW && MCS_MODELPREVIEW.snapshot) ? MCS_MODELPREVIEW.snapshot() : {};

  // ---- 模型槽：文件名 + 立方体数 / 骨骼数 / 贴图数
  const hasModel = !!v.modelPath;                 // 槽里有没有模型 = 文档说了算（与「移除模型」按钮同一判定）
  const modelLoaded = !!MCS_MODELPREVIEW.scene;   // 运行时有没有画出来（文件被删/读不到时为 false）
  const mName = $('slotModelName');
  if (mName) {
    mName.textContent = hasModel ? baseName(v.modelPath) : '还没有模型：点「导入模型」选 .bbmodel';
    mName.classList.toggle('empty', !hasModel);
  }
  const mSub = $('slotModelSub');
  if (mSub) {
    if (!hasModel) mSub.textContent = '';
    else if (!modelLoaded) mSub.textContent = '（文件现在读不到，重新导入一次即可）';
    else if (sn.cubeCount === 0) mSub.textContent = '空模型：没有可显示的立方体';
    else {
      const tex = (sn.textures && sn.textures.total) ? `, 贴图 ${sn.textures.loaded}/${sn.textures.total}` : ', 无贴图';
      mSub.textContent = `${sn.cubeCount || 0} 立方体 / ${sn.boneCount || 0} 骨骼${tex}`;
    }
  }
  const btnRmModel = $('btnSlotRemoveModel');
  if (btnRmModel) btnRmModel.style.display = hasModel ? '' : 'none';

  // ---- 画面参考槽：文件名 + 类型（GIF 帧数时长 / 视频时长 / 图片）
  const kind = (v.kind === 'gif' || v.kind === 'video' || v.kind === 'image') ? v.kind : null;
  const hasMedia = !!v.mediaPath && !!kind;
  const sName = $('slotMediaName');
  if (sName) {
    sName.textContent = hasMedia ? baseName(v.mediaPath) : '还没有画面参考：点「导入」选 GIF、视频或图片';
    sName.classList.toggle('empty', !hasMedia);
  }
  const sSub = $('slotMediaSub');
  if (sSub) {
    if (!hasMedia) sSub.textContent = '';
    else if (kind === 'gif') {
      sSub.textContent = STATE.gifAnim
        ? `GIF · ${STATE.gifAnim.frameCount} 帧 / ${(STATE.gifAnim.totalMs / 1000).toFixed(2)}s`
        : 'GIF（文件现在读不到，重新导入一次即可）';
    } else if (kind === 'video') {
      sSub.textContent = STATE.videoEl
        ? `视频 · ${(STATE.videoMs / 1000).toFixed(2)}s`
        : '视频（文件现在读不到，重新导入一次即可）';
    } else {
      sSub.textContent = '图片（不参与进度同步）';
    }
  }
  const btnRmMedia = $('btnSlotRemoveMedia');
  if (btnRmMedia) btnRmMedia.style.display = hasMedia ? '' : 'none';
  const btnImpMedia = $('btnSlotImportMedia');
  if (btnImpMedia) btnImpMedia.textContent = hasMedia ? '替换' : '导入';
  // 动画一栏的标题 / 空状态跟着素材走（卡 t_96cd9241）：删掉模型后这里不该还写着
  // 「这个模型没有可播的动画」。所有「素材变了」的路径最后都会走到这里。
  renderAnimPanel();
}

/**
 * 切步骤页（规格 §1.1 / §1.3）。
 * 只换「右栏控件 + 空状态文案」，画布按同一份状态重画一次；
 * 播放头 / 播放状态 / 总长 / 选中片段 / 撤销栈一律不动。
 */
function setStep(step, opts) {
  const o = opts || {};
  const next = (step === 'adjust') ? 'adjust' : 'sound';
  const changed = STATE.step !== next;
  STATE.step = next;
  if (document.body) document.body.dataset.page = next;

  const ba = $('btnStepAdjust');
  if (ba) { ba.classList.toggle('active', next === 'adjust'); ba.setAttribute('aria-selected', next === 'adjust' ? 'true' : 'false'); }
  const bs = $('btnStepSound');
  if (bs) { bs.classList.toggle('active', next === 'sound'); bs.setAttribute('aria-selected', next === 'sound' ? 'true' : 'false'); }
  const goAdj = $('btnGoAdjust');
  if (goAdj) goAdj.style.display = next === 'sound' ? '' : 'none';   // 音效页留一条回调整页的近路

  renderPreviewEmptyText();
  renderViewFields();

  if (next === 'adjust' && !o.keepMode && hasRenderableModel() && !isMediaMode()) {
    // 进调整页且画布上有模型 → 直接让模型可见（这一页就是用来摆角度的）。
    // 没有模型时保持原样（GIF / 视频 / 图片 / 空状态），不硬切。
    // 正在看画面素材时同样不抢（「看模型」按钮是用户自己的路）。
    setVisualMode('model');
  } else if (STATE.visualMode === 'model' && hasRenderableModel()) {
    // 切回音效页：按同一份角度**重画一次**（不依赖「上次画的」像素，规格 §1.3）
    MCS_MODELPREVIEW.render(STATE.playheadMs || 0);
  } else {
    applyVisualStage();     // GIF 模式：把画布像素尺寸还原成 GIF 自己的（规格 §7 坑 3）
  }
  updateVisualSwitchButton();
  updateVisualSlots();
  // 动画一栏（卡 t_96cd9241）：列表本身与页无关，但「独立预览」的循环只在调整页跑，
  // 所以切页时按当前页起停一次（不动播放头 / 不动传输状态）。
  renderAnimPanel();
  if (next === 'adjust') applyPlayMode(); else stopAnimPreview();
  if (changed && !o.quiet) {
    status(next === 'adjust'
      ? '已切到「① 模型/GIF 调整」—— 拖动画布摆角度，摆好后点「② 音效」回去配音效'
      : '已切到「② 音效」—— 画面沿用刚调好的角度',
    next === 'adjust' ? '素材槽在右侧：模型 / 画面参考各自独立，互不顶替' : '');
  }
  return next;
}

/**
 * 调整页的全部交互接线（幂等）。
 * 为什么不塞进 boot()：boot 是每张卡都会动的地方（本项目同工作区并行改 app.js），
 * 接线被别人的整段覆盖过一次 —— 挂在自己的 DOMContentLoaded 上与 boot 平级更稳。
 */
function setupStepSwitch() {
  if (setupStepSwitch._done) return 'already';
  setupStepSwitch._done = true;

  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('btnStepAdjust', () => setStep('adjust'));
  on('btnStepSound', () => setStep('sound'));
  on('btnGoAdjust', () => setStep('adjust'));
  // 素材槽的「导入」按钮 = 顶栏同款选择器（规格 §5.1：同一个入口，不做两套）
  on('btnSlotImportModel', () => { const b = $('btnImportBB'); if (b) b.click(); });
  on('btnSlotImportMedia', () => { const b = $('btnImportGif'); if (b) b.click(); });
  // 「移除」复用 B1 的实现（卡 t_fad69070）—— 确认框 / 撤销 / 标脏都是那一套，不做第二套
  on('btnSlotRemoveModel', () => removeVisualAsset('model'));
  on('btnSlotRemoveMedia', () => removeVisualAsset('media'));
  on('btnResetAngle', () => resetView(true));

  // 角度数字框：输入即生效，change 时把夹取后的值写回框里（用户看到的就是真值）
  const bindAngle = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const n = Number(el.value);
      if (el.value === '' || !Number.isFinite(n)) return;   // 只输了个负号 / 空：等他敲完，change 再收口
      applyView({ [key]: clampNum(n, ANGLE_MIN, ANGLE_MAX) });
      markDirty('view');
    });
    el.addEventListener('change', () => {
      const n = Number(el.value);
      const val = clampNum(Number.isFinite(n) && el.value !== '' ? n : VIEW_DEFAULT[key], ANGLE_MIN, ANGLE_MAX);
      el.value = val;
      applyView({ [key]: val });
      markDirty('view');
    });
  };
  bindAngle('inpAngleX', 'x');
  bindAngle('inpAngleY', 'y');
  bindAngle('inpAngleZ', 'z');

  const rng = $('rngAngleZoom');
  if (rng) {
    rng.addEventListener('input', () => {
      const n = Number(rng.value);
      if (!Number.isFinite(n)) return;
      applyView({ zoom: clampNum(n, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX) });
      markDirty('view');
    });
  }

  bindAdjustCanvas();
  renderViewFields();
  updateVisualSlots();
  setStep(STATE.step, { quiet: true });
  setupPreviewReflow();
  return 'wired';
}

/**
 * 预览区尺寸变了（拉窗口 / 拖预览区下沿的抓手）→ 模型画布按新尺寸**重画一次**。
 * 为什么需要：画布是固定像素尺寸的位图，尺寸变了不重画就只能被 CSS 按比例缩 ——
 * 缩下去就糊（`image-rendering: pixelated` 更明显），而且和 GIF 模式自己重算尺寸的
 * 行为不一致。只重画像素，不碰任何状态（角度/播放头/素材一律不动）。
 * 用 ResizeObserver 观察预览区，这样「拉窗口」和「拖抓手」两条路都覆盖到。
 */
function setupPreviewReflow() {
  if (setupPreviewReflow._done || typeof ResizeObserver === 'undefined') return 'skip';
  setupPreviewReflow._done = true;
  const stage = $('previewStage');
  if (!stage) return 'no-stage';
  let timer = null;
  const ro = new ResizeObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (STATE.visualMode === 'model' && hasRenderableModel()) MCS_MODELPREVIEW.render(STATE.playheadMs || 0);
    }, 180);
  });
  ro.observe(stage);
  return 'observing';
}

/**
 * 画布拖动 = 转模型 / Shift+拖动 = 挪位置；滚轮 = 缩放（只在调整页生效）。
 * 方向必须「顺着手」：往右拖 → 看到的那一侧往右走（= 模型看起来向左转，Y 变小）。
 * 推导：yaw 变大 = 相机绕到右边 → 正面往左滑；所以「正面往右滑」对应 yaw 变小。
 * 俯仰同理：往下拖 = 看到更多顶面 = 从上往下看 = X 变小（与默认值 -20 的方向一致）。
 */
function bindAdjustCanvas() {
  const stage = $('previewStage');
  if (!stage) return;
  const canDrag = () => STATE.step === 'adjust' && STATE.visualMode === 'model' && hasRenderableModel();
  let drag = null;

  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !canDrag()) return;
    drag = { x: e.clientX, y: e.clientY, pan: !!e.shiftKey, moved: false };
    beginUndoBatch('view');            // 整段拖动只占撤销栈一步
    document.body.classList.add('adj-dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!dx && !dy) return;
    drag.x = e.clientX; drag.y = e.clientY;     // 增量式：拖多远转多少
    drag.moved = true;
    const v = currentView();
    if (drag.pan) {
      applyView({ panX: clampNum(v.panX + dx, -4000, 4000), panY: clampNum(v.panY + dy, -4000, 4000) });
    } else {
      applyView({
        y: wrapAngle(v.y - dx * DRAG_DEG_PER_PX),
        x: clampNum(v.x - dy * DRAG_DEG_PER_PX, ANGLE_MIN, ANGLE_MAX),
      });
    }
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    document.body.classList.remove('adj-dragging');
    if (moved) {
      markDirty('view');
      const v = currentView();
      const shift = (v.panX || v.panY) ? ` · 位移 ${v.panX > 0 ? '+' : ''}${Math.round(v.panX)}, ${v.panY > 0 ? '+' : ''}${Math.round(v.panY)}` : '';
      status(`角度：X ${fmtDeg(v.x)} / Y ${fmtDeg(v.y)} / Z ${fmtDeg(v.z)} · 缩放 ${v.zoom.toFixed(2)}×${shift}`,
             v.panX || v.panY
               ? 'Shift+拖动 = 挪位置（点「重置角度」一并归零）；保存会把角度写进工程'
               : '点「重置角度」可回到默认视角；保存会把角度写进工程');
    }
    endUndoBatch();
  });
  stage.addEventListener('wheel', (e) => {
    if (!canDrag()) return;
    e.preventDefault();
    const v = currentView();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    applyView({ zoom: clampNum(v.zoom * factor, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX) });
    markDirty('view');
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// 调整页「动画」一栏（卡 t_96cd9241）：两档列表 + 选中即在画布上播
//
// 口径（A3 规格 §3 + mcs-qa 卡 t_9fd9ce60 的四条硬决定）：
//   · 两档按「这条动画里有没有表达式」分堆 —— 关键帧动画 = 全部关键帧都是数值的动画；
//     Molang 语言动画 = 含表达式的动画。**本期不求值**：画布上按「保持前一帧」播，
//     列表里逐处标注哪一处不会动、按什么处理（不许静默丢帧，见 parsers.readKeyTriple）。
//   · 列表来源两类都要有：导入的 .animation.json + 模型 .bbmodel 自带的 animations。
//   · 点一条 → 画布立刻按当前播放头摆出它的姿态；再点正在播的那条不做任何事（不是「取消」）。
//   · 换档 / 换动画都写进工程文件（animMode / animName / animFile），切回音效页与重开工程
//     后状态一致；**不动**播放头、时间轴总长、GIF 同步、选中片段与撤销栈的既有语义。
// ---------------------------------------------------------------------------
const ANIM_TIER_LABEL = { keyframe: '关键帧动画', molang: 'Molang 语言动画' };

/** 目录里唯一的键：来源:动画名（同名的外部动画与模型内动画是两条不同的动画） */
function animKey(e) { return e.source + ':' + e.name; }

/** 这一条归哪一档：含表达式 → Molang 档；全数值 → 关键帧档 */
function animTierOf(e) {
  return ((e.stats && e.stats.exprCount) || 0) > 0 ? 'molang' : 'keyframe';
}

function animListFor(tier) {
  return (MCS_MODELPREVIEW.catalog || []).filter((e) => animTierOf(e) === tier);
}

/** 来源文案：外部动画显示文件名，模型自带的说「模型内置」 */
function animSourceText(e) {
  return e.source === 'model' ? '模型内置' : (baseName(e.file) || '导入的动画文件');
}

/** 时长文案：秒 + 毫秒都给（用户看哪个都行） */
function fmtAnimLength(ms) {
  const n = Math.max(0, Math.round(ms || 0));
  return `${(n / 1000).toFixed(2)}s (${n}ms)`;
}

/** 一行动画：名字 + 关键信息；选中且含表达式时展开逐处说明 */
function animRowEl(entry, isSel) {
  const st = entry.stats || {};
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'anim-row' + (isSel ? ' selected' : '');
  row.dataset.animKey = animKey(entry);
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', isSel ? 'true' : 'false');
  row.title = '选中就在画布上按当前播放头摆出这条动画的姿态';

  const n = document.createElement('span');
  n.className = 'anim-row-name';
  n.textContent = entry.name;
  row.appendChild(n);

  const m = document.createElement('span');
  m.className = 'anim-row-meta';
  m.textContent = animTierOf(entry) === 'keyframe'
    ? `${fmtAnimLength(entry.lengthMs)} · 关键帧 ${st.keyCount || 0} 个（时间点 ${st.timeCount || 0} 个）`
      + ` · 骨骼 ${st.boneCount || 0} 根 · 来源：${animSourceText(entry)}`
    : `${fmtAnimLength(entry.lengthMs)} · 含 ${st.exprCount || 0} 处表达式`
      + ` · 骨骼 ${st.boneCount || 0} 根 · 来源：${animSourceText(entry)}`;
  row.appendChild(m);

  if (st.exprCount) {
    const w = document.createElement('span');
    w.className = 'anim-row-warn';
    w.textContent = `⚠ 含 ${st.exprCount} 处表达式（本档按固定值处理：未求值，按前一帧保持）`;
    row.appendChild(w);
  }
  if (st.otherCount) {
    const w = document.createElement('span');
    w.className = 'anim-row-warn';
    w.textContent = `⚠ 另有 ${st.otherCount} 处读不出数值的写法（已按前一帧保持）`;
    row.appendChild(w);
  }

  // 详情只在选中时展开；逐处列出「哪一处不会动、按什么处理」
  if (isSel && st.expressionCount) {
    const box = document.createElement('span');
    box.className = 'anim-expr';
    for (const x of (entry.expressions || [])) {
      const line = document.createElement('span');
      line.className = 'anim-expr-line';
      line.textContent = MCS_PARSERS.expressionNote(x);
      box.appendChild(line);
    }
    row.appendChild(box);
  }
  return row;
}

/**
 * 重画动画一栏：两档选中态 / 列表 / 空状态 / Molang 支持范围说明 / 播放方式按钮。
 * 纯渲染，不起时钟、不改状态 —— 任何「素材或目录变了」的路径都可以放心调它。
 */
function renderAnimPanel() {
  const host = $('animList');
  if (!host) return null;
  const view = currentView();
  const tier = view.animMode;
  const all = MCS_MODELPREVIEW.catalog || [];
  const list = animListFor(tier);
  const selKey = MCS_MODELPREVIEW.selectedKey;

  const bk = $('btnAnimModeKey'), bm = $('btnAnimModeMolang');
  if (bk) { bk.classList.toggle('active', tier === 'keyframe'); bk.setAttribute('aria-selected', tier === 'keyframe' ? 'true' : 'false'); }
  if (bm) { bm.classList.toggle('active', tier === 'molang'); bm.setAttribute('aria-selected', tier === 'molang' ? 'true' : 'false'); }

  const hint = $('animModeHint');
  if (hint) {
    hint.textContent = tier === 'keyframe'
      ? '关键帧动画：这条动画里全部关键帧都是数值，画布上能完整播出来。'
      : 'Molang 语言动画：含表达式的动画。本期不求值 —— 画布上按「保持前一帧」播，下面逐处标注。';
  }

  const cnt = $('animCountHint');
  if (cnt) {
    cnt.textContent = all.length
      ? `共 ${all.length} 条（关键帧 ${animListFor('keyframe').length} / Molang ${animListFor('molang').length}）`
      : '';
  }

  host.textContent = '';
  for (const e of list) host.appendChild(animRowEl(e, animKey(e) === selKey));

  // ---- 空状态：三种都要有文案，不给空白面板（规格 §3.2 / §3.3 / §3.4）
  const empty = $('animEmpty');
  const hasModel = !!((STATE.doc.visual || {}).modelPath);
  let emptyText = '';
  if (!all.length) {
    emptyText = hasModel
      ? '这个模型没有可播的动画。点「导入动画」选对应的 .animation.json，导入后这里会列出每一条。'
      : '还没有素材\n点「导入模型」选 .bbmodel（负责动画姿态）\n点「导入 GIF/视频」选画面参考（负责对齐画面）';
  } else if (!list.length) {
    emptyText = tier === 'molang'
      ? '这个素材里没有 Molang 动画（导入的动画全是数值关键帧）\n· 切到「关键帧动画」就能看它们'
      : '这个素材里没有关键帧动画\n· 模型自带动画：如果 .bbmodel 里没有，请回 Blockbench 里导出动画\n· 外部动画：点「导入动画」选 .animation.json';
  }
  if (empty) { empty.textContent = emptyText; empty.style.display = emptyText ? '' : 'none'; }

  // ---- Molang 档的支持范围说明：选了含表达式的动画，必须说清「这不是游戏里的最终效果」
  const sup = $('animSupport');
  const sel = MCS_MODELPREVIEW.selectedEntry ? MCS_MODELPREVIEW.selectedEntry() : null;
  let supText = '';
  if (sel && animTierOf(sel) === 'molang') {
    const n = (sel.stats && sel.stats.exprCount) || 0;
    supText = '这条动画里的表达式当前不会求值\n'
      + '· 支持范围：数值关键帧、常量通道、step/线性/catmullrom 插值（预览按线性近似）\n'
      + `· 不支持：query.* / variable.* / math.* 等表达式（共 ${n} 处，已在上面逐条列出）\n`
      + '· 画布上这些位置按「保持前一帧」处理，不代表游戏的最终效果';
  }
  if (sup) { sup.textContent = supText; sup.style.display = supText ? '' : 'none'; }

  // ---- 播放方式（规格 §2.3）：跟随播放头（默认）/ 独立预览
  const pf = $('btnPlayModeFollow'), ps = $('btnPlayModeStandalone');
  if (pf) { pf.classList.toggle('active', view.playMode === 'follow'); pf.setAttribute('aria-selected', view.playMode === 'follow' ? 'true' : 'false'); }
  if (ps) { ps.classList.toggle('active', view.playMode === 'standalone'); ps.setAttribute('aria-selected', view.playMode === 'standalone' ? 'true' : 'false'); }
  const ph = $('adjustPlayModeHint');
  if (ph) {
    ph.textContent = view.playMode === 'standalone'
      ? '独立预览：只在调整页自己循环播这条动画，不动时间轴播放头（切页 / 播放时自动停）。'
      : '播放方式：跟随时间轴播放头（拖标尺 / 播放都能看姿态）。';
  }

  return { tier, rows: list.length, total: all.length, selectedKey: selKey };
}

/**
 * 把选中的动画写进工程文件（animName / animFile）。
 * persist=false（恢复 / 撤销重做路径）时只改内存不标脏 —— 恢复过程不许产生新的撤销步。
 */
function writeAnimFields(entry, persist) {
  const v = STATE.doc.visual || (STATE.doc.visual = {});
  const name = entry ? entry.name : null;
  const file = entry ? (entry.file || null) : null;
  const changed = (v.animName || null) !== name || (v.animFile || null) !== file;
  v.animName = name;
  v.animFile = file;
  if (changed && persist !== false) markDirty('anim');
  return changed;
}

/** 选中一条动画（key = `来源:名字`）：画布立刻按播放头摆姿态 + 写进工程文件 */
function selectAnimByKey(key, opts) {
  const o = opts || {};
  const entry = (MCS_MODELPREVIEW.catalog || []).find((e) => animKey(e) === key) || null;
  if (!entry) return null;
  if (MCS_MODELPREVIEW.selectedKey === key && !o.force) {
    renderAnimPanel();
    return entry;                       // 再点正在播的那条：不做任何事（不是「取消了」）
  }
  beginUndoBatch('anim');
  stopAnimPreview();
  MCS_MODELPREVIEW.select(entry);
  STATE.animSel[animTierOf(entry)] = key;
  writeAnimFields(entry, o.persist);
  if (STATE.visualMode === 'model' && MCS_MODELPREVIEW.scene) MCS_MODELPREVIEW.render(STATE.playheadMs || 0);
  endUndoBatch();
  renderAnimPanel();
  applyPlayMode();
  if (!o.quiet) {
    const st = entry.stats || {};
    status(`已选中动画「${entry.name}」（${ANIM_TIER_LABEL[animTierOf(entry)]}）—— 画布按播放头摆出它的姿态`,
      `来源：${animSourceText(entry)} · 时长 ${fmtAnimLength(entry.lengthMs)}`
      + (st.exprCount ? `　⚠ 含 ${st.exprCount} 处表达式：未求值，按前一帧保持（逐处见列表）` : ''));
  }
  return entry;
}

/**
 * 换档（关键帧动画 / Molang 语言动画）。
 * 只换「列表 + 画布上播的那条」；素材、播放头、总长、选中片段一律不动。
 * 这一档有内容就选它最长的一条（列表按时长降序）—— 免得出现「换了档画布却还留着
 * 上一档那条动画的姿态」。
 */
function setAnimTier(tier, opts) {
  const o = opts || {};
  const next = tier === 'molang' ? 'molang' : 'keyframe';
  const before = currentView().animMode;
  const v = STATE.doc.visual || (STATE.doc.visual = {});
  stopAnimPreview();
  beginUndoBatch('anim');
  v.animMode = next;

  const list = animListFor(next);
  const cur = MCS_MODELPREVIEW.selectedEntry();
  let pick = (cur && animTierOf(cur) === next) ? cur : null;
  if (!pick && STATE.animSel[next]) pick = list.find((e) => animKey(e) === STATE.animSel[next]) || null;
  if (!pick && list.length) pick = list[0];
  MCS_MODELPREVIEW.select(pick);
  if (pick) STATE.animSel[next] = animKey(pick);
  writeAnimFields(pick, o.persist);
  if (before !== next && o.persist !== false) markDirty('anim');
  if (STATE.visualMode === 'model' && MCS_MODELPREVIEW.scene) MCS_MODELPREVIEW.render(STATE.playheadMs || 0);
  endUndoBatch();
  renderAnimPanel();
  applyPlayMode();
  if (before !== next && !o.quiet) {
    status(`已切到「${ANIM_TIER_LABEL[next]}」—— 这一档有 ${list.length} 条`
      + (pick ? `，当前播「${pick.name}」` : ''),
      next === 'molang'
        ? 'Molang 表达式本期不求值：画布上按「保持前一帧」播，列表里逐处标注了哪些位置不会动'
        : '这一档的动画全部关键帧都是数值，能完整播出来');
  }
  // 切到 Molang 档时把「不会求值 / 支持范围」的说明滚进视野：这段就是本档最该被看见的话，
  // 右栏内容比一屏高，不滚一下用户会以为「选了没提示」（QA 判据第 10 条）。
  // 只在用户主动换档时滚，渲染路径（恢复 / 撤销重做）不滚，免得页面自己乱跳。
  if (before !== next && next === 'molang') revealAnimSupport();
  return pick;
}

/** 把降级说明滚进可视区（已经在视野里就不动；block:'nearest' = 只做最小滚动） */
function revealAnimSupport() {
  const el = $('animSupport');
  if (!el || !el.textContent || el.style.display === 'none') return false;
  try {
    el.scrollIntoView({ block: 'nearest' });
    return true;
  } catch (e) { return false; }
}

/**
 * 目录变化（导入模型 / 导入动画 / 重开工程 / 撤销重做）后把选中态对齐到当前档。
 * 规则：文档说的算（animName + animFile）→ 本档上次选的那条 → 都没有就不播（静止姿态）。
 * restore:true（恢复 / 导入路径）不许往工程文件里写东西，也不许标脏。
 */
function reconcileAnimSelection(opts) {
  const o = opts || {};
  const v = STATE.doc.visual || (STATE.doc.visual = {});
  let tier = v.animMode === 'molang' ? 'molang' : 'keyframe';
  const cur = MCS_MODELPREVIEW.selectedEntry();
  let pick = (cur && animTierOf(cur) === tier) ? cur : null;
  let found = null;

  if (!pick && v.animName) {
    found = MCS_MODELPREVIEW.find(v.animName, v.animFile || null);
    if (found) {
      // 文档里选中的动画属于另一档 → 档位跟着它走。否则会出现「这一档列表里没选中任何
      // 一条，画布上却在播」的矛盾（导入 .animation.json 时自动选最长那条也会撞上）。
      if (animTierOf(found) !== tier) { v.animMode = animTierOf(found); tier = v.animMode; }
      pick = found;
    }
  }
  if (!pick && STATE.animSel[tier]) {
    pick = animListFor(tier).find((e) => animKey(e) === STATE.animSel[tier]) || null;
  }
  MCS_MODELPREVIEW.select(pick);
  if (pick) STATE.animSel[tier] = animKey(pick);
  if (o.persist !== false) writeAnimFields(pick, true);
  if (STATE.visualMode === 'model' && MCS_MODELPREVIEW.scene) MCS_MODELPREVIEW.render(STATE.playheadMs || 0);
  renderAnimPanel();
  applyPlayMode();
  return pick;
}

// ---------------------------------------------------------------------------
// 播放方式（规格 §2.3）：跟随播放头（默认）/ 独立预览
//   独立预览 = 在调整页自己循环播这条动画，**不动时间轴播放头**。
// 铁律：它只决定「这一刻画什么」，不碰 STATE.playheadMs / 传输状态 / GIF 同步。
// ---------------------------------------------------------------------------
let ANIM_PREVIEW_RAF = null;
let ANIM_PREVIEW_MS = 0;

function stopAnimPreview() {
  if (ANIM_PREVIEW_RAF) { cancelAnimationFrame(ANIM_PREVIEW_RAF); ANIM_PREVIEW_RAF = null; }
}

/** 按当前 playMode 起停独立预览（幂等；不在调整页 / 没模型 / 没选动画时一律不起） */
function applyPlayMode() {
  stopAnimPreview();
  if (currentView().playMode !== 'standalone') return 'follow';
  if (STATE.step !== 'adjust' || STATE.visualMode !== 'model'
      || !MCS_MODELPREVIEW.scene || !MCS_MODELPREVIEW.tracks) return 'idle';
  ANIM_PREVIEW_MS = 0;
  const tick = () => {
    ANIM_PREVIEW_RAF = null;
    if (currentView().playMode !== 'standalone' || STATE.step !== 'adjust'
        || STATE.visualMode !== 'model' || !MCS_MODELPREVIEW.tracks) return;
    if (STATE.transport === 'playing' || STATE.transport === 'scrubbing') {
      ANIM_PREVIEW_RAF = requestAnimationFrame(tick);   // 正在播放：让播放头说了算，不跟它抢画布
      return;
    }
    const len = MCS_MODELPREVIEW.tracks.lengthMs || 0;
    ANIM_PREVIEW_MS = len > 0 ? (ANIM_PREVIEW_MS + 16) % len : 0;
    MCS_MODELPREVIEW.render(ANIM_PREVIEW_MS);
    ANIM_PREVIEW_RAF = requestAnimationFrame(tick);
  };
  ANIM_PREVIEW_RAF = requestAnimationFrame(tick);
  return 'standalone';
}

/** 切播放方式（写进工程文件 playMode） */
function setPlayMode(mode, opts) {
  const o = opts || {};
  const next = mode === 'standalone' ? 'standalone' : 'follow';
  const before = currentView().playMode;
  writeView({ playMode: next });
  STATE.doc.visual.playMode = next;
  if (before !== next && o.mark !== false) markDirty('animPlay');
  const a = applyPlayMode();
  renderAnimPanel();
  if (before !== next && !o.quiet) {
    status(next === 'standalone'
      ? '播放方式：独立预览 —— 调整页自己循环播这条动画，时间轴播放头不动'
      : '播放方式：跟随时间轴播放头 —— 拖标尺 / 播放都能看姿态',
      next === 'standalone' ? '切到「② 音效」页会自动停' : '');
  }
  return a;
}

/** 动画一栏的接线（幂等）：两档按钮 / 导入动画 / 列表点击 / 播放方式 */
function setupAnimPanel() {
  if (setupAnimPanel._done) return 'already';
  setupAnimPanel._done = true;
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('btnAnimModeKey', () => setAnimTier('keyframe'));
  on('btnAnimModeMolang', () => setAnimTier('molang'));
  on('btnAnimImport', () => { const b = $('btnImportAnim'); if (b) b.click(); });
  on('btnPlayModeFollow', () => setPlayMode('follow'));
  on('btnPlayModeStandalone', () => setPlayMode('standalone'));
  const list = $('animList');
  if (list) {
    list.addEventListener('click', (e) => {
      const row = (e.target && e.target.closest) ? e.target.closest('.anim-row') : null;
      if (!row || !row.dataset.animKey) return;
      selectAnimByKey(row.dataset.animKey);
    });
  }
  renderAnimPanel();
  return 'wired';
}

// 撤销 / 重做：走仓库已有的通用撤销栈（卡 t_6b99a1fd，见下面「通用撤销 / 重做」一节）。
// 新动作只要照旧调 markDirty(kind)，就自动进栈；连续手势用
// beginUndoBatch(kind) / endUndoBatch() 包起来，整段只占一步。
// 卡 t_47b9fab2 新增的动作因此分别用 'resize'（改长度＝等比变速）、
// 'trim'（Alt 非破坏性裁剪）、'param'（属性面板里的淡入淡出 / 裁剪起止）。

// ---------------------------------------------------------------------------
// 收藏持久化（localStorage）
// ---------------------------------------------------------------------------
const FAV_KEY = 'mcsound.favorites.v1';
function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (raw) STATE.favorites = new Set(JSON.parse(raw));
  } catch (e) { /* 忽略 */ }
}
function saveFavorites() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(STATE.favorites))); }
  catch (e) { /* 忽略 */ }
}

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function fmtMs(ms) {
  return Math.round(ms) + 'ms';
}
function fmtTime(ms) {
  const t = Math.round(ms);
  const s = Math.floor(t / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`;
}
// ---------------------------------------------------------------------------
// 状态栏文案的生命周期（卡 t_7cdeea89）
//   左侧 =「现在发生了什么」；右侧 = 辅助信息（文件路径、来源，或一次性提示）。
//   一次性提示（用 statusHint 写）只在那一瞬间成立，状态一过就必须消失，
//   否则同一行左右两句会互相矛盾。本轮修的两条正是这个毛病：
//     · 播完后右侧挂着「再点 ▶ 从头播放」，点播放 / 点停止都还挂着；
//     · 播完后把播放头拖回中间，左侧还写着「播放结束，已停在末尾」。
// ---------------------------------------------------------------------------
// 播完停在末尾时左侧的原话。播放头离开末尾时靠它认出「这句已经过期了」。
const ENDED_STATUS_MSG = '播放结束，已停在末尾';
let statusRightIsHint = false;    // 右侧当前挂的是不是一次性提示
let statusShowsEnded = false;     // 左侧当前挂的是不是上面那句
let statusShowsPos = false;       // 左侧当前挂的是不是「已定位到 X.XXs」

/**
 * 写状态栏。right 省略 = 右侧保持原样（路径这类上下文信息要留住）；
 * 但如果右侧挂的是一次性提示，这里会把它清掉 —— 提示的寿命只到下一次状态栏更新。
 */
function status(msg, right) {
  $('statusMsg').textContent = msg;
  statusShowsEnded = msg === ENDED_STATUS_MSG;
  statusShowsPos = false;
  if (right !== undefined) {
    setStatusRight(right);         // 常规写法：右侧是「上下文信息」，不算一次性提示
  } else if (statusRightIsHint) {
    setStatusRight('');
  }
}

/** 写状态栏右侧；所有非提示文案都必须经这里，避免旧的提示标记误删新统计。 */
function setStatusRight(text, isHint = false) {
  statusRightIsHint = isHint;
  $('statusRight').textContent = text;
}

/**
 * 左侧「已定位到 X.XXs」。这句带具体时刻，播放头一动就得跟着改写 ——
 * 否则会出现"文字写着 2.99s、播放头实际在 1.20s"的新矛盾
 * （拖动是一串 move，只在第一次 move 写一次定值就会这样）。
 * 所以标了身份：updatePlayhead 里只要还挂着它，就按最新播放头刷新。
 */
function showPlayheadPos(ms) {
  status(`已定位到 ${(ms / 1000).toFixed(2)}s`);
  statusShowsPos = true;
}

/** 右侧「一次性提示」的入口：传输状态一变就会被 clearStatusHint / status 清掉 */
function statusHint(msg, right) {
  status(msg, right);
  statusRightIsHint = true;
}

/** 清掉右侧的一次性提示；路径这类需要常驻的右侧信息不动手 */
function clearStatusHint() {
  if (!statusRightIsHint) return;
  setStatusRight('');
}

// ---------------------------------------------------------------------------
// 试听失败反馈（卡 t_8c74ddef 第 1 条）
//   AudioEngine.playOne 在读不到音频文件时只 console.warn 然后 return null（**不抛异常**），
//   所以「await 完就写 试听：XXX」是说假话：包内音频被删、或解包目录被别的实例重新解包时，
//   用户点 ▶ 一点声音都没有，状态栏却写着「试听：蜡烛燃烧」——比没有反馈更糟。
//   以后所有试听入口都走 tryAudition()，返回 null 就写失败话术 + 给出「音频放哪」的引导。
// ---------------------------------------------------------------------------
/** 音频读不到时把状态栏做成可点的引导入口（点开「试听没有声音？」弹窗，里面有放音频的路径） */
function setAudioHelpClickable(on) {
  const bar = $('statusBar');
  if (!bar) return;
  if (on) {
    bar.classList.add('warn-clickable');
    bar.onclick = () => openAudioHelpModal();
  } else {
    bar.classList.remove('warn-clickable');
    bar.onclick = null;
  }
}

/**
 * 试听一个文件。playOne 失败返回 null、成功返回播放句柄；异常也一并吞成 null
 * （试听是「顺手听一下」，不该把异常抛到用户脸上，但必须如实报失败）。
 */
async function tryAudition(absPath, opts) {
  try {
    return await AudioEngine.playOne(absPath, opts);
  } catch (e) {
    console.warn('试听异常:', absPath, e);
    return null;
  }
}

/**
 * 试听失败（tryAudition 返回 null）时的状态栏：明确说没读到文件，并指向「音频放哪」的引导。
 * 右侧用 statusHint 写：它是「这一次失败」的一次性引导，下一次状态栏更新（例如恢复后又试听成功）
 * 必须跟着走，否则会留下「音频明明好了、右侧还写着点此查看怎么放音频」的过期文案。
 */
function statusAuditionFailed(label) {
  statusHint('试听失败：没读到音频文件（可能被删了）',
             (label ? label + ' · ' : '') + '点此查看怎么放音频');
  setAudioHelpClickable(true);
}

/** 试听成功：清掉上一次失败留下的可点告警（原版库整体缺失时保留 loadVanillaLibrary 的提示） */
function statusAuditionOk(msg, right) {
  status(msg, right);
  if (!STATE.audioMissing) setAudioHelpClickable(false);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
/** 总长的硬下限：顶栏输入框的 min 属性（200ms） */
const MIN_TOTAL_MS = 200;

/**
 * 已放音频片段的最晚结束时间（ms）。
 * 它是「总长的硬下限」：总长缩到它前面，最后那段音效就会被播放/播放头边界切掉 ——
 * 卡 t_6b99a1fd 的覆盖例就是这样：6000ms 总长里 5500ms 放了一段到 5800ms 的音效，
 * 总长必须停在 5800ms 而不是继续往下缩。
 */
function clipsMaxEndMs() {
  return STATE.doc.clips.reduce(
    (m, c) => Math.max(m, (c.startMs || 0) + (c.durationMs || 0)),
    0
  );
}

/** 总长下限（同时不低于输入框允许的最小值） */
function totalFloorMs() {
  return Math.max(MIN_TOTAL_MS, clipsMaxEndMs());
}

/**
 * 「总长」的唯一真相来源。
 *
 * 为什么不再让 visual.manualMs / visual.naturalMs 优先（卡 t_6b99a1fd）：
 *   以前这三个值里**任意一个**非空就盖过顶栏的「总长(ms)」，于是导入一次动画
 *   （会写 naturalMs）之后，用户在顶栏改总长完全不起作用 —— 播放边界、时间显示、
 *   灰尾几何全都还用那个旧的自然时长，用户看到的是「输入框变了、时间轴没变」。
 *   现在顶栏的「总长(ms)」是唯一真值；素材自身长度只是记录，不参与边界计算。
 *
 * 同时兜住下限：任何路径都不可能读到一个「短于最后一段音效结束时间」的总长。
 */
function totalMs() {
  return Math.max(Math.round(STATE.doc.config.totalMs) || 0, totalFloorMs());
}

// ---------------------------------------------------------------------------
// 选中集（多选）
//   STATE.selectedClipIds 是唯一的真相来源；STATE.selectedClipId 是「主选中」
//   （最近点中的那一个）。方向键 / D / Enter / M / S / Ctrl+↑↓ 都作用于主选中，
//   所以单选场景下的老行为完全不变。
// ---------------------------------------------------------------------------
function isSelected(id) { return !!id && STATE.selectedClipIds.has(id); }

/** 时间轴上的显示顺序：先按轨道，再按起点（Shift 范围选中用它排序） */
function orderedClips() {
  const ti = new Map(STATE.doc.tracks.map((t, i) => [t.name, i]));
  return STATE.doc.clips.slice().sort((a, b) => {
    const ta = ti.has(a.track) ? ti.get(a.track) : 999;
    const tb = ti.has(b.track) ? ti.get(b.track) : 999;
    return ta - tb || a.startMs - b.startMs;
  });
}

/** 设置选中集；primary 不在集里时取集内第一个当主选中 */
function setSelection(ids, primary) {
  const set = new Set();
  for (const id of ids || []) {
    if (STATE.doc.clips.some((c) => c.id === id)) set.add(id);
  }
  STATE.selectedClipIds = set;
  if (primary && set.has(primary)) STATE.selectedClipId = primary;
  else STATE.selectedClipId = set.size ? Array.from(set)[0] : null;
  return set;
}

function clearSelection() { return setSelection([], null); }

/** Ctrl/Cmd+点击：加入 / 移出选中集 */
function toggleSelection(id) {
  if (STATE.selectedClipIds.has(id)) STATE.selectedClipIds.delete(id);
  else STATE.selectedClipIds.add(id);
  STATE.selectedClipId = STATE.selectedClipIds.has(id)
    ? id
    : (STATE.selectedClipIds.size ? Array.from(STATE.selectedClipIds)[0] : null);
  return STATE.selectedClipIds.size;
}

/** Shift+点击：从主选中到该片段之间整段加选 */
function selectRangeTo(id) {
  const list = orderedClips();
  const a = list.findIndex((c) => c.id === (STATE.selectedClipId || id));
  const b = list.findIndex((c) => c.id === id);
  if (a < 0 || b < 0) return setSelection([id], id);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const ids = new Set(STATE.selectedClipIds);
  for (let i = lo; i <= hi; i++) ids.add(list[i].id);
  return setSelection(ids, id);
}

function selectedClips() {
  return orderedClips().filter((c) => STATE.selectedClipIds.has(c.id));
}

/** 选中集覆盖的时间范围（状态栏 / 属性面板提示用） */
function selectionRangeMs() {
  const s = selectedClips();
  if (!s.length) return null;
  let a = Infinity;
  let b = -Infinity;
  for (const c of s) {
    a = Math.min(a, c.startMs);
    b = Math.max(b, c.startMs + c.durationMs);
  }
  return { from: a, to: b };
}

/** 状态栏统一话术：选中了几个片段、能不能整体操作 */
function selectionStatus(prefix) {
  const s = selectedClips();
  if (!s.length) { status('没有选中的片段'); return; }
  const r = selectionRangeMs();
  status(`${prefix || '已选中'} ${s.length} 个片段` +
    (s.length > 1
      ? `（${(r.from / 1000).toFixed(3)}s → ${(r.to / 1000).toFixed(3)}s，可整体拖动 / Ctrl+C 复制 / Del 删除）`
      : ''));
}

// ---------------------------------------------------------------------------
// 音效库
// ---------------------------------------------------------------------------
//
// 库里的条目有两类：
//   A. 原版事件（来自 sounds/vanilla/library.json）
//      { kind:'event', event:'dig.stone', category:'block', variants:[{file,absPath,volume,pitch}], ... }
//      拖到时间轴时，默认写「事件名」——游戏会自己随机选变体（原版行为）。
//      也可以在展开列表里锁定某一个变体。
//   B. 普通文件（内置占位音 / 用户扫描 / 用户拖入）
//      { kind:'file', name, absPath, relPath, ext, size }
//
function renderLibrary() {
  const kw = ($('inpSearch').value || '').trim().toLowerCase();
  const list = $('soundList');
  const EV = window.MCS_EVENTS;

  const searching = !!kw;
  let items = STATE.library;
  if (searching) {
    items = items.filter((s) => {
      const parts = s.kind === 'event'
        ? [s.event, s.category, s.desc || '', (s.variants || []).map((v) => v.file).join(' ')]
        : [s.name, s.relPath || ''];
      return parts.join(' ').toLowerCase().includes(kw);
    });
  }

  // 收藏是逻辑副本：收藏区展示一份快捷引用，原分类里仍必须保留原条目。
  // 不能把收藏项从 rest 里排除，否则用户一收藏就会以为原文件/原分类被移动或删除。
  const favs = items.filter((s) => STATE.favorites.has(keyOf(s)));
  const rest = items;

  const html = [];

  if (!items.length) {
    list.innerHTML = `<div class="empty-hint">${
      STATE.library.length
        ? '没有匹配的音效'
        : '点「原版库」加载原版音效事件，<br>或「扫描…」选择你自己的音效文件夹。<br><br>直接拖到右侧轨道上即可。'
    }</div>`;
    return;
  }

  // 搜索时全部展开（否则搜不到东西很困惑）
  const isOpen = (gid) => searching || STATE.openGroups.has(gid);

  // —— 收藏分组 ——
  // 搜索时为 0 但确实有收藏时，给一行说明，否则用户会以为收藏丢了
  if (favs.length) {
    html.push(collapsibleHead('fav', '★ 收藏', favs.length, isOpen('fav')));
    html.push(`<div class="group-body" data-group="fav"${isOpen('fav') ? '' : ' hidden'}>`);
    if (isOpen('fav')) for (const it of favs) html.push(renderItem(it, EV));
    html.push('</div>');
  } else if (searching && STATE.favorites.size) {
    html.push(collapsibleHead('fav', `★ 收藏（${STATE.favorites.size} 项被搜索条件隐藏）`, 0, false));
    html.push(`<div class="group-body" data-group="fav" hidden></div>`);
  }

  // —— 原版事件：分类 → 子类（任意层深，卡 t_3623451f）——
  const evItems = rest.filter((x) => x.kind === 'event');
  const fileItems = rest.filter((x) => x.kind !== 'event');

  if (evItems.length) {
    const byCat = new Map();
    for (const it of evItems) {
      const c = EV.fixedCategory(it.event, it.category);
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(it);
    }

    const sortedCats = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [c, arr] of sortedCats) {
      const gid = 'cat:' + c;
      const open = isOpen(gid);
      const catLabel = EV.CATEGORY_LABEL[c] || c;
      html.push(collapsibleHead(gid, '原版 · ' + catLabel, arr.length, open, 1));
      html.push(`<div class="group-body" data-group="${esc(gid)}"${open ? '' : ' hidden'}>`);

      if (open) renderSubGroups(html, arr, c, gid, 2, isOpen, EV);
      html.push('</div>');
    }
  }

  // —— 普通文件 ——
  if (fileItems.length) {
    const groups = new Map();
    for (const it of fileItems) {
      const parts = (it.relPath || it.name).split('/');
      const g = parts.length > 1 ? parts[0] : '（根目录）';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    for (const [g, arr] of groups) {
      const gid = 'dir:' + g;
      const open = isOpen(gid);
      html.push(collapsibleHead(gid, g, arr.length, open));
      html.push(`<div class="group-body" data-group="${esc(gid)}"${open ? '' : ' hidden'}>`);
      if (open) for (const it of arr.slice(0, 400)) html.push(renderItem(it, EV));
      html.push('</div>');
    }
  }

  list.innerHTML = html.join('');
  bindLibraryEvents(list, EV);
}

/**
 * 渲染一个分类下的子类树（卡 t_3623451f）。
 *
 * 为什么不是「写死两层」：子类路径长度不一 —— 生物是 分类→生物，方块是 分类→玩法域，
 * 物品使用是 分类→物品使用→族（三级）。统一按「路径」建树、递归渲染，加规则不用改这里。
 *
 * gid 里带上父级路径（cat:block/dom:place），保证「展开状态」在刷新后仍然对得上，
 * 也保证不同分类下的同名子类（比如方块/玩家都有「脚步」）不会共用折叠状态。
 */
function renderSubGroups(html, arr, category, parentGid, depth, isOpen, EV) {
  const G = window.MCS_LIBGROUPS;
  // 没有分组规则（或库没加载）时保持老行为：平铺 + 400 条截断
  if (!G) {
    for (const it of arr.slice(0, 400)) html.push(renderItem(it, EV));
    if (arr.length > 400) {
      html.push(`<div class="empty-hint">… 还有 ${arr.length - 400} 个，请用搜索缩小范围</div>`);
    }
    return;
  }

  const root = { children: new Map(), items: [], count: 0 };
  for (const it of arr) {
    const path = G.pathOf(it.event, category);
    let node = root;
    let gid = parentGid;
    path.forEach((step, i) => {
      gid = gid + '/' + step.key;
      if (!node.children.has(step.key)) {
        node.children.set(step.key, {
          key: step.key, label: step.label, gid, depth: depth + i,
          children: new Map(), items: [], count: 0,
        });
      }
      node = node.children.get(step.key);
      node.count++;                 // 祖先也要计数：父组显示的是「这一组有多少条」
    });
    node.items.push(it);
  }

  const renderItems = (items) => {
    for (const it of items.slice(0, 400)) html.push(renderItem(it, EV));
    if (items.length > 400) {
      html.push(`<div class="empty-hint">… 还有 ${items.length - 400} 个，请用搜索缩小范围</div>`);
    }
  };

  const renderNodes = (node, isRoot) => {
    const kids = [...node.children.values()].sort((a, b) => b.count - a.count);
    for (const n of kids) {
      // 有名字的组一律给折叠头（哪怕它是个「叶子组」，比如 方块 → 放置 56）：
      // 只在子节点才给头、叶子直接铺条目的话，域名的分组就白建了。
      const open = isOpen(n.gid);
      html.push(collapsibleHead(n.gid, n.label, n.count, open, n.depth));
      html.push(`<div class="group-body" data-group="${esc(n.gid)}"${open ? '' : ' hidden'}>`);
      if (open) {
        if (n.children.size) renderNodes(n, false);
        else renderItems(n.items);
      }
      html.push('</div>');
    }
    // 根节点上挂着的条目 = 没有子类归属的（如生物分类里 themeOf 返回 null 的），直接列出来
    if (isRoot) renderItems(node.items);
  };

  renderNodes(root, true);
}

/**
 * 搜索框右侧的「清空」按钮（卡 t_3623451f）。
 *
 * 三条要求：只在有文字时出现、鼠标能点、键盘也能用。
 *   · 显示条件只看输入框自己有没有内容（不 trim：敲了空格也是「有文字」，
 *     用户按 Esc 或点 ✕ 就能清掉，不会出现「框里有东西却按钮不见了」）；
 *   · 按钮是原生 <button>，鼠标点、Tab 聚焦后回车/空格都触发；
 *   · 输入框里额外挂 Esc —— 手不离键盘就能清空。
 */
function updateSearchClear() {
  const inp = $('inpSearch');
  const btn = $('btnClearSearch');
  if (!inp || !btn) return;
  const has = inp.value.length > 0;
  btn.hidden = !has;
  // 有内容时给一句可发现的提示（按钮本身很小，标题是它的说明）
  btn.title = has ? `清空搜索「${inp.value}」(Esc)` : '清空搜索（Esc）';
}

function clearSearchInput(opts) {
  const inp = $('inpSearch');
  if (!inp) return;
  const had = inp.value;
  inp.value = '';
  updateSearchClear();
  renderLibrary();
  if (!(opts && opts.silent)) {
    status(had ? '已清空搜索' : '搜索框本来就是空的');
  }
  if (!(opts && opts.noFocus)) inp.focus();
}

function setupSearchClear() {
  const btn = $('btnClearSearch');
  const inp = $('inpSearch');
  if (btn) {
    // mousedown 前先 preventDefault：点按钮时输入框不失焦，清完继续打字
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => { e.stopPropagation(); clearSearchInput(); });
  }
  if (inp) {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && inp.value.length) {
        e.preventDefault();
        // 卡 t_4e96920b：不能让事件继续冒泡到 window 的全局 Esc 处理器 ——
        // 那个处理器会 clearSelection() 并写「已取消选中」，把这里刚写的
        // 「已清空搜索」盖掉，用户以为刚才操作的是片段选择。清空只发生在
        // 「框里有字」时，所以框空着按 Esc 仍然照旧走全局（取消选中/关弹窗）。
        e.stopPropagation();
        clearSearchInput();
      }
    });
  }
  updateSearchClear();
}

/** 稳定 key，用于收藏 */
function keyOf(it) {
  return it.kind === 'event' ? 'ev:' + it.event : 'f:' + it.absPath;
}

/** 折叠标题 */
function collapsibleHead(gid, label, count, open, depth) {
  const chev = open ? '▾' : '▸';
  return `<div class="group-head" data-toggle="${esc(gid)}" data-depth="${depth || 1}">
    <span class="gh-chev">${chev}</span>
    <span class="gh-label">${esc(label)}</span>
    <span class="gh-count">${count}</span>
  </div>`;
}

/** 单个条目 */
function renderItem(it, EV) {
  const isEvent = it.kind === 'event';
  const k = keyOf(it);
  const isFav = STATE.favorites.has(k);
  const vc = isEvent ? (it.variantCount || (it.variants || []).length) : 0;
  const cat = isEvent ? EV.fixedCategory(it.event, it.category) : '';

  // 描述：中文名（原版事件）
  const desc = isEvent ? (it.desc || it.event) : (it.name || '');
  const sub = isEvent ? it.event : (it.relPath || '');

  // 变体角标：悬停弹出变体列表
  const vBadge = (isEvent && vc > 1)
    ? `<span class="si-var" data-variants="${esc(it.event)}" title="悬停查看 ${vc} 个变体">×${vc}</span>`
    : '';

  return `<div class="sound-item${isEvent ? ' is-event' : ''}" draggable="true"
        data-kind="${isEvent ? 'event' : 'file'}"
        data-event="${esc(it.event || '')}"
        data-cat="${esc(cat)}"
        data-vc="${vc}"
        data-desc="${esc(desc)}"
        data-path="${esc(isEvent ? ((it.variants && it.variants[0] && it.variants[0].absPath) || '') : it.absPath)}"
        data-name="${esc(it.name || '')}"
        data-ext="${esc(it.ext || '')}"
        data-key="${esc(k)}">
      <span class="si-name">
        <span class="si-desc">${esc(desc)}</span>
        ${isEvent ? `<span class="si-id">${esc(sub)}</span>` : ''}
      </span>
      ${vBadge}
      <button class="si-fav${isFav ? ' on' : ''}" data-fav="${esc(k)}"
              title="${isFav ? '取消收藏' : '收藏（收藏后置顶在「★ 收藏」）'}">${isFav ? '★' : '☆'}</button>
      <button class="si-play" title="试听这个音效">▶</button>
    </div>`;
}

/** 绑定折叠 / 拖拽 / 试听 / 收藏 / 变体悬浮 */
function bindLibraryEvents(list, EV) {
  // 折叠：记录状态后整体重渲染（简单可靠，库也就一千来条，够快）
  list.querySelectorAll('.group-head').forEach((h) => {
    h.addEventListener('click', () => {
      const gid = h.dataset.toggle;
      if (STATE.openGroups.has(gid)) STATE.openGroups.delete(gid);
      else STATE.openGroups.add(gid);
      renderLibrary();
    });
  });

  // 条目
  list.querySelectorAll('.sound-item').forEach((el) => {
    // 拖拽
    el.addEventListener('dragstart', (e) => {
      if (el.dataset.kind === 'event') {
        e.dataTransfer.setData('application/x-mcs-event', JSON.stringify({
          event: el.dataset.event,
          category: el.dataset.cat,
          variantCount: Number(el.dataset.vc) || 1,
          // 时间轴标签沿用音效库的可读名称；soundId 仍是稳定的原版事件 key。
          label: el.dataset.desc || el.dataset.event,
        }));
      } else {
        e.dataTransfer.setData('application/x-mcs-sound', JSON.stringify({
          path: el.dataset.path,
          name: el.dataset.name,
          ext: el.dataset.ext,
        }));
      }
      e.dataTransfer.effectAllowed = 'copy';
    });

    // 收藏
    const favBtn = el.querySelector('.si-fav');
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const k = el.dataset.key;
      if (STATE.favorites.has(k)) STATE.favorites.delete(k);
      else STATE.favorites.add(k);
      saveFavorites();
      renderLibrary();
    });

    // 试听（单例：先停掉上一个）
    const playBtn = el.querySelector('.si-play');
    playBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const label = el.dataset.desc || el.dataset.name || el.dataset.event;
      if (el.dataset.kind === 'event') {
        const v = EV.pickVariant(el.dataset.event, null);
        if (!v) { status('该事件没有可用音频文件'); return; }
        const h = await tryAudition(v.absPath, {
          volume: v.volume != null ? v.volume : 1,
          pitch: v.pitch != null ? v.pitch : 1,
        });
        // playOne 读不到文件时返回 null（不抛异常）：不能照写成功话术
        if (!h) { statusAuditionFailed(label); return; }
        const idx = EV.getVariants(el.dataset.event).findIndex((x) => x.file === v.file);
        statusAuditionOk(`试听：${label}`,
               `变体 ${idx + 1}/${EV.getVariants(el.dataset.event).length} · ${v.file}`);
      } else {
        const h = await tryAudition(el.dataset.path, { volume: 1, pitch: 1 });
        if (!h) { statusAuditionFailed(label); return; }
        statusAuditionOk('试听：' + label);
      }
    });
  });

  // 变体角标：悬停弹出变体面板
  list.querySelectorAll('.si-var').forEach((badge) => {
    let pop = null;
    let hideTimer = null;

    const build = () => {
      const evName = badge.dataset.variants;
      const vs = EV.getVariants(evName);
      const rows = vs.map((v, i) => `
        <div class="vp-row" data-path="${esc(v.absPath)}" data-idx="${i}"
             data-vol="${v.volume != null ? v.volume : 1}"
             data-pitch="${v.pitch != null ? v.pitch : 1}">
          <span class="vp-idx">${i + 1}</span>
          <span class="vp-file">${esc(v.file)}</span>
          <span class="vp-play">▶</span>
        </div>`).join('');
      return `<div class="variant-pop">
          <div class="vp-head">${vs.length} 个变体 · 游戏内随机播放</div>
          <div class="vp-list">${rows}</div>
        </div>`;
    };

    const show = () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (pop) return;
      const total = EV.getVariants(badge.dataset.variants).length;
      const wrap = document.createElement('div');
      wrap.className = 'variant-pop-wrap';
      wrap.innerHTML = build();
      document.body.appendChild(wrap);
      const r = badge.getBoundingClientRect();
      pop = wrap;
      const pr = wrap.getBoundingClientRect();
      let top = r.bottom + 4;
      if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 4);
      wrap.style.top = top + 'px';
      wrap.style.left = Math.min(r.left, window.innerWidth - pr.width - 8) + 'px';

      wrap.addEventListener('mouseenter', show);
      wrap.addEventListener('mouseleave', scheduleHide);
      wrap.querySelectorAll('.vp-row').forEach((row) => {
        row.addEventListener('click', async (e) => {
          e.stopPropagation();
          const h = await tryAudition(row.dataset.path, {
            volume: Number(row.dataset.vol) || 1,
            pitch: Number(row.dataset.pitch) || 1,
          });
          const fn = row.querySelector('.vp-file').textContent;
          if (!h) { statusAuditionFailed(`变体 ${Number(row.dataset.idx) + 1} ${fn}`); return; }
          statusAuditionOk(`试听变体 ${Number(row.dataset.idx) + 1}/${total}`, fn);
        });
      });
    };

    const scheduleHide = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (pop) { pop.remove(); pop = null; }
      }, 220);
    };

    badge.addEventListener('mouseenter', show);
    badge.addEventListener('mouseleave', scheduleHide);
  });
}

// 加载原版音效库（事件形式，含变体 + 中文描述）
async function loadVanillaLibrary() {
  // 首次加载库的耗时（卡 t_20c2e144）：从「点按钮」到「列表可交互」的墙钟时间，
  // 含主进程读 1.3MB 索引 + 路径重绑 + 渲染列表。只记第一次 —— 之后是增量刷新。
  const loadT0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const r = await window.mcs.loadVanillaLibrary();
  if (!r.ok) { status('未找到原版音效库：' + r.error); return; }

  // 载入描述表
  const d = await window.mcs.loadVanillaDescriptions();
  const descs = (d && d.ok && d.descriptions) ? d.descriptions : {};

  // 让 event-audio.js 拿到库（供变体解析用）
  window.MCS_EVENTS.setLibrary(r.library);

  const evts = (r.library.events || []).map((e) => ({
    kind: 'event',
    event: e.event,
    category: e.category,
    desc: descs[e.event] || e.event,
    variantCount: e.variantCount,
    hasVariants: e.hasVariants,
    minDistance: e.minDistance,
    maxDistance: e.maxDistance,
    variants: e.variants,
  }));

  STATE.library = STATE.library.filter((x) => x.kind !== 'event').concat(evts);
  renderLibrary();
  const withDesc = evts.filter((e) => descs[e.event]).length;
  status(`已加载原版音效库：${evts.length} 个事件 / ${r.library.variantCount} 个变体`,
         `${withDesc} 个带中文描述`);

  // 记下这次加载的真实规模与耗时（卡 t_20c2e144）——「导出系统信息」里那两行
  // 可核对的坐标就是这里来的，不猜、不写死。耗时只在第一次记（后续是增量刷新）。
  const loadMs = Math.round(((typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now()) - loadT0);
  if (STATE.libraryLoadMs == null) STATE.libraryLoadMs = loadMs;
  STATE.libraryMeta = { events: evts.length, variants: r.library.variantCount, withDesc, loadMs };

  // 音频目录不可用时明确提示：元数据能用，但试听会没声音。
  // 不说清楚的话用户会以为程序坏了。
  const as = r.audioStatus;
  if (as && !as.ok) {
    STATE.audioMissing = as;
    STATE.audioDir = as.dir || STATE.audioDir || '';
    status(`音效库已加载，但试听音频未就位（${evts.length} 个事件仍可拖拽和导出）`,
           '点此查看怎么放音频');
    setAudioHelpClickable(true);
    renderLibrary();
  } else if (as && as.ok) {
    STATE.audioMissing = null;
    // 记住「音频本该在哪」：运行中音频被删/被移走时，引导弹窗还要能给出这个路径
    STATE.audioDir = as.dir || STATE.audioDir || '';
    setAudioHelpClickable(false);
  }
}

async function loadBundled() {
  const r = await window.mcs.getBundledSoundsDir();
  if (!r.ok) { status('未找到内置音效库：' + r.error); return; }
  const s = await window.mcs.scanSoundDir(r.path);
  if (!s.ok) { status('扫描失败：' + s.error); return; }
  addToLibrary(s.files.map((f) => Object.assign({ kind: 'file', group: '内置' }, f)));
  status(`已加载内置音效库：${s.files.length} 个文件`, r.path);
}

async function scanFolder() {
  const d = await window.mcs.pickDirectory();
  if (!d.ok) return;
  const s = await window.mcs.scanSoundDir(d.path);
  if (!s.ok) { status('扫描失败：' + s.error); return; }
  addToLibrary(s.files);
  status(`已扫描：${s.files.length} 个音频文件`, d.path);
}

async function addFiles() {
  const r = await window.mcs.pickFiles({
    title: '选择音频文件',
    filters: [{ name: '音频', extensions: ['ogg', 'wav', 'mp3', 'flac', 'm4a', 'fsb'] }],
  });
  if (!r.ok) return;
  const files = r.paths.map((p) => {
    const parts = p.replace(/\\/g, '/').split('/');
    const fname = parts[parts.length - 1];
    const ext = '.' + fname.split('.').pop().toLowerCase();
    return {
      name: fname.slice(0, -(ext.length)),
      relPath: fname,
      absPath: p,
      ext,
      size: 0,
    };
  });
  addToLibrary(files);
  status(`已添加 ${files.length} 个音频文件`);
}

function addToLibrary(files) {
  const seen = new Set(STATE.library.map((s) => s.absPath));
  let added = 0;
  for (const f of files) {
    if (!seen.has(f.absPath)) {
      STATE.library.push(f);
      seen.add(f.absPath);
      added++;
    }
  }
  // 新加入的文件夹分组自动展开 —— 否则用户点了「+文件」看不到任何变化，
  // 会以为导入失败（尤其是原版库已加载、列表很长的时候）
  if (added) {
    const groups = new Set(
      files.map((f) => {
        const parts = String(f.relPath || f.name).split('/');
        return 'dir:' + (parts.length > 1 ? parts[0] : '（根目录）');
      })
    );
    for (const g of groups) STATE.openGroups.add(g);
  }
  renderLibrary();
  return added;
}

// ---------------------------------------------------------------------------
// 时间轴渲染
// ---------------------------------------------------------------------------
/**
 * 给片段画波形。
 * 先同步画缓存（避免每次重绘都闪一下），缓存没有就异步解码后补画。
 * 片段很窄时（<18px）不画，画了也看不清，只留颜色块。
 */
function paintClipWave(el, clip) {
  const cv = el.querySelector('.c-wave');
  if (!cv || !window.MCS_WAVE) return;

  const w = Math.round(el.getBoundingClientRect().width || 0);
  if (w < 18) { cv.style.display = 'none'; return; }
  cv.style.display = 'block';

  const resolved = resolveClipAudio(clip);
  if (!resolved || !resolved.absPath) {
    // 拿不到音频文件：只画中轴线，明确表示「这个片段没有可用音频」
    window.MCS_WAVE.drawWaveform(cv, null, { width: w, height: el.clientHeight });
    return;
  }

  // 用 CSS 像素做桶数上限，够用又不浪费
  const buckets = Math.max(24, Math.min(w, 2000));
  const path = resolved.absPath;

  const cached = window.MCS_WAVE.getCachedPeaks(path, buckets);
  if (cached) {
    window.MCS_WAVE.drawWaveform(cv, cached, { width: w, height: el.clientHeight });
    return;
  }

  window.MCS_WAVE.drawWaveform(cv, null, { width: w, height: el.clientHeight });

  window.MCS_WAVE.getPeaks(path, buckets).then((peaks) => {
    // 元素可能已经被重绘替换掉了，画之前确认还在文档里
    if (!cv.isConnected) return;
    if (cv.getBoundingClientRect().width < 18) return;
    window.MCS_WAVE.drawWaveform(cv, peaks, {
      width: Math.round(cv.getBoundingClientRect().width),
      height: cv.clientHeight,
    });
  });
}

function renderTimeline() {
  const cfg = STATE.doc.config;
  // 片段被拖到总长之外时先把总长顶上去：总长永远是「真实边界」，
  // 否则片段会落在边界之外，出现「看得见却播不到」的自相矛盾（卡 t_6b99a1fd）
  syncTotalBoundary();
  const total = totalMs();
  const pxPerMs = STATE.zoom;

  // 轨道区宽度除了「配置的总长」，还要容纳所有已放置的片段。
  // 否则把音效拖到总长之外时，片段虽然存在、能导出，却因为超出可视宽度
  // 而完全不渲染 —— 用户会以为拖丢了，只看到一条校验警告。
  const furthest = STATE.doc.clips.reduce(
    (m, c) => Math.max(m, (c.startMs || 0) + (c.durationMs || 0)),
    0
  );
  // 内容实际需要多宽（不含下面那个「至少 600px」的兜底）——
  // 灰尾要画到「内容末尾」为止，不能画到兜底 600px 之外，否则时间轴总长==GIF 时
  // 也会冒出一条灰尾，看着像 GIF 被截断了。
  // 定义收在 contentWidthPx() 里：灰尾几何（tailShadeGeom）和越尾徽标的文案都用它，
  // 免得两处各算一份、哪天改歪了徽标就会去说一条不存在的灰尾。
  const contentW = contentWidthPx();
  const W = Math.max(contentW, 600);

  // ---- 标尺 ----
  const ruler = $('ruler');
  ruler.style.width = W + 'px';
  const ticks = [];
  const step = chooseRulerStep(pxPerMs);
  // 刻度要画满整条可见宽度（W），而不是只画到 total —— 片段可以超出总长，
  // 超出部分如果没刻度，用户就看不出它落在第几秒。
  const maxMs = Math.max(total, furthest);
  for (let ms = 0; ms <= maxMs; ms += step) {
    const x = ms * pxPerMs;
    const isMajor = (ms % (step * 5) === 0);
    ticks.push(`<div class="ruler-tick${isMajor ? ' major' : ''}" style="left:${x}px">${isMajor ? fmtMs(ms) : ''}</div>`);
  }
  // BPM 拍线
  if (cfg.bpm > 0 && $('chkBeats').checked) {
    const beatMs = 60000 / cfg.bpm;
    const barMs = beatMs * (cfg.beatsPerBar || 4);
    for (let ms = 0; ms <= total; ms += beatMs) {
      const isBar = Math.abs((ms / barMs) - Math.round(ms / barMs)) < 1e-6;
      ticks.push(`<div class="${isBar ? 'ruler-bar' : 'ruler-beat'}" style="left:${ms * pxPerMs}px"></div>`);
    }
  }
  ruler.innerHTML = ticks.join('');
  // ---- 总长边界条（卡 t_6b99a1fd）----
  // 「[]」形式的边界：右括号 = 抓手（拖它改总长），左括号标出「时间轴从 0 开始」。
  // 抓手挂在标尺条里，而不是轨道区：轨道区里那些位置要留给片段拖动，
  // 一个压在片段上的抓手会把「点片段」抢走。轨道区里另画一条只看不摸的边界线（#totalEdge）。
  ruler.appendChild(makeTotalGrip(total * pxPerMs, total));

  // ---- 轨道 ----
  const lanes = $('laneArea');
  const labels = $('trackLabelList');
  lanes.style.width = W + 'px';

  // 网格背景在 CSS 里做不到随缩放变化，用 inline style 覆盖
  const gridPx = window.MCS.effectiveGridMs(cfg) * pxPerMs;

  const anySolo = STATE.doc.tracks.some((t) => t.solo);

  labels.innerHTML = trackLabelHtml();

  lanes.innerHTML = STATE.doc.tracks.map((t) => {
    const dim = anySolo && !t.solo;
    return `<div class="lane${dim ? ' solo-dim' : ''}" data-track="${esc(t.name)}"
                 style="background-size:${gridPx}px 100%"></div>`;
  }).join('');

  // 灰尾属于完整轨道内容而不是滚动视口：轨道较多时纵向滚动，
  // 它仍会覆盖当前可见的每一条轨道。这里会清空 laneArea，因此每次重绘都重建。
  const tailShade = document.createElement('div');
  tailShade.id = 'tailShade';
  lanes.appendChild(tailShade);

  // ---- 片段 ----
  for (const c of STATE.doc.clips) {
    let lane = lanes.querySelector(`.lane[data-track="${CSS.escape(c.track)}"]`);
    // 容错：片段引用了不存在的轨道时，补建轨道而不是静默丢弃
    if (!lane) {
      if (!STATE.doc.tracks.some((t) => t.name === c.track)) {
        STATE.doc.tracks.push(makeTrack(c.track, { label: c.track }));
      }
      const dim2 = anySolo && !c.track;
      const div = document.createElement('div');
      div.className = 'lane' + (dim2 ? ' solo-dim' : '');
      div.dataset.track = c.track;
      div.style.backgroundSize = gridPx + 'px 100%';
      lanes.appendChild(div);
      lane = div;
    }
    const el = document.createElement('div');
    const sel = isSelected(c.id);
    el.className = 'clip' + (sel ? ' selected' : '')
      + (sel && c.id === STATE.selectedClipId ? ' primary' : '')
      + (c.locked ? ' locked' : '');
    el.dataset.clipId = c.id;
    if (c.locked) el.title = '已锁定：不会被拖动 / 方向键移动（右键菜单可解锁）';

    const track = STATE.doc.tracks.find((t) => t.name === c.track);
    const muted = track && (track.muted || (anySolo && !track.solo));
    if (muted) el.style.opacity = '0.35';

    el.style.left = (c.startMs * pxPerMs) + 'px';
    el.style.width = Math.max(c.durationMs * pxPerMs, 14) + 'px';

    const badges = [];
    if (c.locked) badges.push('<span class="c-badge lock">锁定</span>');
    // 角标只在值真是数字时才画：导入路径会先把缺字段补成 1.0（normalizeImportedDoc），
    // 这里再兜一层 —— 渲染不该因为一条片段的字段坏掉就整条时间轴画不出来（卡 t_59ec2202：
    // 以前 c.pitch 是 undefined 时 `c.pitch.toFixed(2)` 直接抛未捕获异常，4 个片段只画出 1 个）。
    if (typeof c.pitch === 'number' && c.pitch !== 1.0) badges.push(`<span class="c-badge pitch">${c.pitch.toFixed(2)}x</span>`);
    if (typeof c.volume === 'number' && c.volume !== 1.0) badges.push(`<span class="c-badge">vol ${c.volume.toFixed(2)}</span>`);

    // 裁剪 / 淡入淡出也要在片段条上看得见（否则用户只能去属性面板翻才知道）
    if (isTrimmed(c)) {
      badges.push(`<span class="c-badge trim" title="非破坏性裁剪：源内 `
        + `${Math.max(0, c.offsetMs || 0)}ms → ${srcOutMs(c)}ms（素材没丢，拖边缘可恢复）">裁剪</span>`);
    }
    const finMs = Math.max(0, c.fadeInMs || 0);
    const foutMs = Math.max(0, c.fadeOutMs || 0);
    if (finMs || foutMs) {
      const label = finMs && foutMs ? '淡入淡出' : (finMs ? '淡入' : '淡出');
      badges.push(`<span class="c-badge fade" title="淡入 ${finMs}ms / 淡出 ${foutMs}ms">`
        + `${label} ${finMs || 0}/${foutMs || 0}ms</span>`);
    }

    // 淡入淡出斜坡：画在波形上的一层半透明遮罩，一眼能看出哪一头是淡的
    const fadeW = Math.max(0, c.durationMs * pxPerMs);
    const inPx = Math.min(fadeW, finMs * pxPerMs);
    const outPx = Math.min(Math.max(0, fadeW - inPx), foutMs * pxPerMs);
    const fadeHtml =
      (inPx > 0.5 ? `<span class="c-fade in" style="width:${inPx.toFixed(1)}px"></span>` : '')
      + (outPx > 0.5 ? `<span class="c-fade out" style="width:${outPx.toFixed(1)}px"></span>` : '');

    el.innerHTML =
      `<canvas class="c-wave"></canvas>` +
      `<span class="c-label">${esc(c.label)}</span>${badges.join('')}` +
      fadeHtml +
      `<span class="c-handle" title="拖动 = 改长度（等比变速）；按住 Alt 拖动 = 非破坏性裁剪尾部"></span>` +
      `<span class="c-trimtab left" title="按住 Alt 拖动 = 非破坏性裁剪头部（只改源内起点，素材不丢）；不按 Alt 拖动 = 移动片段"></span>`;
    lane.appendChild(el);

    // 波形：先画缓存（重绘不闪），再异步解码补上
    paintClipWave(el, c);
  }

  // ---- 总长边界线：贯穿所有轨道，只看不摸（抓手在标尺条上，见 makeTotalGrip）----
  {
    const edge = document.createElement('div');
    edge.id = 'totalEdge';
    edge.style.left = (total * pxPerMs) + 'px';
    edge.innerHTML = '<span class="te-cap top"></span><span class="te-cap bot"></span>';
    lanes.appendChild(edge);
  }

  // ---- GIF 区间的「灰尾」（P2-1）----
  // 时间轴比 GIF 长时（用户把总长调长了），GIF 末尾之后那段是没有画面的：
  // 压一层灰 + 一条虚线分界，让「GIF 就到这儿」一眼可见，不用先去数秒数。
  // 纯显示层：不改 W、不改片段、不挡鼠标；这里定位一次，缩放/总长/GIF 变化都会重绘跟上。
  const geom = tailShadeGeom(contentW);
  if (geom.visible) {
    tailShade.style.display = 'block';
    tailShade.style.left = geom.left + 'px';
    tailShade.style.width = geom.width + 'px';
  } else {
    tailShade.style.display = 'none';
  }
  // 徽标那句「（时间轴灰色区没有画面）」跟着灰尾走：总长/缩放一改，灰尾可能刚出现或
  // 刚消失，而此刻播放头没动、updateVisualMeta 不会被叫到，副标题就会留着上一次的说法。
  const badgeEl = $('metaTailBadge');
  if (badgeEl && badgeEl.style.display !== 'none') setTailHints(true, geom.visible);

  // ---- 播放头位置 ----
  updatePlayhead(AudioEngine.isPlaying() ? AudioEngine.currentMs() : STATE.playheadMs);

  // 轨道可能在片段循环里被自动补建，这里重绘一次标签
  labels.innerHTML = trackLabelHtml();

  setStatusRight(`${STATE.doc.clips.length} 个音效 · ${STATE.doc.tracks.length} 轨道 · ${(pxPerMs * 1000).toFixed(0)}px/秒`);
}

/** 轨道标签 HTML（两处渲染共用，保证选中态一致） */
function trackLabelHtml() {
  const onlyOne = STATE.doc.tracks.length <= 1;
  return STATE.doc.tracks.map((t) => {
    const sel = STATE.selectedTrack === t.name;
    // 只剩一条轨道时，删除按钮置灰并说明原因 —— 点了没反应会让人以为程序坏了
    const delAttr = onlyOne
      ? 'disabled title="至少要保留一条轨道，无法删除"'
      : 'title="删除该轨道及其片段"';
    return `<div class="track-label${sel ? ' is-selected' : ''}" data-track="${esc(t.name)}">
       <span class="tl-name" title="双击重命名">${esc(t.label)}</span>
       <button class="tl-btn ${t.muted ? 'on' : ''}" data-act="mute" title="静音该轨道">M</button>
       <button class="tl-btn ${t.solo ? 'on' : ''}" data-act="solo" title="独奏该轨道">S</button>
       <button class="tl-btn tl-del" data-act="del" ${delAttr}>✕</button>
     </div>`;
  }).join('');
}

function chooseRulerStep(pxPerMs) {
  const candidates = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
  for (const c of candidates) {
    if (c * pxPerMs >= 60) return c;
  }
  return 60000;
}

/**
 * 「已播完（停在末尾）」状态只在播放头确实还在末尾时才成立。
 * 播放头一离开末尾（用户拖回中间、按 Home、方向键回退……），
 * 状态立刻退回 stopped —— 否则再点播放会莫名其妙地从 0 重播，
 * 而用户期待的是从他自己选的位置续播。
 *
 * 放在 updatePlayhead 里是因为：所有移动播放头的地方最后都会走这里，
 * 一处兜住就不怕漏掉某个入口。
 */
function leaveEndedState(ms) {
  if (STATE.transport !== 'ended' || ms >= totalMs() - 1) return;
  STATE.transport = 'stopped';
  // 播放头已经离开末尾了，状态栏那两句就都不再成立：
  //   「已停在末尾」—— 人已经不在末尾；「再点 ▶ 从头播放」—— 再点是从当前位置续播。
  // 只改文案和传输状态，不动播放逻辑：用户再点 ▶ 依旧从当前位置续播（产品行为不变）。
  clearStatusHint();
  if (statusShowsEnded) showPlayheadPos(ms);
}

function updatePlayhead(ms) {
  leaveEndedState(ms);
  // 「已定位到 X.XXs」跟着播放头走：拖动 / 方向键每动一次都刷新，
  // 不让它变成一个和真实位置对不上的定值（见 showPlayheadPos）。
  if (statusShowsPos) showPlayheadPos(ms);
  const ph = $('playhead');
  ph.style.display = 'block';
  ph.style.left = (ms * STATE.zoom) + 'px';
  $('timeDisplay').textContent = `${fmtTime(ms)} / ${fmtTime(totalMs())}`;
  // 播放头一动就顺手刷新预览区元信息（GIF 放完后会写明"停在最后一帧"）
  updateVisualMeta(ms);
}

// ---------------------------------------------------------------------------
// 拖拽到时间轴
// ---------------------------------------------------------------------------
function setupTimelineDrop() {
  const lanes = $('laneArea');

  // ---- 拖动标尺 / 空白处 = 移动播放头（scrub）----
  const scrollArea = $('scrollArea');
  const ruler = $('ruler');
  let scrubbing = false;
  let scrubWasPlaying = false;      // 拖标尺前是否在播放（松手后要接着播）

  const msFromEvent = (e) => {
    const rect = scrollArea.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollArea.scrollLeft;
    return Math.max(0, Math.min(totalMs(), x / STATE.zoom));
  };

  const doScrub = (e) => {
    const ms = msFromEvent(e);
    // 用户的手优先：告诉同步驱动器「别改写播放头」，
    // 否则播放中往回拖会被音频时钟顶回去，看着像 GIF 不倒退。
    STATE.scrubbing = true;
    STATE.playheadMs = ms;
    updatePlayhead(ms);
    // 拖动进度时 GIF 同步到对应进度（往回拉也会倒退）
    syncVisualTo(ms);
  };

  /** 收尾一次拖动（鼠标松开 / 松在窗口外 / 窗口失焦都要走到这里） */
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    STATE.scrubbing = false;
    ruler.style.cursor = '';
    if (scrubWasPlaying) {
      // 从鼠标松开的位置继续播放（音频 + 画面一起对齐）
      resumePlaybackAt(STATE.playheadMs);
      scrubWasPlaying = false;
    } else {
      // 暂停状态下再定位一次：保证画面停在鼠标放开的那一帧
      syncVisualTo(STATE.playheadMs);
    }
  };

  ruler.addEventListener('mousedown', (e) => {
    scrubbing = true;
    // 播放中拖标尺：先把音频时钟停下来。
    // 否则音频的 onTick 会一边拖一边把播放头改回"音频当前时刻"，
    // 画面跟着往前跑 —— 用户看到的就是"往回调 GIF 不倒退"。
    scrubWasPlaying = STATE.transport === 'playing';
    if (scrubWasPlaying) {
      AudioEngine.stopSequence();
      stopVisualDrivers();
      // 音频已经被停掉了 —— 传输状态和状态栏都不能再说"播放中"，
      // 否则用户往回拖的时候看到状态栏写着"播放中…"却一声也没响（P0）。
      // scrubbing = 手在拖、声音停着；松手时 resumePlaybackAt 会把它改回 playing。
      STATE.transport = 'scrubbing';
      // 「松手后…」只在手还按着的时候成立，所以按一次性提示写（松手续播时自动消失）
      statusHint('已暂停，可拖动定位', '松手后从拖到的位置继续播放');
    }
    ruler.style.cursor = 'grabbing';
    doScrub(e);
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!scrubbing) return;
    // 鼠标已经松开却收不到 mouseup（松在窗口外）→ 自己收尾，
    // 否则 STATE.scrubbing 会一直卡住，GIF 驱动器再也不干活。
    if (e.buttons === 0) { endScrub(); return; }
    doScrub(e);
  });
  window.addEventListener('mouseup', endScrub);
  window.addEventListener('blur', endScrub);

  lanes.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  lanes.addEventListener('drop', async (e) => {
    e.preventDefault();
    const lane = e.target.closest('.lane');
    const trackName = lane ? lane.dataset.track : STATE.doc.tracks[0].name;
    // 用 scrollArea 作为坐标基准（和拖动播放头一致）。
    // 用 lanes 会在横向滚动过之后算错落点。
    const rect = $('scrollArea').getBoundingClientRect();
    const x = e.clientX - rect.left + $('scrollArea').scrollLeft;
    const ms = Math.max(0, snapMs(x / STATE.zoom, STATE.doc.config));

    // —— 原版事件（写事件名，游戏自己随机选变体）——
    const rawEvt = e.dataTransfer.getData('application/x-mcs-event');
    if (rawEvt) {
      const info = JSON.parse(rawEvt);
      // 用第一个变体的真实时长，而不是占位 500ms。
      // 否则拖进来的片段长度和实际音频完全不符（用户一眼就看出来不对）。
      let dur = 500;
      try {
        const v = window.MCS_EVENTS.pickVariant(info.event, 0);
        if (v && v.absPath) {
          const d = await AudioEngine.probeDuration(v.absPath);
          if (d) dur = d;
        }
      } catch (err) { /* 探测失败就用默认 */ }

      const clip = makeClip({
        label: info.label || info.event,
        soundId: info.event,
        soundPath: '',
        kind: 'event',
        category: info.category || '',
        variantCount: info.variantCount || 1,
        startMs: ms,
        durationMs: dur,
        srcDurMs: dur,   // 源音频自然长度：非破坏性裁剪「最远能拖回哪儿」的边界（卡 t_47b9fab2）
        track: trackName,
      });
      STATE.doc.clips.push(clip);
      setSelection([clip.id], clip.id);      // 新片段成为唯一选中项
      autoExtendTotal(ms, dur);
      markDirty('add');
      renderTimeline();
      renderProps();
      revalidate();
      status(`已添加原版事件「${info.label || info.event}」@ ${ms}ms（时长 ${dur}ms）` +
             (info.variantCount > 1 ? `，${info.variantCount} 个变体游戏内随机` : ''));
      return;
    }

    // —— 普通音频文件 ——
    const raw = e.dataTransfer.getData('application/x-mcs-sound');
    if (raw) {
      const info = JSON.parse(raw);
      const dur = await (async () => {
        const d = await AudioEngine.probeDuration(info.path);
        return d || 500;
      })();

      const clip = makeClip({
        label: info.name,
        soundId: '',
        soundPath: info.path,
        kind: 'file',
        startMs: ms,
        durationMs: dur,
        srcDurMs: dur,   // 源音频自然长度：非破坏性裁剪「最远能拖回哪儿」的边界（卡 t_47b9fab2）
        track: trackName,
      });
      STATE.doc.clips.push(clip);
      setSelection([clip.id], clip.id);      // 新片段成为唯一选中项
      autoExtendTotal(ms, dur);
      markDirty('add');
      renderTimeline();
      renderProps();
      revalidate();
      status(`已添加「${info.name}」@ ${ms}ms（时长 ${dur}ms）`);
    }
  });
}

// ---------------------------------------------------------------------------
// 总长边界条（卡 t_6b99a1fd）
//
// 界面上的样子：「[  总长 6.00s ]」——左括号钉在 0ms，右括号就是抓手。
// 抓手放在标尺条里（轨道区的位置要留给片段拖动，抓手压在片段上会抢走点击），
// 轨道区里另有一条贯穿的边界线（#totalEdge）让人看见边界落在哪一条轨道上。
//
// 拖拽期间 per-move 只改总长、不重排播放（否则播放中每挪一像素就重启一次音频）；
// 松手时若正在播放，按新边界重新对齐一次。整段拖动只进一次撤销栈。
// ---------------------------------------------------------------------------
let TOTAL_DRAG = null;      // { startX, startTotal, moved }
let TOTAL_PIPE_ARMED = false;   // 拖拽管道是否已装（setupTotalBoundary 幂等用）

/** 造一个总长抓手（每次重绘都会重建，所以监听器只挂「按下」这一拍） */
function makeTotalGrip(leftPx, totalMsValue) {
  // 顺带把 window 级的拖拽管道装上（幂等）。为什么不写在 boot() 里：
  // app.js 被多张并行卡同时改，boot() 体里的接线被整文件写覆盖过一次 ——
  // 让接线跟着**本卡自己的**函数走，就少一处被别人覆盖的面（卡 t_6b99a1fd）。
  setupTotalBoundary();
  const el = document.createElement('div');
  el.id = 'totalGrip';
  el.style.left = leftPx + 'px';
  el.title = '拖动调整时间轴总长（下限 = 最后一段音效的结束时间）';
  el.innerHTML = '<span class="tg-bar"></span>'
    + '<span class="tg-cap top"></span><span class="tg-cap bot"></span>'
    + `<span class="tg-label">总长 ${(totalMsValue / 1000).toFixed(2)}s</span>`;
  el.addEventListener('mousedown', startTotalDrag);
  return el;
}

function startTotalDrag(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  // 标尺自己也监听 mousedown（拖动播放头）：这一按是改总长，不能同时又去拖播放头
  e.stopPropagation();
  TOTAL_DRAG = { startX: e.clientX, startTotal: STATE.doc.config.totalMs, moved: false };
  beginUndoBatch('total');
  document.body.classList.add('total-dragging');
  const floor = totalFloorMs();
  status(`拖动调整总长（当前 ${(STATE.doc.config.totalMs / 1000).toFixed(2)}s）`,
    `下限 ${(floor / 1000).toFixed(3)}s ＝ 最后一段音效的结束时间`);
}

function moveTotalDrag(e) {
  if (!TOTAL_DRAG) return;
  const dx = e.clientX - TOTAL_DRAG.startX;
  if (!TOTAL_DRAG.moved && Math.abs(dx) < 3) return;       // 只是点了一下，不算拖动
  TOTAL_DRAG.moved = true;
  const r = setTotalMs(TOTAL_DRAG.startTotal + dx / STATE.zoom, { source: 'drag', quiet: true });
  if (r.clamped) {
    // 被下限拦住：说清为什么，并给出「想再短该怎么办」
    status(`总长不能短于 ${(r.floor / 1000).toFixed(3)}s（最后一段音效的结束时间）`,
      '把它前面的音效挪走或缩短，才能继续缩总长');
  } else {
    status(`总长 ${(r.value / 1000).toFixed(3)}s`, '松手生效');
  }
}

function endTotalDrag() {
  if (!TOTAL_DRAG) return;
  const d = TOTAL_DRAG;
  TOTAL_DRAG = null;
  endUndoBatch();
  document.body.classList.remove('total-dragging');
  const t = STATE.doc.config.totalMs;
  const floor = totalFloorMs();
  if (!d.moved) {
    status(`总长 ${(t / 1000).toFixed(3)}s`,
      `拖动这条边界可改总长；下限 ${(floor / 1000).toFixed(3)}s（最后一段音效的结束时间）`);
    return;
  }
  markDirty('total');          // 收口：拖动期间已经记过，这里只是保证「只点不动」不会留下空撤销步
  if (STATE.transport === 'playing') resumePlaybackAt(Math.min(STATE.playheadMs || 0, totalMs()));
  if (t <= floor) {
    // 停在硬下限上：必须说清「为什么不能再短」，否则用户只会觉得拖不动
    status(`总长已到下限 ${(t / 1000).toFixed(3)}s（最后一段音效的结束时间）`,
      '想更短就先把最后那段音效挪走或缩短');
  } else {
    status(`总长已改为 ${(t / 1000).toFixed(3)}s`,
      `下限 ${(floor / 1000).toFixed(3)}s = 最后一段音效的结束时间`);
  }
  revalidate();
}

function setupTotalBoundary() {
  if (TOTAL_PIPE_ARMED) return false;          // 幂等：重绘会反复调，只能装一次
  TOTAL_PIPE_ARMED = true;
  // 抓手每次重绘都会被重建（renderTimeline 里 new），所以管道挂在 window 上：
  // 元素只负责「按下」那一拍，移动 / 松手全在这里收，重绘不会把监听器弄丢。
  window.addEventListener('mousemove', moveTotalDrag);
  window.addEventListener('mouseup', endTotalDrag);
  window.addEventListener('blur', endTotalDrag);
  return true;
}

/**
 * 片段超出当前总长时自动延长总线。
 * 注意：延长总长**不能**改变用户在「总长(ms)」输入框里显式设过的值
 * 以外的语义 —— 这里只是保证片段不会落在看不见的区域。
 */
function autoExtendTotal(startMs, durMs) {
  const need = startMs + durMs;
  if (need <= STATE.doc.config.totalMs) return false;
  // 向上取整到最近的 500ms，避免总长出现 5037ms 这种碎值
  STATE.doc.config.totalMs = Math.ceil(need / 500) * 500;
  const inp = $('inpTotalMs');
  if (inp) inp.value = STATE.doc.config.totalMs;
  return true;
}

/**
 * 拖动 / 裁剪时状态栏那句话（拖动中实时刷，松手后定格）。
 * 四种拖法必须说清楚是哪一种，否则用户看到时长变了会以为倍速没变、或者
 * 以为裁剪把素材删了：
 *   stretch / stretchHead → 条长 ↦ 倍速（等比变速）
 *   trimTail / trimHead   → 源内起止（素材保留，拖回去可恢复）
 */
function dragGeomText(d) {
  const it = d.items[0];
  const c = it.clip;
  const fx = (r) => Number(r).toFixed(2) + 'x';
  const parts = [];
  if (d.mode === 'trimTail') {
    parts.push(`非破坏性裁剪（尾）：源内 ${Math.max(0, c.offsetMs || 0)}ms → ${srcOutMs(c)}ms`);
    parts.push(`片段长度 ${c.durationMs}ms（倍速不变 ${fx(rateOf(c))}）`);
    if (d.last && d.last.hitEnd) parts.push(`已到音频结尾（${srcTotalMs(c)}ms），不能再拉长`);
  } else if (d.mode === 'trimHead') {
    parts.push(`非破坏性裁剪（头）：源内起点 ${Math.max(0, c.offsetMs || 0)}ms 起`);
    parts.push(`片段 ${(c.startMs / 1000).toFixed(3)}s → ${((c.startMs + c.durationMs) / 1000).toFixed(3)}s`
      + `（末尾不动，长度 ${c.durationMs}ms，倍速不变 ${fx(rateOf(c))}）`);
    if (d.last && d.last.hitStart) parts.push('已恢复到源音频开头，不能再往前');
  } else {
    parts.push(`片段时长 ${it.origDur}ms → ${c.durationMs}ms`);
    parts.push(`播放速度 ${fx(it.origPitch)} → ${fx(rateOf(c))}（等比变速，音高跟着变）`);
    if (d.last && d.last.clamped) {
      parts.push(`已到 ${rateOf(c) >= MAX_RATE ? MAX_RATE : MIN_RATE}x 倍速上限，再拖声音就铺不满这条了`);
    }
  }
  return parts.join('，');
}

/** 拖动手势对应的撤销种类（'move' / 'resize' / 'trim'）—— 撤销时状态栏就是照它说的 */
function dragKind(d) {
  if (!d || d.mode === 'move') return 'move';
  return d.isTrim ? 'trim' : 'resize';
}

// ---------------------------------------------------------------------------
// 片段交互：拖移 / 改长度 / 选中 / 框选 / 整体拖动
// ---------------------------------------------------------------------------
function setupClipInteraction() {
  const lanes = $('laneArea');
  const scrollArea = $('scrollArea');

  // dragging：拖动（多选时 items 是整组片段，按同一个位移整体移动）
  // marquee ：在轨道空白处按下后拉出的选择框
  let dragging = null;
  let marquee = null;

  // 时间轴「内容坐标」（含滚动偏移）——和播放头、拖放落点用同一套算法
  const contentPt = (e) => {
    const r = scrollArea.getBoundingClientRect();
    return {
      x: e.clientX - r.left + scrollArea.scrollLeft,
      y: e.clientY - r.top + scrollArea.scrollTop,
    };
  };
  const hideSelBox = () => { const b = $('selBox'); if (b) b.style.display = 'none'; };

  const paintSelBox = (x1, y1, x2, y2) => {
    const b = $('selBox');
    if (!b) return;
    b.style.display = 'block';
    b.style.left = Math.min(x1, x2) + 'px';
    b.style.top = Math.min(y1, y2) + 'px';
    b.style.width = Math.abs(x2 - x1) + 'px';
    b.style.height = Math.abs(y2 - y1) + 'px';
  };

  // ---- 按下：区分「按到片段」和「按到空白」 ----
  lanes.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;            // 右键交给右键菜单，不参与拖动
    const clipEl = e.target.closest('.clip');
    // 按在片段左端多少像素 —— 必须在**这里**算：下面选中逻辑里的 renderTimeline()
    // 会把所有片段元素整批重建，手里这个 el 随即变成脱离文档的节点，
    // 再调 getBoundingClientRect() 全是 0（Alt + 左端裁剪就是被这个坑掉的：
    // 「按在左端 8px 内」永远算成 false，于是变成了移动片段）。
    const pressDx = clipEl ? (e.clientX - clipEl.getBoundingClientRect().left) : Infinity;

    // ===== 空白处：开始框选 =====
    if (!clipEl) {
      const additive = e.ctrlKey || e.metaKey;
      // 记下这次按下是否真的「取消掉了选中」——非累加按下才会立刻清空选中集。
      // 注意：这里只清状态、不改状态栏文字。状态栏要等松手确认「没拉出选择框」
      // 才更新，否则每次准备框选都会闪一下「已取消选中」（见下面的 mouseup）。
      const hadSelection = STATE.selectedClipIds.size > 0;
      if (!additive) { clearSelection(); renderTimeline(); renderProps(); }
      const p = contentPt(e);
      marquee = {
        startX: p.x, startY: p.y, moved: false,
        // 单击空白（没拖动）且清掉了原有选中 → 松手时状态栏必须改口，
        // 不能把「已选中 N 个片段…」这种过期文字留在状态栏里（P2）。
        deselected: !additive && hadSelection,
        baseIds: new Set(STATE.selectedClipIds),   // Ctrl+框选 = 在已有选中上累加
      };
      e.preventDefault();
      return;
    }

    // ===== 片段：先决定选中集，再决定是否进入拖动 =====
    const clip = STATE.doc.clips.find((c) => c.id === clipEl.dataset.clipId);
    if (!clip) return;

    const additive = e.ctrlKey || e.metaKey;
    const range = e.shiftKey;

    if (additive) {
      toggleSelection(clip.id);          // Ctrl/Cmd+点击 = 加入 / 移出选中集
      selectionStatus('已选中');
    } else if (range) {
      selectRangeTo(clip.id);            // Shift+点击 = 从主选中到该片段整段加选
      selectionStatus('已选中');
    } else if (!isSelected(clip.id)) {
      setSelection([clip.id], clip.id);  // 点未选中的片段 = 只选它
      selectionStatus('已选中');
    } else {
      STATE.selectedClipId = clip.id;    // 点已选中的片段 = 保留整组，主选中换成它
    }
    renderTimeline();                    // 高亮必须跟着走（否则用户会误删）
    renderProps();

    if (additive || range) { e.preventDefault(); return; }   // 加减选不进入拖动

    // 拖右手柄（.c-handle）= 改长度；按住 Alt 再拖 = 非破坏性裁剪。
    // 头部裁剪没有单独的把手：Alt + 在片段左端 8px 内按下即可 —— 这样**不按 Alt**时
    // 拖左端仍然是「移动片段」（老行为，老脚本和老手感都不能被改掉）。
    const handle = e.target.closest('.c-handle');
    const nearLeft = pressDx <= TRIM_HEAD_ZONE_PX;
    const isTrimHead = !!e.altKey && nearLeft;
    const isResize = !!handle || isTrimHead;
    const edge = isTrimHead ? 'left' : (handle ? 'right' : 'none');
    const isTrim = isResize && e.altKey;
    const base = isResize ? [clip] : selectedClips();        // 拖本体 = 整组移动；拖手柄 = 只动这一个
    // 锁定的片段不参与拖动：它是「防止配音时手一抖把对齐好的位置拖歪」的挡板
    const members = base.filter((c) => !isLocked(c));
    if (!members.length) {
      status(`「${clip.label}」已锁定 —— 右键菜单选「解锁」后才能拖动 / 改长度 / 裁剪`,
             '锁定：防止误拖');
      e.preventDefault();
      return;
    }
    const lockedOut = base.length - members.length;
    if (lockedOut) {
      status(`${lockedOut} 个已锁定的片段不会跟着移动`,
             '先解锁再整体拖动');
    }
    const dragPrimary = members.find((c) => c.id === clip.id) || members[0];
    // 拖动的四种含义（卡 t_47b9fab2）：
    //   move      拖本体（含左端 8px，不按 Alt 时）—— 整组移动位置，什么都不改
    //   stretch   右手柄 —— 改条长 + 等比改播放倍速（声音正好铺满这条）
    //   trimTail  右手柄 + Alt —— 非破坏性裁剪尾（只推源内出点，素材留着）
    //   trimHead  左端 8px + Alt —— 非破坏性裁剪头（起点与源内入点一起走）
    const mode = isTrimHead ? 'trimHead'
      : (handle ? (isTrim ? 'trimTail' : 'stretch') : 'move');
    dragging = {
      mode,
      edge,
      isResize,
      isTrim,
      last: null,                                        // 最近一次几何计算的结果（状态栏用）
      primary: dragPrimary,
      origPrimaryStart: dragPrimary.startMs,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      items: members.map((c) => ({
        clip: c,
        origStart: c.startMs,
        origDur: c.durationMs,
        origPitch: rateOf(c),
        origOffset: Math.max(0, c.offsetMs || 0),
        origSrcEnd: c.srcEndMs != null ? c.srcEndMs : null,
      })),
    };
    e.preventDefault();
  });

  // ---- 移动：框选矩形 / 整组拖动 ----
  window.addEventListener('mousemove', (e) => {
    // ===== 框选 =====
    if (marquee) {
      const p = contentPt(e);
      if (!marquee.moved &&
          (Math.abs(p.x - marquee.startX) > 3 || Math.abs(p.y - marquee.startY) > 3)) {
        marquee.moved = true;
      }
      if (!marquee.moved) return;        // 只是点了一下，不画框
      const x1 = Math.min(marquee.startX, p.x);
      const x2 = Math.max(marquee.startX, p.x);
      const y1 = Math.min(marquee.startY, p.y);
      const y2 = Math.max(marquee.startY, p.y);
      paintSelBox(x1, y1, x2, y2);

      // 命中判定：片段矩形与选择框相交（都换算到内容坐标）
      const r = scrollArea.getBoundingClientRect();
      const ids = new Set(marquee.baseIds);
      lanes.querySelectorAll('.clip').forEach((el) => {
        const cr = el.getBoundingClientRect();
        const l = cr.left - r.left + scrollArea.scrollLeft;
        const t = cr.top - r.top + scrollArea.scrollTop;
        if (Math.min(l + cr.width, x2) >= Math.max(l, x1) &&
            Math.min(t + cr.height, y2) >= Math.max(t, y1)) {
          ids.add(el.dataset.clipId);
        }
      });
      setSelection(ids, STATE.selectedClipId);
      renderTimeline();
      status(`框选中 ${ids.size} 个片段`);
      return;
    }

    // ===== 拖动 =====
    if (!dragging) return;
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    const dms = dx / STATE.zoom;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragging.moved = true;

    if (dragging.isResize) {
      const it = dragging.items[0];
      const c = it.clip;
      // 每次都从「拖动前」的样子重算：拖动是逐帧来的，逐帧累乘倍速会攒出误差，
      // 而且撞到钳制（30ms / 0.25x / 4x）之后就再也回不去原始值了。
      c.startMs = it.origStart;
      c.durationMs = it.origDur;
      c.pitch = it.origPitch;
      c.offsetMs = it.origOffset;
      c.srcEndMs = it.origSrcEnd;

      if (dragging.mode === 'stretch') {
        // 普通拖右边缘：条长变了，播放倍速等比跟着变（素材长度不变）
        dragging.last = setStretchedDuration(c, it.origDur + dms);
      } else if (dragging.mode === 'trimTail') {
        // Alt 拖右边缘：非破坏性裁剪尾（倍速不动，往右拖回去可恢复）
        dragging.last = setTrimmedTail(c, it.origDur + dms);
      } else {
        // Alt 拖左边缘：非破坏性裁剪头
        const ns = Math.round(it.origStart + dms);
        dragging.last = setTrimmedHead(c, ns - it.origStart);
      }
      status(dragGeomText(dragging), dragging.isTrim ? 'Alt：非破坏性裁剪（素材不丢，拖回去可恢复）' : '拖动中…');
    } else {
      // 吸附只以主片段为准，整组跟着同一个位移走
      // （各自吸附会把组内相对间距挤变形）
      const cfg = e.altKey ? { snapToGrid: false } : STATE.doc.config;
      const target = snapMs(dragging.origPrimaryStart + dms, cfg);
      let delta = target - dragging.origPrimaryStart;
      // 整组不允许越过 0：夹住整组，而不是让片段各自贴到 0 散开
      let minStart = Infinity;
      for (const it of dragging.items) minStart = Math.min(minStart, it.origStart);
      if (minStart + delta < 0) delta = -minStart;
      for (const it of dragging.items) {
        it.clip.startMs = Math.max(0, Math.round(it.origStart + delta));
      }
      if (dragging.items.length > 1) {
        status(`整体移动 ${dragging.items.length} 个片段 → 主片段起点 `
          + `${(dragging.primary.startMs / 1000).toFixed(3)}s`);
      }
    }
    renderTimeline();
  });

  // ---- 松手：收尾 + 状态栏反馈 ----
  window.addEventListener('mouseup', (e) => {
    if (marquee) {
      const moved = marquee.moved;
      const deselected = marquee.deselected;
      marquee = null;
      hideSelBox();
      if (moved) {
        if (STATE.selectedClipIds.size) selectionStatus('框选中');
        else status('框选没有命中任何片段（已取消选中）');
      } else if (deselected) {
        // 空白处单击（没拖动）= 取消选中：话术与 Esc / 右键菜单「取消选中」统一
        status('已取消选中');
      }
      renderProps();
    }

    if (dragging) {
      const d = dragging;
      dragging = null;
      renderProps();
      revalidate();
      if (d.moved) {
        const c = d.items[0].clip;
        if (d.isResize) {
          markDirty(dragKind(d));            // 进撤销栈：整段拖动 = 一步（'resize' / 'trim'）
          status(dragGeomText(d), d.isTrim ? 'Alt 裁剪：素材没丢，拖回边缘就能恢复' : '');
        } else {
          // 片段可以直接拖进任意目标轨道。此前只有右键「上移/下移」能跨层，
          // 鼠标拖到下一层只会改横向位置，既反直觉也容易误排。用松手点命中的
          // .lane 判断目标，整组选中时保持它们的时间关系并一起换层。
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const lane = hit && hit.closest ? hit.closest('.lane') : null;
          const targetTrack = lane && lane.dataset.track;
          const changedTrack = targetTrack && STATE.doc.tracks.some((t) => t.name === targetTrack)
            && d.items.some((it) => it.clip.track !== targetTrack);
          if (changedTrack) {
            for (const it of d.items) it.clip.track = targetTrack;
            // mousemove 阶段已按旧轨道重绘；松手后轨道才变更，必须立刻重绘，
            // 否则数据和可见片段会短暂分属不同轨道，下一次拖动还会以旧画面为起点。
            renderTimeline();
          }
          markDirty('move');
          if (d.items.length > 1) {
            const r = selectionRangeMs();
            status(changedTrack
              ? `已把 ${d.items.length} 个片段移到「${STATE.doc.tracks.find((t) => t.name === targetTrack).label}」（相对时间保持不变）`
              : `已整体移动 ${d.items.length} 个片段（${(r.from / 1000).toFixed(3)}s → ${(r.to / 1000).toFixed(3)}s，相对间距保持不变）`);
          } else {
            const target = targetTrack && STATE.doc.tracks.find((t) => t.name === targetTrack);
            status(target && changedTrack
              ? `片段已移到「${target.label}」@ ${(c.startMs / 1000).toFixed(3)}s`
              : `片段已移到 ${(c.startMs / 1000).toFixed(3)}s`);
          }
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 轨道按钮
// ---------------------------------------------------------------------------
function setupTrackButtons() {
  $('trackLabelList').addEventListener('click', (e) => {
    const row = e.target.closest('.track-label');
    if (!row) return;
    const trackName = row.dataset.track;
    const btn = e.target.closest('.tl-btn');
    const t = STATE.doc.tracks.find((x) => x.name === trackName);

    if (btn && t) {
      if (btn.dataset.act === 'mute') {
        t.muted = !t.muted;
        markDirty('mute');
        renderTimeline();
        status(`${t.label}：${t.muted ? '已静音' : '取消静音'}`);
        return;
      }
      if (btn.dataset.act === 'solo') {
        t.solo = !t.solo;
        markDirty('solo');
        renderTimeline();
        status(t.solo ? `${t.label}：独奏中` : `${t.label}：退出独奏`);
        return;
      }
      if (btn.dataset.act === 'del') {
        deleteTrack(trackName);
        return;
      }
    }
    // 点轨道空白处 = 选中该轨道（视觉高亮，且新拖入的音效默认落这里）
    STATE.selectedTrack = trackName;
    renderTimeline();
  });

  // 新建轨道
  $('btnAddTrack').addEventListener('click', () => {
    const n = STATE.doc.tracks.length + 1;
    let name = 'track' + n;
    let label = '轨道 ' + n;
    if (n === 2) { name = 'layer2'; label = '音效层'; }
    if (n === 3) { name = 'layer3'; label = '环境层'; }
    while (STATE.doc.tracks.some((t) => t.name === name)) {
      name = name + '_' + Math.floor(Math.random() * 100);
    }
    STATE.doc.tracks.push(makeTrack(name, { label }));
    markDirty('track');        // 卡 t_c4491bba：带 kind，撤销时说「轨道改动」而不是含糊的「操作」
    STATE.selectedTrack = name;
    renderTimeline();
    status(`已新建「${label}」`, '把左侧音效拖到这条轨道上即可分层编排');
  });

  // 双击轨道名可重命名
  $('trackLabelList').addEventListener('dblclick', (e) => {
    const nameEl = e.target.closest('.tl-name');
    if (!nameEl) return;
    const trackName = nameEl.closest('.track-label').dataset.track;
    const t = STATE.doc.tracks.find((x) => x.name === trackName);
    if (!t) return;
    // Electron 明确不支持 window.prompt()。直接在轨道标签位置换成输入框，
    // Enter / 失焦提交，Esc 取消；不额外引入一个会挡住时间轴的弹窗。
    if (nameEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tl-rename-input';
    input.value = t.label;
    input.setAttribute('aria-label', '轨道名称');
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      const label = input.value.trim();
      if (save && label && label !== t.label) {
        t.label = label;
        markDirty('track');
        renderTimeline();
        status(`已重命名为「${t.label}」`);
      } else {
        renderTimeline();
      }
    };
    input.addEventListener('keydown', (ev) => {
      // 回车直接提交，不依赖 blur() 是否送达（无头 / 未获得焦点时 blur 事件不会来，
      // 那时回车就会变成「输入框还在、名字没改」）。finish() 自带幂等，重复触发无害。
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    // 点别处（失去焦点）= 提交，和绝大多数软件的改名体验一致
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
  });
}

/** 删除轨道及其片段（至少保留一条） */
function deleteTrack(trackName) {
  const idx = STATE.doc.tracks.findIndex((x) => x.name === trackName);
  if (idx < 0) return;
  if (STATE.doc.tracks.length <= 1) {
    status('至少要保留一条轨道', '可以先删掉轨道上的音效，但不能删掉最后一条');
    return;
  }
  const t = STATE.doc.tracks[idx];
  const n = STATE.doc.clips.filter((c) => c.track === trackName).length;
  if (n > 0 && !confirm(`「${t.label}」上有 ${n} 个音效，一并删除？`)) return;

  STATE.doc.clips = STATE.doc.clips.filter((c) => c.track !== trackName);
  STATE.doc.tracks.splice(idx, 1);
  markDirty('track');          // 卡 t_c4491bba：带 kind（删轨道也是轨道改动）
  if (STATE.selectedTrack === trackName) STATE.selectedTrack = null;
  renderTimeline();
  status(`已删除「${t.label}」${n ? `及其 ${n} 个音效` : ''}`);
}

// ---------------------------------------------------------------------------
// 属性面板
// ---------------------------------------------------------------------------
function renderProps() {
  const multi = $('propsMulti');
  const n = STATE.selectedClipIds.size;
  const c = STATE.doc.clips.find((x) => x.id === STATE.selectedClipId);

  // 多选：不显示单片段表单（免得用户以为改的是「那一个」），改为整组摘要
  if (n > 1 && multi) {
    $('propsEmpty').style.display = 'none';
    $('propsForm').style.display = 'none';
    multi.style.display = 'block';
    $('propsMultiCount').textContent = `已选中 ${n} 个片段`;
    const r = selectionRangeMs();
    $('propsMultiHint').textContent = r
      ? `时间范围 ${(r.from / 1000).toFixed(3)}s → ${(r.to / 1000).toFixed(3)}s。`
        + '拖动任一成员可整体移动（相对间距保持不变）；Ctrl+C 复制、Del 删除作用于全部。'
      : '';
    return;
  }
  if (multi) multi.style.display = 'none';

  if (!c) {
    $('propsEmpty').style.display = 'block';
    $('propsForm').style.display = 'none';
    return;
  }
  $('propsEmpty').style.display = 'none';
  $('propsForm').style.display = 'block';

  $('pLabel').value = c.label || '';
  $('pSoundId').value = c.soundId || '';
  $('pStart').value = c.startMs;
  $('pDuration').value = c.durationMs;
  // ---- 裁剪 / 变速 / 淡入淡出（卡 t_47b9fab2）----
  // 面板上必须能看见「源内起止」，否则「非破坏性裁剪」就只是拖一下、
  // 用户既不知道裁掉了多少，也不知道能不能恢复。
  if ($('pOffset')) $('pOffset').value = Math.max(0, c.offsetMs || 0);
  if ($('pSrcEnd')) $('pSrcEnd').value = c.srcEndMs != null ? c.srcEndMs : srcTotalMs(c);
  if ($('pSrcTotal')) $('pSrcTotal').textContent = `源音频 ${srcTotalMs(c)}ms`;
  if ($('pFadeIn')) $('pFadeIn').value = Math.max(0, c.fadeInMs || 0);
  if ($('pFadeOut')) $('pFadeOut').value = Math.max(0, c.fadeOutMs || 0);
  if ($('pFadePreset')) $('pFadePreset').value = matchFadePreset(c);
  if ($('pGeomHint')) {
    $('pGeomHint').textContent =
      `素材保留 ${Math.round(contentMs(c))}ms · 片段长度 ${c.durationMs}ms · `
      + `播放倍速 ${rateOf(c).toFixed(2)}x · 实际会响 ${Math.round(audibleMs(c))}ms`;
  }
  $('pVolume').value = c.volume;
  $('pVolVal').textContent = Number(c.volume).toFixed(2);
  $('pPitch').value = Math.max(0.25, Math.min(4, c.pitch));
  $('pPitchVal').textContent = Number(c.pitch).toFixed(2);
  $('pPitchNum').value = c.pitch;
  $('pNote').value = c.note || '';
  renderVariantFields(c, window.MCS_EVENTS);

  // 轨道下拉
  const sel = $('pTrack');
  sel.innerHTML = STATE.doc.tracks.map((t) =>
    `<option value="${esc(t.name)}" ${t.name === c.track ? 'selected' : ''}>${esc(t.label)}</option>`).join('');

  // 来源信息
  const src = [];
  if (c.soundPath) src.push(`源文件：${c.soundPath}`);
  if (c.soundId) src.push(`事件：${c.soundId}`);
  $('pSource').textContent = src.join('　|　');

  // 试听按钮状态：告诉用户会听到什么
  const btn = $('btnAudition');
  if (btn) {
    const resolved = resolveClipAudio(c);
    // 原版试听音频整份没就位（启动时已探到）时不要写乐观提示：
    // 按钮仍可点（用户可能刚把音频放回去），但文案要说明「点了也不会有声音」，
    // 并指向状态栏那个「点此查看怎么放音频」的入口（卡 t_8c74ddef 第 1 条）。
    const audioNotReady = !!STATE.audioMissing;
    if (resolved && resolved.absPath) {
      const fn = resolved.absPath.split(/[\\/]/).pop();
      btn.disabled = false;
      btn.textContent = audioNotReady ? '▶ 试听（试听音频未就位）' : '▶ 试听这个音效';
      btn.title = audioNotReady
        ? '试听音频还没就位，点了不会有声音 —— 点顶部状态栏看怎么放音频'
        : (resolved.variantTotal > 1
            ? (resolved.variantMode === 'locked'
                ? `将播放：${fn}（${variantBadgeText(resolved)}）`
                : `将从 ${resolved.variantTotal} 个变体里随机播一个（本次抽到 ${fn}）`)
            : '将播放：' + fn);
      $('pPreviewHint').textContent = audioNotReady
        ? '原版试听音频未就位，点了不会有声音 —— 点顶部状态栏查看怎么放音频'
        : (c.kind === 'event'
            ? `原版事件 ${c.soundId} → ${resolved.variantTotal > 1
                ? `${variantBadgeText(resolved)} · ` : ''}${resolved.file}`
            : resolved.file);
      $('pPreviewHint').style.color = audioNotReady ? 'var(--warn, #e3b341)' : '';
    } else {
      btn.disabled = true;
      btn.textContent = '▶ 试听（无音频文件）';
      btn.title = '';
      $('pPreviewHint').textContent = c.kind === 'event'
        ? '这个原版事件在当前音频库里找不到对应文件'
        : '该片段没有关联音频文件';
      $('pPreviewHint').style.color = 'var(--warn, #e3b341)';
    }
  }
}

/**
 * 把片段解析成实际可播的音频文件（事件查库，文件直接用）。
 *
 * 卡 t_3623451f：单一入口 —— 时间轴播放走 MCS_EVENTS.resolveForPlayback()，
 * 这里也走它，于是「试听」与「播放」不可能再对不上（以前这里判的是 'fixed'，
 * 而界面写进文档的是 'locked'：指定变体在试听这条路上一辈子没生效过）。
 *
 * @returns { absPath, file, volume, pitch, variantIndex, variantTotal, variantMode } | null
 *          volume/pitch = **变体自带**的值（时间轴播放时还要再乘上片段自己的音量/音高）
 */
function resolveClipAudio(c) {
  if (!c) return null;
  const EV = window.MCS_EVENTS;
  if (c.kind === 'event' && c.soundId && EV) {
    const r = EV.resolveForPlayback(c);
    if (r && r.absPath) {
      return {
        absPath: r.absPath,
        file: r.variantFile || r.absPath.split(/[\\/]/).pop(),
        volume: r.volume != null ? r.volume : 1,
        pitch: r.pitch != null ? r.pitch : 1,
        variantIndex: r.variantIndex,
        variantTotal: r.variantTotal,
        variantMode: EV.variantModeOf ? EV.variantModeOf(c) : 'auto',
      };
    }
    return null;
  }
  if (c.soundPath) {
    return {
      absPath: c.soundPath,
      file: c.soundPath.split(/[\\/]/).pop(),
      volume: 1, pitch: 1, variantIndex: 0, variantTotal: 1, variantMode: 'auto',
    };
  }
  return null;
}

/** 变体角标文案：指定 / 随机 + 第几个 */
function variantBadgeText(resolved) {
  if (!resolved || !(resolved.variantTotal > 1)) return '';
  const which = `${resolved.variantIndex + 1}/${resolved.variantTotal}`;
  return resolved.variantMode === 'locked' ? `指定变体 ${which}` : `随机变体 ${which}`;
}

/**
 * 属性面板的变体字段（卡 t_3623451f）。
 *
 * 「有变体的音效」必须能二选一：随机变体（游戏默认，每次随机）或指定变体（固定某一个，
 * 列表就是库里这个事件的全部 ogg —— 不放路径，也不让用户手输）。单变体 / 文件片段
 * 直接隐藏整个字段，避免出现一个永远没用的下拉。
 */
function renderVariantFields(c, EV) {
  const sel = $('pVariant');
  const modeHint = $('pVariantModeHint');
  const field = $('pVariantPickField');
  const pick = $('pVariantPick');
  const pickHint = $('pVariantPickHint');
  if (!sel || !field || !pick) return;

  const isEvent = c.kind === 'event' && !!c.soundId;
  const vs = isEvent && EV ? EV.getVariants(c.soundId) : [];
  const mode = EV && EV.variantModeOf ? EV.variantModeOf(c) : (c.variantMode || 'auto');

  sel.value = mode;
  // 单变体事件的「变体」没有意义（只有一种结果），禁用并说明，别让用户白拉一下
  sel.disabled = vs.length < 2;
  if (modeHint) {
    modeHint.textContent = vs.length < 2
      ? (isEvent ? '该事件在库里只有 1 个变体，无需选择' : '只有原版事件才有变体')
      : (mode === 'locked'
          ? '固定播放下面选中的那一个（试听 / 时间轴 / 导出都用它）'
          : '每次播放随机挑一个（与原版游戏一致）');
  }

  if (vs.length < 2) {
    field.style.display = 'none';
    pick.innerHTML = '';
    if (pickHint) pickHint.textContent = '';
    return;
  }

  const idx = EV.lockedVariantIndex ? EV.lockedVariantIndex(c, vs.length) : 0;
  pick.innerHTML = vs.map((v, i) => {
    const vol = v.volume != null ? Number(v.volume).toFixed(2) : '1.00';
    const pit = v.pitch != null ? Number(v.pitch).toFixed(2) : '1.00';
    const fn = String(v.file || v.absPath || '').split(/[\\/]/).pop();
    return `<option value="${i}"${i === idx ? ' selected' : ''}>`
      + `${i + 1}/${vs.length} · ${esc(fn)}（音量 ${vol} / 音高 ${pit}）</option>`;
  }).join('');
  field.style.display = '';
  pick.disabled = mode !== 'locked';
  if (pickHint) {
    pickHint.textContent = mode === 'locked'
      ? `已指定第 ${idx + 1} 个变体（变体自带的音量 / 音高会一起生效）`
      : '当前是随机变体；切到「指定变体」后可在这里选中某一个';
  }
}

/**
 * 缩放提示：告诉用户当前视口能看多少秒。
 * 时间轴很长时，用户容易「以为内容没了」，这句提示能避免。
 */
function updateZoomFitHint() {
  const el = $('zoomVal');
  if (!el) return;
  const area = $('scrollArea');
  const viewMs = area ? area.clientWidth / STATE.zoom : 0;
  el.textContent = `${STATE.zoom.toFixed(2)} px/ms · 一屏约 ${(viewMs / 1000).toFixed(1)}s`;
}

/** 缩放到「整段时序刚好铺满视口」 */
function zoomToFit() {
  const area = $('scrollArea');
  if (!area) return;
  const total = totalMs();
  if (!total) return;
  const pad = 40;                                   // 两侧留白
  const z = Math.max(0.005, Math.min(2, (area.clientWidth - pad) / total));
  STATE.zoom = z;
  const rng = $('rngZoom');
  if (rng) rng.value = String(z);
  $('zoomVal').textContent = `${z.toFixed(2)} px/ms`;
  renderTimeline();
  updateZoomFitHint();
  status(`已缩放到适合窗口：整段 ${(total / 1000).toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
// 通用撤销 / 重做（卡 t_6b99a1fd）
//
// 为什么用「文档快照」而不是给每个动作写一份逆操作：
//   文档是纯 JSON（片段几十个、字段固定），快照的成本可以忽略；而逐动作逆操作要在
//   每个动作里手写反向逻辑（拆分 / 对齐 / 整组拖动 / 改总长……），漏写一个就会
//   「撤销出错误的结果」—— 比没有撤销更糟（用户信了它，位置就再也找不回来）。
//   快照法天然覆盖所有改动路径，而且新增动作不用改这里。
//
// 入口挂在 markDirty()：它是本项目所有改动的必经之路（既有约定：值真变了才调它）。
// 所以约定不变 —— 新动作只要照旧调 markDirty()，就自动进了撤销栈。
//
//   连续输入（备注 / 音量这些 input 事件）→ 同一类改动 900ms 内合并成一步；
//   一次拖拽（整组移动 / 改长度 / 拖总长边界）→ 交互开始时 beginUndoBatch()，
//     松手时 endUndoBatch()，整段只占一步（否则 undo 一次只退回一帧拖动，纯折磨）；
//   离散动作（删除 / 拆分 / 对齐 / 新建轨道……）→ 每次一步。
// ---------------------------------------------------------------------------
const UNDO_LIMIT = 80;                   // 栈上限：每步一份 JSON 快照，80 步足够「手滑了能退回去」
// 卡 t_c54d031b：'view' 也放进来 —— 角度数字框是一格一格敲的，900ms 内合并成一步，
// 否则「把 Y 从 -32 改成 20」会在撤销栈里留下好几步（拖动走 beginUndoBatch，本来就只有一步）。
const UNDO_COALESCE = new Set(['param', 'name', 'total', 'view']);   // 可以按时间合并的连续输入类
const UNDO = { past: [], future: [], lastJson: null, lastAt: 0, lastKind: '' };
// 撤销栈的基准就定在模块初始化这一刻（= 启动时那份空文档）：这样它不依赖 boot() /
// DOMContentLoaded 里的接线 —— app.js 被多张并行卡同时改，接线行被整文件写覆盖过一次
// （卡 t_6b99a1fd），少一处被覆盖的面就少一次「看着在、其实没接上」。
// 换工程（新建 / 打开）时各调一次 undoReset() 重新定基准。
let UNDO_BATCH = null;                   // { kind, pushed }：正在进行的连续交互
let SAVED_JSON = null;                   // 最近一次保存到磁盘时的文档；撤销回这一刻就是「干净」的
// 注意：这一句必须**放在上面两个 let 之后**。undoReset() 会写 UNDO_BATCH，
// 而 let 是 TDZ 的：放在声明之前调用会在页面加载时直接抛
// 「Cannot access 'UNDO_BATCH' before initialization」，整个 app.js 停摆
// （t_47b9fab2 自测时撞到过：那时 app 连 __MCS_STATE__ 都没挂上）。
undoReset();

const UNDO_LABELS = {
  delete: '删除片段', move: '移动片段', resize: '改片段长度', param: '修改片段参数',
  total: '修改总长', name: '修改工程名', add: '添加片段', track: '轨道改动',
  mute: '静音轨道', solo: '独奏轨道',
  paste: '粘贴片段', split: '拆分片段', align: '对齐到网格', lock: '锁定 / 解锁',
  visual: '导入视觉参考', visualDelete: '移除画面素材', op: '操作',
  // 卡 t_c54d031b：调整页里转模型 / 改角度 / 缩放 / 位移（撤销时用户要知道撤掉的是「角度」）
  view: '调整模型视角',
  // 卡 t_96cd9241：换动画模式（关键帧 / Molang）与换选中动画也写进工程文件，撤销时说清楚
  anim: '切换动画',
  animPlay: '切换动画预览方式',
  // 卡 t_47b9fab2：Alt + 拖边缘 = 非破坏性裁剪（只改源内起止，素材没丢）
  trim: '非破坏性裁剪',
  // 卡 t_c4491bba：这三项以前调用点没传 kind，撤销提示一律是含糊的「操作」。
  // 它们都是顶栏设置项（写进 timeline.json），用户需要看状态栏就知道刚才撤掉的是什么。
  bpm: '修改 BPM', grid: '修改网格', snap: '切换吸附',
  // D 键 / 右键「再复制一份」：与「添加片段 / 粘贴片段」区分开，用户才知道撤掉的是哪一步
  dup: '复制片段',
};

function docSnapshot() { return JSON.stringify(STATE.doc); }
function perfNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

/** 换工程（新建 / 打开）后清空历史：旧工程的快照绝不能撤回新工程里 */
function undoReset() {
  UNDO.past = [];
  UNDO.future = [];
  UNDO.lastJson = docSnapshot();
  UNDO.lastAt = 0;
  UNDO.lastKind = '';
  UNDO_BATCH = null;
}
function canUndo() { return UNDO.past.length > 0; }
function canRedo() { return UNDO.future.length > 0; }
function undoDepth() { return UNDO.past.length; }
function redoDepth() { return UNDO.future.length; }

/** 开始一段「连续交互」（拖拽）：期间所有改动合成一步 */
function beginUndoBatch(kind) { UNDO_BATCH = { kind: kind || 'op', pushed: false }; }
function endUndoBatch() { UNDO_BATCH = null; UNDO.lastKind = ''; UNDO.lastAt = 0; }

/**
 * 记一次改动。必须在改动**之后**调用（看的是「改完的文档」与「上一次记下的文档」是否相同），
 * 没变就什么都不做 —— 这样「点进输入框又原样离开」「拖出去又拖回来」都不会弄出空撤销步。
 */
function commitUndo(kind) {
  const cur = docSnapshot();
  if (UNDO.lastJson == null) { UNDO.lastJson = cur; return false; }
  if (cur === UNDO.lastJson) return false;

  const k = UNDO_BATCH ? UNDO_BATCH.kind : (kind || 'op');
  const now = perfNow();
  const coalesce = !UNDO_BATCH && k === UNDO.lastKind && UNDO_COALESCE.has(k)
    && (now - UNDO.lastAt) < 900;
  const batchDup = !!UNDO_BATCH && UNDO_BATCH.pushed;      // 批内后续改动不再单独入栈
  if (!coalesce && !batchDup) {
    UNDO.past.push({ json: UNDO.lastJson, kind: k });
    if (UNDO.past.length > UNDO_LIMIT) UNDO.past.shift();
  }
  if (UNDO_BATCH) UNDO_BATCH.pushed = true;
  UNDO.lastJson = cur;
  UNDO.lastAt = now;
  UNDO.lastKind = k;
  UNDO.future.length = 0;
  return true;
}

/**
 * 把「由 STATE.doc 派生的输入框 / 窗口标题」刷成文档当前值（卡 t_26c09aac 第二条）。
 *
 * 为什么必须有这一步：撤销 / 重做把 STATE.doc 整个换成快照，但这些控件不会自己跟着变 ——
 * 于是界面显示 A、文档其实是 B。而保存时导出读的是输入框（`doc.name = $('eName').value`，
 * 见 buildAllExports），下一次 Ctrl+S 就把 A 又写回文档，用户会以为「撤销那一步白按了」。
 * 「另存为」把它变成了保存之后立刻就能踩到的路径（另存为会改工程名 → 撤销改名的同时，
 * 输入框还留着新名字）。
 */
function syncDocInputsFromDoc() {
  const doc = STATE.doc;
  $('eName').value = doc.name || '';
  $('inpProjectName').value = doc.name || '';
  $('inpBpm').value = doc.config.bpm || 0;
  $('selGrid').value = doc.config.gridMode === 'beat' ? 'beat' : String(doc.config.gridMs);
  $('chkSnap').checked = !!doc.config.snapToGrid;
  $('inpTotalMs').value = doc.config.totalMs;
  updateWindowTitle();
}

/** 把文档换成快照内容（撤销 / 重做共用），并把选中集里已经不存在的片段剔掉 */
function applyDocJson(json) {
  STATE.doc = JSON.parse(json);
  const alive = new Set(STATE.doc.clips.map((c) => c.id));
  const keep = Array.from(STATE.selectedClipIds).filter((id) => alive.has(id));
  setSelection(keep, alive.has(STATE.selectedClipId) ? STATE.selectedClipId : null);
  // 撤销后总长可能变短：播放头不能停在时间轴之外
  const t = totalMs();
  if (STATE.playheadMs > t) STATE.playheadMs = t;
  syncDocInputsFromDoc();      // 输入框必须和文档一致（否则用户改的是错的那个数，保存还会把它写回去）
  // 视觉素材不是 JSON 内嵌数据：撤销/重做还原路径后，运行时播放器也必须随文档重建。
  // 不 await，避免快捷键卡住；恢复函数会自行把空状态与错误提示收口。
  void restoreVisualFromDoc(STATE.doc, null, { silent: true });
  renderTimeline();
  renderProps();
  revalidate();
  // 历史指针归位：这一步的「当前状态」就是刚恢复的快照，不能再被当成一次新改动入栈
  UNDO.lastJson = docSnapshot();
  UNDO.lastAt = perfNow();
  UNDO.lastKind = '';
  if (docSnapshot() === SAVED_JSON) markClean(); else markDirty();
  // 注意：上面这句 markDirty() 故意不带 kind —— 它不是「一次用户改动」，只是把
  // 撤销后的新状态同步成「脏 / 干净」。而且它不会污染撤销栈：上一句已经把
  // UNDO.lastJson 归位到刚恢复的快照，commitUndo() 立刻 cur === lastJson 返回 false。
  // 顺序要是反了（先 markDirty 再归位），这一步就会在 Ctrl+Z 自己的过程中又压进
  // 一条撤销步 —— 用户会陷入「撤销撤不回去」的循环（卡 t_c4491bba 顺手核过这里）。
}

function undo() {
  if (!UNDO.past.length) { status('没有可撤销的操作', canRedo() ? 'Ctrl+Y 可以重做' : ''); return 0; }
  const e = UNDO.past.pop();
  UNDO.future.push({ json: UNDO.lastJson, kind: e.kind });
  applyDocJson(e.json);
  status(`已撤销：${UNDO_LABELS[e.kind] || UNDO_LABELS.op}`,
    UNDO.past.length ? `还能撤销 ${UNDO.past.length} 步` : '已经回到最早的一步之前');
  return 1;
}

function redo() {
  if (!UNDO.future.length) { status('没有可重做的操作', canUndo() ? 'Ctrl+Z 可以撤销' : ''); return 0; }
  const e = UNDO.future.pop();
  UNDO.past.push({ json: UNDO.lastJson, kind: e.kind });
  applyDocJson(e.json);
  status(`已重做：${UNDO_LABELS[e.kind] || UNDO_LABELS.op}`,
    UNDO.future.length ? `还能重做 ${UNDO.future.length} 步` : '已经是最新的一步');
  return 1;
}

// ---------------------------------------------------------------------------
// 总长的唯一写入口（顶栏输入框 / 可拖拽边界条都走这里）
// ---------------------------------------------------------------------------
/**
 * 设置总长。
 *   · 吸附到当前网格（拖拽时手感才对，和片段拖动同一套规则）
 *   · 下限 = 最后一段音效的结束时间（卡面要求：不能缩到它前面）；请求值在下限之下时
 *     抬到下限并告诉用户为什么 —— 静默改数是这个项目最忌讳的一类问题
 *   · ms 总长是播放 / 边界的真值：正在播放时按新边界重新对齐一次
 * @returns { value, floor, clamped, changed }
 */
function setTotalMs(want, opts) {
  const o = opts || {};
  const cfg = STATE.doc.config;
  const floor = totalFloorMs();
  const grid = window.MCS.effectiveGridMs(cfg) || 50;
  const raw = Math.round(Number(want));
  let v = Number.isFinite(raw) ? raw : cfg.totalMs;
  if (o.snap !== false && cfg.snapToGrid) v = Math.round(v / grid) * grid;
  const clamped = v < floor;
  if (clamped) v = Math.ceil(floor / grid) * grid;      // 抬到下限之上，且落在网格线上
  if (v < MIN_TOTAL_MS) v = MIN_TOTAL_MS;

  const changed = v !== cfg.totalMs;
  cfg.totalMs = v;
  const inp = $('inpTotalMs');
  if (inp && String(inp.value) !== String(v)) inp.value = v;

  if (o.source === 'input' || o.source === 'drag') STATE.totalTouched = true;   // 用户亲手设过（GIF 导入不再覆盖）

  if (changed) {
    markDirty('total');
    // 正在播放：让音频按新边界重新排一次，否则「改了总长但这次播放还按老边界跑」。
    // 拖拽期间不重排（每挪一像素都重启音频会卡），松手时 endTotalDrag 统一收口。
    if (STATE.transport === 'playing' && o.source !== 'drag') {
      resumePlaybackAt(Math.min(STATE.playheadMs || 0, v));
    } else if (STATE.transport !== 'playing' && STATE.playheadMs > v) {
      STATE.playheadMs = v;
    }
  }
  if (o.render !== false) { renderTimeline(); if (!o.quiet) revalidate(); }
  return { value: v, floor, clamped, changed };
}

/**
 * 把「总长 >= 最后一段音效结束时间」这条不变式同步进 config：
 * 片段被拖到总长之外（拖动 / 方向键 / 属性面板改数值）时，总长跟着变长。
 * 只往上抬，绝不缩短 —— 缩短是用户的手动行为，必须走 setTotalMs（那里有下限提示）。
 */
function syncTotalBoundary() {
  const cfg = STATE.doc.config;
  const need = Math.ceil(clipsMaxEndMs());
  if (!(need > (cfg.totalMs || 0))) return false;
  cfg.totalMs = need;
  const inp = $('inpTotalMs');
  if (inp) inp.value = need;
  return true;
}

/** 标记有未保存改动（显示在窗口标题，避免误关丢失）；顺带把这次改动记进撤销栈 */
function markDirty(kind) {
  commitUndo(kind);          // 必须在下面那句提前返回之前：脏标记只亮一次，撤销步却要每次都记
  // 直接编辑也可能正好切回最后一次保存的快照（例如连续点两次 M / S）。
  // 此时仍要保留本次独立撤销步，但文档已与磁盘一致，必须把标题和主进程状态同步回干净。
  if (SAVED_JSON != null && docSnapshot() === SAVED_JSON) {
    markClean();
    return;
  }
  if (STATE.dirty) return;
  STATE.dirty = true;
  updateWindowTitle();
  syncDirtyToMain();
}

/** 标记已保存，清除未保存状态 */
function markClean() {
  STATE.dirty = false;
  SAVED_JSON = docSnapshot();      // 撤销回到这一刻 = 回到「没有未保存改动」
  updateWindowTitle();
  syncDirtyToMain();
}

/**
 * 把「有没有未保存改动」告诉主进程。
 * 关窗时主进程据此弹二次确认 —— 只在渲染进程标记是不够的，
 * 主进程必须在 before-quit 里能同步读到这个状态。
 */
function syncDirtyToMain() {
  try {
    if (window.mcs && window.mcs.setDirty) window.mcs.setDirty(STATE.dirty);
  } catch (e) { /* 忽略：测试环境可能没有这个 IPC */ }
}

/** 更新窗口标题：显示工程名 + 未保存标记 */
function updateWindowTitle() {
  const name = STATE.doc.name || '未命名时序';
  const suffix = STATE.dirty ? ' •' : '';
  const t = `${name}${suffix} — MCSoundStudio`;
  document.title = t;
  // Electron 下同步原生窗口标题（捕获异常：测试环境可能没有这个 IPC）
  try {
    if (window.mcs && window.mcs.setTitle) window.mcs.setTitle(t);
  } catch (e) { /* 忽略 */ }
}

function bindProps() {
  const get = () => STATE.doc.clips.find((x) => x.id === STATE.selectedClipId);
  const upd = (fn, opts) => {
    const c = get();
    if (!c) return;
    fn(c);
    // 属性面板的改动统一按 'param' 入撤销栈：同一个字段连续输入（音量 / 音高滑杆、
    // 备注）在 900ms 内会合并成一步，不会变成「敲一个字撤一次」（卡 t_6b99a1fd）
    markDirty('param');
    renderTimeline();
    if (!opts || opts.revalidate !== false) revalidate();
  };
  // 与 upd 一样，但**顺带重绘属性面板**：条长 / 倍速 / 源内起止 / 淡入淡出是联动的，
  // 改一个之后其它几个的显示值就过期了（被边界钳住时尤其要看得到真实结果）。
  const commit = (fn, kind) => {
    const c = get();
    if (!c) return null;
    fn(c);
    markDirty(kind || 'param');
    renderTimeline();
    revalidate();
    renderProps();
    return c;
  };

  $('pLabel').addEventListener('input', (e) => upd((c) => { c.label = e.target.value; }, { revalidate: false }));
  $('pSoundId').addEventListener('input', (e) => upd((c) => { c.soundId = e.target.value; }, { revalidate: false }));
  $('pStart').addEventListener('change', (e) => {
    // 负数没有意义，NaN 也不能写进文档（否则时间轴会算出奇怪的位置）
    const raw = Number(e.target.value);
    const v = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
    upd((c) => { c.startMs = v; });
    e.target.value = v;                       // 把规整后的值写回输入框，让用户看到实际结果
    status(`起始位置：${(v / 1000).toFixed(3)}s`);
  });
  // 改时长 = 等比改播放倍速（与拖右边缘完全同一套语义，卡 t_47b9fab2 第 1 条）：
  // 这里不再只是「把条拉长/压短」，否则从面板改和用鼠标拖会得到两种不同的结果。
  $('pDuration').addEventListener('change', (e) => {
    const c0 = get();
    if (!c0) return;
    const raw = Number(e.target.value);
    const v = Number.isFinite(raw) ? Math.max(MIN_DURATION_MS, Math.round(raw)) : MIN_DURATION_MS;
    const beforeDur = c0.durationMs;
    const beforeRate = rateOf(c0);
    const r = setStretchedDuration(c0, v);
    commit(() => { /* setStretchedDuration 已经改好了 */ }, 'resize');
    e.target.value = c0.durationMs;
    status(`时长：${beforeDur}ms → ${c0.durationMs}ms，播放速度 ${beforeRate.toFixed(2)}x → ${rateOf(c0).toFixed(2)}x（等比变速）`
      + (r && r.clamped ? '　⚠ 已到 0.25x~4x 倍速上限，声音会提前播完或在条尾被切断' : ''));
  });

  // ---- 裁剪：源内起止（非破坏性，素材不丢）----
  //   改「裁剪起点」= 片段起点往后挪、末尾不动（等价于 Alt 拖左边缘）
  if ($('pOffset')) {
    $('pOffset').addEventListener('change', (e) => {
      const c0 = get();
      if (!c0) return;
      const rate = rateOf(c0);
      const raw = Number(e.target.value);
      const want = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
      const cur = Math.max(0, c0.offsetMs || 0);
      const r = setTrimmedHead(c0, Math.round((want - cur) / rate));
      commit(() => { /* setTrimmedHead 已经改好了 */ }, 'trim');
      e.target.value = Math.max(0, c0.offsetMs || 0);
      status(`裁剪起点：源内 ${cur}ms → ${Math.max(0, c0.offsetMs || 0)}ms`
        + `（片段 ${(c0.startMs / 1000).toFixed(3)}s 起，末尾不动）`
        + (r && r.hitStart ? '　⚠ 已到源音频开头，不能再往前' : '')
        + (r && r.hitMin ? '　⚠ 片段长度已到最小值' : ''));
    });
  }
  //   改「裁剪终点」= 条长跟着素材走（倍速不变）；填到源音频结尾即恢复完整素材
  if ($('pSrcEnd')) {
    $('pSrcEnd').addEventListener('change', (e) => {
      const c0 = get();
      if (!c0) return;
      const total = srcTotalMs(c0);
      const inMs = Math.max(0, c0.offsetMs || 0);
      const raw = Number(e.target.value);
      const want = Number.isFinite(raw)
        ? Math.min(Math.max(Math.round(raw), inMs + 1), total)
        : total;
      const rate = rateOf(c0);
      commit((c) => {
        if (c.srcDurMs == null) c.srcDurMs = total;    // 钉住「最远能恢复到哪儿」
        c.srcEndMs = want >= total ? null : want;
        c.durationMs = Math.max(MIN_DURATION_MS, Math.round((want - inMs) / rate));
      }, 'trim');
      e.target.value = c0.srcEndMs != null ? c0.srcEndMs : total;
      status(`裁剪终点：源内 ${want}ms（源音频共 ${total}ms）—— 片段长度 ${c0.durationMs}ms，倍速不变 ${rate.toFixed(2)}x`
        + (want >= total ? '，已是完整素材' : '，拖右边缘可恢复'));
    });
  }

  // ---- 效果预设 + 淡入淡出（可见可选：片段条上也会画出斜坡）----
  if ($('pFadePreset')) {
    $('pFadePreset').addEventListener('change', (e) => {
      const id = e.target.value;
      if (id === 'custom') { e.target.value = matchFadePreset(get()); return; }   // 只是回显，不改动
      const c0 = get();
      if (!c0) return;
      const r = applyFadePreset(c0, id);
      commit(() => { /* applyFadePreset 已经改好了 */ }, 'param');
      status(`效果预设：${r.label} —— 淡入 ${r.inMs}ms / 淡出 ${r.outMs}ms`);
    });
  }
  const onFadeEdit = (which) => (e) => {
    const c0 = get();
    if (!c0) return;
    const raw = Number(e.target.value);
    const v = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
    const before = { in: Math.max(0, c0.fadeInMs || 0), out: Math.max(0, c0.fadeOutMs || 0) };
    commit((c) => {
      if (which === 'in') c.fadeInMs = v; else c.fadeOutMs = v;
      // 淡入 + 淡出不得超过条长：超了就把值收短（并如实写在状态栏里）
      normalizeFades(c);
      c.fadePreset = matchFadePreset(c);
    }, 'param');
    const clamped = which === 'in' ? before.in !== c0.fadeInMs : before.out !== c0.fadeOutMs;
    status(`淡入 ${c0.fadeInMs}ms / 淡出 ${c0.fadeOutMs}ms`
      + (clamped ? `　⚠ 两者之和不能超过片段长度 ${c0.durationMs}ms，已自动收短` : ''));
  };
  if ($('pFadeIn')) $('pFadeIn').addEventListener('change', onFadeEdit('in'));
  if ($('pFadeOut')) $('pFadeOut').addEventListener('change', onFadeEdit('out'));
  $('pVolume').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('pVolVal').textContent = v.toFixed(2);
    upd((c) => { c.volume = v; }, { revalidate: false });
  });
  $('pVolume').addEventListener('change', () => revalidate());
  $('pPitch').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('pPitchVal').textContent = v.toFixed(2);
    $('pPitchNum').value = v;
    upd((c) => { c.pitch = v; }, { revalidate: false });
  });
  $('pPitch').addEventListener('change', () => revalidate());
  $('pPitchNum').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    $('pPitch').value = Math.max(0.25, Math.min(4, v));
    $('pPitchVal').textContent = v.toFixed(2);
    upd((c) => { c.pitch = v; });
  });
  $('pNote').addEventListener('input', (e) => upd((c) => { c.note = e.target.value; }, { revalidate: false }));
  $('pTrack').addEventListener('change', (e) => upd((c) => { c.track = e.target.value; }));
  // 变体（卡 t_3623451f）：随机 / 指定两种模式 + 指定时列出库里的全部变体。
  // 用 commit（带 renderProps）而不是 upd：切模式后「指定哪一个」那个下拉要跟着
  // 启用 / 禁用、提示要跟着换，否则用户会面对一个看起来没反应的控件。
  $('pVariant').addEventListener('change', (e) => commit((c) => {
    const locked = e.target.value === 'locked';
    c.variantMode = locked ? 'locked' : 'auto';
    // 切到「指定变体」时必须有一个确定的下标，否则就会悄悄退回随机（用户以为锁上了）
    if (locked && c.lockedVariant == null) c.lockedVariant = 0;
  }));

  $('pVariantPick').addEventListener('change', (e) => commit((c) => {
    c.lockedVariant = Number(e.target.value) || 0;
    c.variantMode = 'locked';
  }));

  $('btnAudition').addEventListener('click', async () => {
    const c = get();
    if (!c) return;
    const resolved = resolveClipAudio(c);
    if (!resolved || !resolved.absPath) {
      status('这个片段找不到音频文件，无法试听',
             c.kind === 'event' ? `原版事件 ${c.soundId} 在当前音频库里没有对应文件` : '');
      setAudioHelpClickable(true);
      return;
    }
    // 变体自带的音量 / 音高必须一起生效 —— 时间轴播放就是这么算的（audio.js），
    // 试听少乘一次就会出现「试听听起来和播放不一样」（卡 t_3623451f）
    const vol = (c.volume != null ? c.volume : 1) * (resolved.volume != null ? resolved.volume : 1);
    const pit = (c.pitch != null ? c.pitch : 1) * (resolved.pitch != null ? resolved.pitch : 1);
    const h = await tryAudition(resolved.absPath, {
      volume: vol, pitch: pit,
    });
    if (h) {
      // 状态栏必须报「这次实际播了哪一个变体」：随机模式每次不同，不写清楚
      // 用户会以为指定没生效（反之亦然）
      statusAuditionOk('试听：' + c.label,
        [variantBadgeText(resolved), resolved.file].filter(Boolean).join(' · '));
    } else {
      // playOne 读不到文件时返回 null（不抛异常）：如实报「没读到文件」，
      // 别写「解码出错」这种把原因说错的含糊话（文件被删时也是走这条路）
      statusAuditionFailed(c.label);
    }
  });

  // 复制：把选中片段放进「剪贴板」，之后 Ctrl+V 可粘到播放头位置
  const btnCopyClip = $('btnCopyClip');
  if (btnCopyClip) btnCopyClip.addEventListener('click', () => copySelection());
  const btnCopyMulti = $('btnCopyMulti');
  if (btnCopyMulti) btnCopyMulti.addEventListener('click', () => copySelection());
  const btnDeleteMulti = $('btnDeleteMulti');
  if (btnDeleteMulti) btnDeleteMulti.addEventListener('click', () => deleteSelection());

  $('btnDeleteClip').addEventListener('click', () => deleteSelection());

}

/** 测试钩子：按路径导入自定义音频到库 */
window.__MCS_ADD_FILES__ = async (paths) => {
  const files = paths.map((p) => {
    const norm = String(p).replace(/\\/g, '/');
    const fname = norm.split('/').pop();
    const ext = '.' + fname.split('.').pop().toLowerCase();
    return {
      name: fname.slice(0, -ext.length),
      relPath: fname,
      absPath: p,
      ext,
      size: 0,
      kind: 'file',
      group: '自定义',
    };
  });
  addToLibrary(files);
  return files.length;
};

/** 测试钩子：把自定义音频加进时间轴（走真实路径） */
window.__MCS_ADD_CUSTOM__ = async (absPath, startMs, trackName) => {
  let dur = 500;
  try {
    const d = await AudioEngine.probeDuration(absPath);
    if (d) dur = d;
  } catch (e) { /* 用默认 */ }
  const norm = String(absPath).replace(/\\/g, '/');
  const label = norm.split('/').pop().replace(/\.[^.]+$/, '');
  const clip = makeClip({
    label,
    soundId: '',
    soundPath: absPath,
    kind: 'file',
    startMs,
    durationMs: dur,
    srcDurMs: dur,   // 源音频自然长度：非破坏性裁剪「最远能拖回哪儿」的边界（卡 t_47b9fab2）
    track: trackName || STATE.doc.tracks[0].name,
  });
  STATE.doc.clips.push(clip);
  setSelection([clip.id], clip.id);
  markDirty('add');        // 卡 t_c4491bba：带 kind（测试钩子走的是真实加片段路径）
  renderTimeline(); renderProps(); revalidate();
  return { id: clip.id, durationMs: dur };
};

/** 测试用：直接写到指定目录（跳过系统对话框） */
window.__MCS_EXPORT_ALL__ = async (dir) => {
  const all = buildAllExports();
  const files = [all.markdown, all.python, all.sounddef, all.soundfx, all.timeline];
  const r = await window.mcs.saveManyToDir({ dir, files });
  return r;
};

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
function revalidate() {
  const issues = validate(STATE.doc);

  // 合并「外部来源」的问题（模型解析、贴图、动画脏数据）。
  // 这些不是从 doc 里算出来的，必须单独存着再合进来 ——
  // 否则每次 revalidate() 都会把它们清掉，面板会骗人说「没有发现问题」。
  if (Array.isArray(STATE.assetIssues)) issues.push(...STATE.assetIssues);

  // 附加：动画骨骼校对（每次都重算，因为它依赖模型与动画的当前组合）
  if (STATE.bbInfo && STATE.animInfos.length) {
    const cc = crossCheckBones(STATE.bbInfo, STATE.animInfos);
    if (cc.missingInModel.length) {
      issues.push({
        level: 'warn',
        message: `动画里有 ${cc.missingInModel.length} 个骨骼在模型中找不到：${cc.missingInModel.slice(0, 8).join(', ')}${cc.missingInModel.length > 8 ? ' …' : ''}`,
      });
    }
    // 反向信息也值得说：模型里有骨骼但动画完全没用到，
    // 通常意味着动画做漏了，或模型里有不需要动的部件
    if (!cc.missingInModel.length && cc.unusedInAnim && cc.unusedInAnim.length) {
      issues.push({
        level: 'info',
        message: `模型里有 ${cc.unusedInAnim.length} 个骨骼在动画中没有关键帧（${cc.unusedInAnim.slice(0, 6).join(', ')}${cc.unusedInAnim.length > 6 ? ' …' : ''}）。`
          + `如果这些部件本该动，说明动画做漏了；如果本来就该静止，可以忽略。`,
      });
    }
    if (cc.matched && cc.matched.length) {
      issues.push({
        level: 'ok',
        message: `动画与模型匹配的骨骼：${cc.matched.length} 个。`,
      });
    }
  }

  STATE.issues = issues;
  const errs = issues.filter((i) => i.level === 'error').length;
  const warns = issues.filter((i) => i.level === 'warn').length;
  const infos = issues.filter((i) => i.level === 'info').length;

  const badge = $('issueBadge');
  badge.textContent = issues.length;
  badge.classList.toggle('has-issue', errs + warns > 0);

  const list = $('issueList');
  if (!issues.length) {
    list.innerHTML = '<div class="empty-hint">没有发现问题 ✓</div>';
  } else {
    const order = { error: 0, warn: 1, info: 2, ok: 3 };
    const sorted = issues.slice().sort((a, b) => order[a.level] - order[b.level]);
    list.innerHTML = sorted.map((i) => {
      const label = { error: '错误', warn: '警告', info: '提示', ok: '正常' }[i.level] || i.level;
      return `<div class="issue-item ${i.level}" ${i.clipId ? `data-clip="${esc(i.clipId)}"` : ''}>
                <div class="ii-head">${label}</div>
                <div>${esc(i.message)}</div>
              </div>`;
    }).join('');
    list.querySelectorAll('.issue-item[data-clip]').forEach((el) => {
      el.addEventListener('click', () => {
        setSelection([el.dataset.clip], el.dataset.clip);
        renderTimeline(); renderProps();
      });
    });
  }

  // 状态栏右侧：给用户真正关心的信息。
  // 「250px/秒」是像素刻度，对使用者没有意义；总时长才是编排时要看的。
  {
    const secs = (STATE.doc.config.totalMs / 1000).toFixed(1);
    const parts = [
      `${STATE.doc.clips.length} 个音效`,
      `${STATE.doc.tracks.length} 轨道`,
      `总长 ${secs}s`,
    ];
    if (errs + warns > 0) parts.push(`${errs} 错 ${warns} 警`);
    else if (STATE.doc.clips.length) parts.push('无问题');
    setStatusRight(parts.join(' · '));
  }
}

// ---------------------------------------------------------------------------
// 导入：GIF / 模型 / 动画
// ---------------------------------------------------------------------------
async function importGif(filePath, opts) {
  const o = opts || {};          // { noStep: true } = 恢复工程时用，别把用户从当前页带走
  // 「恢复」只重建运行时播放器 / 画布，绝不能把它当成一次新的导入。
  // 特别是 GIF 的 dataUrl 只供本次会话显示，回存时会被剔除；恢复时若重新写它，
  // 文档快照就会与刚读入的磁盘文件不同，随后既会把总长按自然时长改掉，也会误亮脏标记。
  const restoring = !!o.restore;
  const lower = String(filePath).toLowerCase();

  // 视频走 <video>：原生 seek 精确，同步比 GIF 还简单可靠
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(lower)) {
    return importVideo(filePath, o);
  }
  // 静态图片：只当参考图，不参与同步
  if (/\.(png|jpg|jpeg|bmp|webp)$/.test(lower)) {
    return importStillImage(filePath, o);
  }

  const r = await window.mcs.readBinaryFile(filePath);
  if (!r.ok) { status('读取失败：' + r.error); return; }
  if (!restoring) {
    STATE.doc.visual.kind = 'gif';
    STATE.doc.visual.path = filePath;
    STATE.doc.visual.mediaPath = filePath;
    STATE.doc.visual.dataUrl = r.dataUrl;
  }

  const img = $('previewGif');
  const canvas = $('previewCanvas');
  const emptyEl = $('previewEmpty');

  // 优先走真正的帧解码路径（可暂停 / 可任意 seek）
  const raw = await window.mcs.readRawBytes(filePath);
  if (window.MCS_GIF && raw && raw.ok && raw.bytes) {
    let ab;
    if (raw.bytes instanceof Uint8Array) ab = raw.bytes.buffer;
    else if (raw.bytes instanceof ArrayBuffer) ab = raw.bytes;
    else if (raw.bytes.buffer) ab = raw.bytes.buffer;

    try {
      const gif = window.MCS_GIF.parseGif(ab);
      if (gif.frameCount > 0) {
        img.style.display = 'none';
        $('previewVideo').style.display = 'none';
        STATE.videoEl = null;
        canvas.style.display = 'block';
        const rend = window.MCS_GIF.makeRenderer(canvas, gif);
        const player = window.MCS_GIF.createPlayer(gif, (i) => rend.renderTo(i));

        STATE.gifPlayer = player;
        STATE.gifRenderer = rend;          // 切回 GIF 时要按 GIF 尺寸重画（卡 t_fa17801d）
        STATE.gifAnim = gif;
        STATE.gifFrames = gif.frames;
        STATE.gifNativeMs = gif.totalMs;
        STATE.gifTotalMs = gif.totalMs;
        // 有模型时默认仍显示 GIF（GIF 行为不变）；想按播放头看模型动作就用
        // 预览区那枚「看模型」按钮切过去，两边都保留。
        STATE.visualMode = 'gif';
        updateVisualSwitchButton();
        // 画面素材是文档的一部分（visual.mediaPath 会写进工程文件），用户新导入成功
        // 就要标脏 + 进撤销栈；但打开工程时这里只是在恢复播放器，不能制造一次假改动。
        if (!restoring) markDirty('visual');

        // 说明：GIF 与时间轴是 1:1 对应的（不做压缩/拉伸）。
        // 时间轴比 GIF 长时，播放头越过 GIF 末尾就停在最后一帧，
        // 元信息里会写明"已放完"，免得用户以为画面卡死。
        emptyEl.style.display = 'none';
        $('metaVisual').textContent =
          `视觉：GIF (${(gif.totalMs / 1000).toFixed(2)}s, ${gif.frameCount}帧)`;

        // 导入的视觉素材就是这段动画的全部长度，总线默认对齐它 ——
        // 否则 5s 的 GIF 配 5s 时间轴之外的空白，用户还得手动改总长。
        // 只在没有任何片段时才自动设，避免覆盖用户已经排好的内容。
        const newTotal = Math.ceil(gif.totalMs / 100) * 100;
        let totalChanged = false;
        // 总长的初值跟着 GIF 走（卡 t_6b99a1fd）；但用户如果**已经亲手设过**总长
        // （改过输入框 / 拖过边界条），就绝不再覆盖他 —— 那正是「用户可修改总长」的语义。
        if (!restoring && STATE.doc.clips.length === 0 && !STATE.totalTouched
            && STATE.doc.config.totalMs !== newTotal) {
          STATE.doc.config.totalMs = newTotal;
          $('inpTotalMs').value = newTotal;
          totalChanged = true;
        }

        if (!restoring) {
          status(
            `已导入 GIF：${gif.frameCount} 帧 / ${(gif.totalMs / 1000).toFixed(2)}s` +
              (totalChanged ? `，总长已设为 ${newTotal}ms` : ''),
            '暂停时 GIF 会一起定格，拖动标尺可前后查看任意进度'
          );
        }
        landOnAdjust(o);       // 规格 §1.1：导入画面素材 = 调整素材的动作，落到「① 模型/GIF 调整」
        // 导入后按当前播放头定位一次（可能是导入前停下的位置），再启动驱动器
        syncVisualTo(STATE.playheadMs || 0);
        setupGifSync();
        renderTimeline();
        return;
      }
    } catch (e) {
      console.warn('GIF 解码失败，回退到 img 方案：', e);
    }
  }

  // 回退：至少能显示（但不能精确 seek）
  if (window.MCS_GIF) {
    STATE.gifPlayer = null;
    STATE.gifRenderer = null;
    STATE.gifAnim = null;
  }
}

/**
 * 视频导入：用 <video> 原生播放。
 * 好处是 currentTime 可以精确设置，暂停/拖动同步比 GIF 还简单可靠。
 */
async function importVideo(filePath, opts) {
  const o = opts || {};
  const video = $('previewVideo');
  const canvas = $('previewCanvas');
  const img = $('previewGif');

  canvas.style.display = 'none';
  img.style.display = 'none';
  video.style.display = 'block';

  STATE.doc.visual.kind = 'video';
  STATE.doc.visual.path = filePath;
  STATE.doc.visual.mediaPath = filePath;
  STATE.gifPlayer = null;
  STATE.gifRenderer = null;
  STATE.gifAnim = null;
  STATE.visualMode = 'video';
  updateVisualSwitchButton();

  const url = toFileUrl(filePath);
  video.src = url;

  await new Promise((resolve) => {
    const done = () => resolve();
    video.onloadedmetadata = done;
    video.onerror = done;
    setTimeout(done, 6000);       // 超时兜底，避免卡住
    video.load();
  });

  if (!video.duration || !isFinite(video.duration)) {
    status('视频读取失败或格式不支持', filePath);
    video.style.display = 'none';
    return;
  }

  STATE.videoEl = video;
  STATE.videoMs = video.duration * 1000;
  markDirty('visual');          // 同上：视频也是文档里的素材槽，导入成功即算一次改动

  $('previewEmpty').style.display = 'none';
  $('metaVisual').textContent =
    `视觉：视频 (${video.duration.toFixed(2)}s)`;
  status(
    `已导入视频：${video.duration.toFixed(2)}s`,
    '暂停时视频会一起定格，拖动标尺可前后查看任意进度'
  );
  landOnAdjust(o);

  video.currentTime = 0;
  setupVideoSync();
  renderTimeline();
}

/** 静态图片：只作为参考图显示，不参与同步 */
async function importStillImage(filePath, opts) {
  const o = opts || {};
  const r = await window.mcs.readBinaryFile(filePath);
  if (!r.ok) { status('读取失败：' + r.error); return; }

  const img = $('previewGif');
  const canvas = $('previewCanvas');
  const video = $('previewVideo');
  canvas.style.display = 'none';
  video.style.display = 'none';
  img.style.display = 'block';

  img.src = r.dataUrl;
  STATE.doc.visual.kind = 'image';
  STATE.doc.visual.path = filePath;
  STATE.doc.visual.mediaPath = filePath;
  STATE.gifPlayer = null;
  STATE.gifRenderer = null;
  STATE.gifAnim = null;
  STATE.visualMode = 'image';
  updateVisualSwitchButton();
  markDirty('visual');          // 同上：图片也是文档里的素材槽

  $('previewEmpty').style.display = 'none';
  $('metaVisual').textContent = '视觉：图片（不参与进度同步）';
  status('已导入参考图', '图片不参与时间同步，只作为画面参考');
  landOnAdjust(o);
  renderTimeline();
}

/** 把本地路径转成 file:// URL（Windows 盘符要补前导斜杠） */
function toFileUrl(p) {
  let s = String(p).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return 'file://' + encodeURI(s);
}

async function importBBModel(filePath, opts) {
  const o = opts || {};
  const r = await window.mcs.readTextFile(filePath);
  if (!r.ok) {
    // 读不到文件也是「导入失败」，同样给能看懂的诊断（卡 t_fa17801d）
    showImportDiagnosis(MCS_PARSERS.diagnoseModelFile(null, r.error, filePath));
    status('模型读取失败', filePath);
    return;
  }

  // ---- 解析 + 结构诊断：失败不再丢一段 V8 堆栈，而是「第几行不对 / 是不是导错按钮 / 怎么修」
  let bbInfo = null;
  let parseError = null;
  try {
    bbInfo = parseBBModel(r.content);
  } catch (e) {
    parseError = e;
  }
  if (parseError) {
    const diag = MCS_PARSERS.diagnoseModelFile(r.content, parseError, filePath);
    showImportDiagnosis(diag);
    status('模型解析失败：' + diag.title, filePath);
    return;
  }
  const structDiag = MCS_PARSERS.diagnoseModelFile(r.content, null, filePath);
  if (structDiag) {
    // 语法没问题，但结构根本不是模型（导错按钮 / 纯贴图工程 / 无关 JSON）
    showImportDiagnosis(structDiag);
    status(structDiag.title, filePath);
    return;
  }

  try {
    STATE.bbInfo = bbInfo;

    // ---- 真的画到预览画布上（本卡的核心：不许只停在"解析成功"）----
    const mv = await MCS_MODELPREVIEW.loadModelText(r.content, filePath);

    const lines = mv.report.slice();
    if (STATE.bbInfo.boundingBox) {
      lines.push('');
      lines.push(`包围盒：${JSON.stringify(STATE.bbInfo.boundingBox.min)} → ${JSON.stringify(STATE.bbInfo.boundingBox.max)}`);
    }
    if (STATE.bbInfo.duplicateElementNames.length) {
      lines.push('');
      lines.push(`⚠️ 重复的非 cube 元素名：${STATE.bbInfo.duplicateElementNames.join(', ')}`);
    }

    const exportBones = STATE.bbInfo.groups.filter((g) => g.export).length;
    $('metaBones').textContent = `骨骼：${exportBones}`;

    // 空模型要明确警告：Blockbench 的 image/贴图工程本来就没有元素，
    // 静默接受会让用户以为导入失败却又找不到原因
    const isEmptyModel = STATE.bbInfo.elementCount === 0 && STATE.bbInfo.groupCount === 0;
    if (isEmptyModel) {
      lines.push('');
      lines.push('⚠️ 这个模型里没有任何元素和骨骼。');
      lines.push(`   model_format = ${STATE.bbInfo.modelFormat || '(空)'}`);
      lines.push('   如果它是纯贴图工程（image/skin 类型），本来就不含几何体；');
      lines.push('   如果你想对齐动画骨骼，请改用真正的模型文件（.bbmodel 里带立方体）。');
    }

    if (!o.silent) openModal('模型解析结果：' + filePath.split(/[\\/]/).pop(), lines.join('\n'));
    const modelLabel = STATE.bbInfo.name || baseName(filePath);
    if (o.silent) {
      // 恢复工程不弹窗（规格 §4）。只有「打开工程」补一句状态栏说明；
      // 撤销 / 重做也走这条路径，那时状态栏已经写着「已撤销：…」，这里不抢那句。
      if (o.announceRestore) {
        const rv = currentView();
        status(`已恢复画面：模型「${modelLabel}」`,
          `角度 X=${fmtDeg(rv.x)} / Y=${fmtDeg(rv.y)} / Z=${fmtDeg(rv.z)} · 缩放 ${rv.zoom.toFixed(2)}×`
          + ' —— 要改角度去「① 模型/GIF 调整」');
      }
    } else {
      // 用户点的导入 → 自然落在「① 模型/GIF 调整」（规格 §1.1 的逐字提示）
      landOnAdjust(o);
      status(
        isEmptyModel
          ? '模型导入成功，但它是空模型（无几何体）—— 画布上没有可显示的东西'
          : `已导入模型「${modelLabel}」—— 拖动画布调好角度，然后点「② 音效」回去配音效`,
        isEmptyModel ? '详见弹窗说明' : '右侧「角度」可微调，「重置角度」回默认视角'
      );
    }

    // 贴图问题：先清掉上一轮模型留下的贴图类问题，再写入本次的，
    // 否则连续导入多个模型会累积一堆已经不适用的告警
    const texIssues = checkTextures(STATE.bbInfo.textures);
    STATE.assetIssues = STATE.assetIssues.filter((i) => !i.fromTexture && !i.fromModel);
    if (isEmptyModel) {
      STATE.assetIssues.push({
        level: 'warn',
        fromModel: true,
        message: `导入的模型「${STATE.bbInfo.name || filePath.split(/[\\/]/).pop()}」不含任何元素和骨骼，动画骨骼无法与模型校对。`,
      });
    }
    for (const t of texIssues) {
      if (t.level !== 'ok') {
        STATE.assetIssues.push({
          level: t.level === 'error' ? 'error' : 'warn',
          fromTexture: true,
          message: `贴图「${t.name}」：${t.message}`,
        });
      }
    }
    // 贴图「读不到 / 解不开」也要说清楚（预览里会用纯色代替，但不能不吭声）
    for (const i of (mv.issues || [])) {
      STATE.assetIssues.push({ level: i.level === 'error' ? 'error' : 'warn', fromTexture: true, message: i.message });
    }

    // 视觉参考记成「模型」，这样工程存盘后重开还能把模型画回来。
    // modelPath 单独存一份：visual.kind 只有一个值，用户后面再导入 GIF 时
    // kind 会变成 gif（既有行为），但「这个工程用过哪个模型」不该因此丢掉。
    // 模型和画面素材各有独立引用；已有 GIF/视频/图片时不能把它的 kind/path 覆盖掉。
    if (!STATE.doc.visual.mediaPath) {
      STATE.doc.visual.kind = 'model';
      STATE.doc.visual.path = filePath;
    }
    STATE.doc.visual.modelPath = filePath;
    setVisualMode(isEmptyModel ? STATE.visualMode : 'model');
    if (!isEmptyModel) updateVisualSwitchButton();
    markDirty('visual');        // 同上：模型路径也写进工程文件
    revalidate();
    // 模型自带动画刚登记进目录（卡 t_96cd9241）：刷两档列表 + 对齐选中态。
    // persist:false —— 导入模型不自动替用户选动画（画布仍按静止姿态），列表列在那里由用户点。
    // 但工程文件里本来记着 animName 的话，这里会照着它把那条选回来（重开工程 / 撤销重做）。
    reconcileAnimSelection({ persist: false });
  } catch (e) {
    const diag = MCS_PARSERS.diagnoseModelFile(r.content, e, filePath);
    showImportDiagnosis(diag);
    status('模型导入失败：' + diag.title, filePath);
  }
}

/**
 * silent 恢复路径的失败处理（卡 t_96cd9241）：
 * 重开工程时「工程里记的那份 .animation.json 读不到 / 不是动画文件」不许弹诊断弹窗
 * （规格 §4 对模型报告弹窗的同一条规定），改成状态栏一句话 + 一条可查的问题记录。
 * 弹窗只留给用户主动导入时用。
 */
function animRestoreFailure(diag, filePath, why) {
  STATE.assetIssues = STATE.assetIssues.filter((i) => !i.fromAnim);
  STATE.assetIssues.push({
    level: 'warn',
    fromAnim: true,
    message: `工程里记的动画文件「${filePath}」现在用不了（${why}）—— 画布上没有动画可播，其余内容不受影响。`,
  });
  revalidate();
  status('工程里记的动画读不到：' + why, filePath);
  return diag;
}

async function importAnimation(filePath, opts) {
  const o = opts || {};
  const r = await window.mcs.readTextFile(filePath);
  if (!r.ok) {
    // 读不到文件：同样给能看懂的诊断（卡 t_fa17801d）；恢复路径只说话不弹窗
    const diag = MCS_PARSERS.diagnoseAnimationFile(null, r.error, filePath);
    if (o.silent) { animRestoreFailure(diag, filePath, r.error || '读不到文件'); return; }
    showImportDiagnosis(diag);
    status('动画读取失败', filePath);
    return;
  }
  try {
    const parsed = parseAnimationJson(r.content);
    const dirty = detectAnimationDirtyData(r.content);
    // 语法没问题、但结构不是动画（导错按钮 / 没有 animations / 无关 JSON）
    const structDiag = MCS_PARSERS.diagnoseAnimationFile(r.content, null, filePath);
    if (structDiag) {
      if (o.silent) { animRestoreFailure(structDiag, filePath, structDiag.title); return; }
      showImportDiagnosis(structDiag);
      status(structDiag.title, filePath);
      return;
    }
    STATE.animInfos = parsed.animations;
    STATE.animFile = filePath;

    const lines = [];
    lines.push(`文件：${filePath}`);
    lines.push(`格式版本：${parsed.formatVersion}`);
    lines.push(`动画条数：${parsed.animations.length}`);
    lines.push('');
    for (const a of parsed.animations) {
      lines.push(`── ${a.name}`);
      lines.push(`   时长：${a.lengthMs}ms (${a.lengthSec}s)  = ${msToTick(a.lengthMs)} tick`);
      lines.push(`   循环：${a.loop === true ? 'loop（循环）' : a.loop === 'hold_on_last_frame' ? 'hold_on_last_frame（停在末帧）' : a.loop === false ? 'once（播放一次）' : a.loop}`);
      lines.push(`   骨骼：${a.boneNames.length} 个 → ${a.boneNames.join(', ')}`);
      if (a.interpolations.length) lines.push(`   插值模式：${a.interpolations.join(', ')}`);
      lines.push(`   关键帧时间点（${a.keyTimesMs.length} 个）：${a.keyTimesMs.slice(0, 30).join(', ')}${a.keyTimesMs.length > 30 ? ' …' : ''}`);
      lines.push('');
    }

    if (dirty.length) {
      lines.push('═══ ⚠️ 检测到脏数据 ═══');
      lines.push('以下数值包含多余空白字符，Blockbench 能容忍但严格解析会出错：');
      lines.push('');
      for (const d of dirty) {
        lines.push(`  · ${d.message}`);
      }
      lines.push('');
      lines.push('建议：回 Blockbench 里检查这些关键帧并重新输入数值。');
    }

    // ---- 动画 → 预览画布（卡 t_fa17801d 核心之一）----
    // 以前这里只「解析出时长和骨骼名」，画布什么都不变；现在把动画变成可采样的
    // 轨道，按播放头时刻套到画布上的模型上。
    const mv = MCS_MODELPREVIEW.loadAnimationText(r.content, filePath);
    // 指定选中哪一条（卡 t_96cd9241 的恢复路径用；不指定就是老行为「最长那条」）
    if (o.selectName) {
      const want = MCS_MODELPREVIEW.find(o.selectName, filePath);
      if (want) MCS_MODELPREVIEW.select(want);
    }
    lines.push('');
    if (MCS_MODELPREVIEW.scene) {
      lines.push(`✔ 已套用到预览画布上的模型「${MCS_MODELPREVIEW.scene.name || '(无名)'}」`
        + `（选中动画：${MCS_MODELPREVIEW.animName || '(无)'}）—— 拖播放头 / 播放即可看到骨骼动作`);
    } else {
      lines.push('⚠ 还没有导入模型：动画已经解析出来了，但画布上没有可以摆姿态的模型。');
      lines.push('   先点「导入模型」选对应的 .bbmodel，动作就会出现在画布上。');
    }

    // silent（重开工程恢复动画）：不弹窗、不改总长、不标脏 —— 恢复过程不产生新状态
    // （规格 §4：改成状态栏一句话，那句在 restoreVisualFromDoc 里说）。
    if (!o.silent) openModal('动画解析结果', lines.join('\n'));

    // 把最长动画的长度设为时间轴总长。
    // 只写 config.totalMs（顶栏那个数），**不再写 visual.naturalMs** ——
    // 以前 naturalMs 优先级高于顶栏的「总长(ms)」，导入一次动画后用户再改总长就没反应了
    // （播放边界 / 时间显示 / 灰尾几何全都还按素材时长算，卡 t_6b99a1fd）。
    // 素材自身长度只作为动画列表里的展示，不参与边界计算。
    if (!o.silent && STATE.animInfos.length) {
      const longest = STATE.animInfos.reduce((a, b) => (a.lengthMs > b.lengthMs ? a : b));
      STATE.doc.visual.animName = longest.name;
      STATE.doc.visual.animFile = filePath;
      if (longest.lengthMs > STATE.doc.config.totalMs) {
        // snap:false —— 素材天然长度不吸附网格（对齐动画本来就该精确）
        setTotalMs(longest.lengthMs, { source: 'anim', snap: false, quiet: true });
      }
      $('metaDuration').textContent = `总时长：${longest.lengthMs}ms`;
    }

    // 脏数据推进校验：同样先清掉上一轮动画的问题，避免反复导入后累积
    STATE.assetIssues = STATE.assetIssues.filter((i) => !i.fromAnim);
    for (const d of dirty) {
      STATE.assetIssues.push({ level: 'warn', fromAnim: true, message: d.message });
    }
    // 采样层发现的问题（例如「没有任何关键帧」→ 画布上不会动）
    for (const i of (mv.issues || [])) {
      STATE.assetIssues.push({ level: 'warn', fromAnim: true, message: i.message });
    }

    // 骨骼校对
    if (STATE.bbInfo) {
      const cc = crossCheckBones(STATE.bbInfo, STATE.animInfos);
      lines.length = 0;
      lines.push(`匹配到的骨骼（${cc.matched.length}）：${cc.matched.join(', ') || '（无）'}`);
      lines.push('');
      lines.push(`动画有但模型没有（${cc.missingInModel.length}）：${cc.missingInModel.join(', ') || '（无）'}`);
      lines.push('');
      lines.push(`模型有但动画没用（${cc.unusedInAnim.length}）：${cc.unusedInAnim.join(', ') || '（无）'}`);
      $('metaBones').textContent = `骨骼：${cc.matched.length} 匹配`;
      console.log('骨骼校对：', lines.join('\n'));
    }

    renderTimeline();
    revalidate();
    // 两档列表 / 画布选中态对齐（卡 t_96cd9241）。persist:false —— 非 silent 路径上面
    // 已经写过 animName/animFile，silent 路径本来就不许写文件。
    reconcileAnimSelection({ persist: false });
    if (o.silent) return { ok: true, anims: STATE.animInfos.length };
    // 导入动画 = 「我要看这段动作」：画布上有模型就切到模型预览。
    // 这不是破坏 GIF 预览 —— GIF 的播放器、帧缓存、同步都还在，
    // 预览区那枚「看 GIF」按钮一点就回到 GIF（两个视觉参考都不丢）。
    const seg = MCS_MODELPREVIEW.scene;
    if (seg) {
      setVisualMode('model');
      status(`已导入动画：${STATE.animInfos.length} 条 —— 已套用到画布上的模型「${seg.name || '(无名)'}」`,
             '拖动标尺逐帧看姿态；点「看 GIF」可切回 GIF 预览');
    } else {
      status(`已导入动画：${STATE.animInfos.length} 条`, '还没有模型，画布上没有可动的模型');
    }
    landOnAdjust(o);      // 规格 §1.1：导入动画也是「调整素材」的动作，落到调整页
    } catch (e) {
    const diag = MCS_PARSERS.diagnoseAnimationFile(r.content, e, filePath);
    showImportDiagnosis(diag);
    status('动画导入失败：' + diag.title, filePath);
    }
    }

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------
let modalContent = '';
let modalName = 'export.txt';

function openModal(title, content, saveName) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent = content;
  modalContent = content;
  if (saveName) modalName = saveName;
  $('modal').style.display = 'flex';
}
function closeModal() { $('modal').style.display = 'none'; }

/**
 * 统一的「导入失败」呈现（卡 t_fa17801d）。
 * 以前这里只丢 `String(e.stack)`，用户看到的是
 * 「Unexpected token '，' ... is not valid JSON」这种开发者文案；
 * 现在弹窗标题直接说明是什么问题，正文给「位置 / 可能原因 / 怎么办」。
 */
function showImportDiagnosis(diag) {
  if (!diag) return null;
  openModal(diag.title || '导入失败', (diag.lines || []).join('\n'));
  return diag;
}



/**
 * 试听音频未就位时的引导弹窗。
 * 目标：让用户一眼看懂「为什么没声音」+「该把文件夹放哪」，
 * 而不是丢一段路径让他自己找。
 */
function openAudioHelpModal() {
  const as = STATE.audioMissing || {};
  // 运行中音频才被删/被移走时 STATE.audioMissing 是空的（加载库那一刻还是好的），
  // 这时用「上次成功加载记住的目录」把路径补上，别给用户一个空框（卡 t_8c74ddef）。
  const dir = as.dir || STATE.audioDir || '';
  const reason = as.reason === 'empty-dir'
    ? '找到了音频文件夹，但里面没有 .ogg 文件。'
    : as.reason === 'missing-dir'
      ? '没有找到音频文件夹。'
      : '之前能读到的音频文件夹，现在读不到了 —— 多半是被删掉 / 被移走，或者解包目录被别的实例重新解包了。';

  $('modalTitle').textContent = '试听没有声音？';
  $('modalBody').innerHTML = `
    <p style="margin:0 0 10px"><b>${reason}</b></p>
    <p style="margin:0 0 12px">
      音效库的<b>名称、中文分类、事件 ID 都已经内置</b>，所以左侧列表能正常看、
      拖进时间轴、改参数、导出 —— 这些都不受影响；没有音频时只有<b>点「试听」</b>会没声音。<br>
      试听音频（约 700MB）正常情况下是<b>跟着程序一起提供</b>的（正式版为自带音频的单个
      exe），所以一般不会看到这个弹窗；看到就说明程序没找到这份音频 —— 多半是内置音频
      被删掉了，或者解包目录不完整（只拷了 exe、没带上同目录的 <code>resources</code> 文件夹）。
    </p>
    <p style="margin:0 0 6px"><b>怎么修好：</b></p>
    <ol style="margin:0 0 12px;padding-left:20px;line-height:1.7">
      <li>点下面的按钮打开音频文件夹</li>
      <li>把音频文件夹里的内容（<code>block/</code> <code>mob/</code> <code>ambient/</code> 等）整个拷进去</li>
      <li>重启本程序，试听就有声音了</li>
    </ol>
    <p style="margin:0 0 6px">音频应该放在这里：</p>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
      <input id="audioDirPath" readonly value="${dir.replace(/"/g, '&quot;')}"
             style="flex:1;font-family:monospace;font-size:12px;padding:6px 8px;
                    border:1px solid var(--border,#444);border-radius:4px;
                    background:transparent;color:inherit">
      <button id="btnCopyAudioDir" class="tp-btn wide">复制</button>
    </div>
    <div style="display:flex;gap:8px">
      <button id="btnOpenAudioDir" class="tp-btn wide">打开这个文件夹</button>
      <button id="btnReloadAudio" class="tp-btn wide">我已放好，重新加载</button>
    </div>
    <p style="margin:14px 0 0;opacity:.75;font-size:12px">
      提示：音频目录里的子文件夹结构要保持原样，程序会自动在里面递归查找。
    </p>
  `;
  $('modal').style.display = 'flex';

  const copyBtn = $('btnCopyAudioDir');
  if (copyBtn) copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(dir);
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    } catch (e) {
      const inp = $('audioDirPath');
      if (inp) { inp.select(); document.execCommand('copy'); copyBtn.textContent = '已复制'; }
    }
  };

  const openBtn = $('btnOpenAudioDir');
  if (openBtn) openBtn.onclick = async () => {
    const r = await window.mcs.openAudioFolder();
    if (!r || !r.ok) {
      openBtn.textContent = '打开失败，请按上面的路径手动打开';
      setTimeout(() => { openBtn.textContent = '打开这个文件夹'; }, 2500);
    }
  };

  const reloadBtn = $('btnReloadAudio');
  if (reloadBtn) reloadBtn.onclick = async () => {
    reloadBtn.textContent = '检查中…';
    await loadVanillaLibrary();
    closeModal();
  };
}

/**
 * 顶部「? Help」：打开内置的离线 HTML 教程窗口（src/renderer/help.html，
 * 主进程侧实现见 src/main/help.js）。教程在独立窗口里打开 —— 用户可以一边看
 * 一边操作主界面，不用先把弹窗关掉。
 *
 * 万一教程窗口打不开（极端情况），退回下面那份内置弹窗版说明：
 * 「Help 不得为空」这条底线任何时候都要成立（卡 t_7ee2bf5b）。
 */
async function showHelp() {
  if (window.mcs && typeof window.mcs.openHelp === 'function') {
    try {
      const r = await window.mcs.openHelp();
      if (r && r.ok) {
        status(r.reused
          ? '教程窗口已打开（切到「MCSoundStudio 使用教程」窗口查看）'
          : '已打开内置使用教程（离线 HTML，断网也能看）');
        return;
      }
    } catch (e) { /* 落到下面的兜底弹窗 */ }
  }
  openHelpModalFallback();
}

/** 兜底：主进程开不出教程窗口时用的内置弹窗版说明（HTML 渲染，支持表格） */
function openHelpModalFallback() {
  $('modalTitle').textContent = '用法与快捷键';
  $('modalBody').innerHTML = `
<div style="font-size:12.5px;line-height:1.75;color:var(--fg-2)">
<p style="margin:0 0 12px"><b style="color:var(--fg)">怎么开始</b><br>
① 点左上「原版库」加载约 1000+ 个原版音效事件（具体数量以这次实际加载为准 —— 状态栏会写「已加载原版音效库：N 个事件 / M 个变体」）<br>
② 展开「方块 / 友好生物 / 敌对生物」，找到需要的音效<br>
③ 把条目拖到中间时间轴的轨道上 → 按 <kbd>空格</kbd> 试听整段<br>
④ 把 GIF 或视频拖进上方预览区，就能对着画面配音</p>

<p style="margin:0 0 12px"><b style="color:var(--fg)">轨道怎么用</b><br>
默认只有一条「主轨」，点轨道区右上角的 <b>+ 轨道</b> 加新轨道。<br>
推荐分层：<b>机械层</b>（机器运转）、<b>音效层</b>（打击/开关）、
<b>环境层</b>（循环底噪）。<br>
轨道名双击可改，<b>M</b> 静音整轨、<b>S</b> 只留这一轨、<b>✕</b> 删轨道（连带删除轨上的音效）。<br>
选中轨道后新拖入的音效会落在该轨。</p>

<p style="margin:0 0 12px"><b style="color:var(--fg)">时间轴总长与边界条</b><br>
顶栏「总长(ms)」就是整段时序的长度：导出、播放停止点、时间显示都按它走。<br>
标尺右端的 <b>]</b> 是总长边界条，<b>直接左右拖</b>就能改总长；从 <b>[</b>（0ms）到 <b>]</b> 之间就是会被导出的区间。<br>
导入 GIF / 动画时会自动把总长设成素材时长；之后你亲手改过的总长不会再被导入覆盖。<br>
总长有<b>下限</b>：不能短于最后一段音效的结束时间 —— 再往前拖会被拦住并写明原因，
否则那一段就落在边界外、永远播不到。想更短就先把那段音效挪走或缩短。</p>

<p style="margin:0 0 12px"><b style="color:var(--fg)">选中片段能调什么</b><br>
右侧属性面板：起始位置、时长、音量、音高、所在轨道、变体、备注。<br>
<b>变体</b>：原版音效通常有多个随机版本（如石头挖掘有 4 个），
「自动随机」表示每次播放随机取一个，导出时保留事件 ID 交给游戏随机；
「锁定变体」则固定用某一个文件试听参考。<br>
<b>试听</b>：点属性面板的「▶ 试听这个音效」只响这一段，不会整段播放。</p>

<p style="margin:0 0 12px"><b style="color:var(--fg)">导出会得到什么</b><br>
点右上「导出全部」会一次性写出 5 个文件到同一个目录：<br>
· <b>策划案 .md</b>　—— 直接贴进策划文档的时间表<br>
· <b>sound_sequence.py</b>　—— 中国版 ModSDK 可直接调用的播放器<br>
· <b>sound_definitions.json</b>　—— 自定义音效注册（全用原版事件时此文件会是空的，并附说明）<br>
· <b>sound_effects.json</b>　—— 可贴进 Blockbench 动画<br>
· <b>timeline.json</b>　—— 工程源文件，下次「打开」可以继续改<br>
<b>保存</b>只存工程源文件；<b>导出</b>才是产出交付物。</p>

<p style="margin:0 0 6px"><b style="color:var(--fg)">时间轴快捷键</b></p>
<table style="border-collapse:collapse;font-size:12px;width:100%">
<tr><td style="padding:3px 10px 3px 0"><kbd>空格</kbd></td><td>播放 / 暂停（GIF 与视频会同步定格在当前帧）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>←</kbd> <kbd>→</kbd></td><td>移动播放头一格；<b>选中片段时移动片段</b></td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Alt</kbd>+<kbd>←</kbd></td><td>微调 10ms（精细对齐）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Shift</kbd>+<kbd>←</kbd></td><td>移动 1ms（最精细）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Home</kbd> / <kbd>End</kbd></td><td>跳到开头 / 结尾</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Del</kbd></td><td>删除选中的<b>全部</b>片段（多选时一起删）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Ctrl</kbd>+<kbd>C</kbd></td><td>复制选中的片段（可多个）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Ctrl</kbd>+<kbd>V</kbd></td><td>粘贴到<b>播放头</b>位置，片段之间的相对间距保持不变</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Ctrl</kbd>+<kbd>A</kbd></td><td>全选时间轴上的所有片段</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td><b>撤销</b>上一步改动（删除 / 移动 / 改长度 / 改参数 / 改总长…都各算一步；连续拖动只算一步）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Ctrl</kbd>+<kbd>Y</kbd></td><td><b>重做</b>刚撤销的那一步（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 也可以）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>保存工程源文件 timeline.json（第一次会让你选保存位置）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>D</kbd></td><td>复制选中片段，副本<b>紧跟在其后</b>（不经过剪贴板）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Enter</kbd></td><td>试听选中片段</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>M</kbd> / <kbd>S</kbd></td><td>静音 / 独奏该片段所在轨道</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Ctrl</kbd>+<kbd>↑</kbd><kbd>↓</kbd></td><td>把片段移到上/下一条轨道</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>+</kbd> / <kbd>-</kbd></td><td>缩放时间轴</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>F</kbd></td><td>缩放到整段刚好铺满窗口</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Alt</kbd>+滚轮</td><td>以鼠标位置为锚点缩放</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Esc</kbd></td><td>取消选中</td></tr>
</table>

<p style="margin:14px 0 6px"><b style="color:var(--fg)">鼠标操作</b></p>
<table style="border-collapse:collapse;font-size:12px;width:100%">
<tr><td style="padding:3px 10px 3px 0">拖标尺</td><td>移动播放头（GIF 跟着前后走）</td></tr>
<tr><td style="padding:3px 10px 3px 0">空白处拖动</td><td><b>框选</b>：拉出蓝色选择框，松手后框内片段全部选中（播放头不受影响）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Ctrl</kbd>+点击片段</td><td>把该片段<b>加入 / 移出</b>选中集（可连续点多个）</td></tr>
<tr><td style="padding:3px 10px 3px 0"><kbd>Shift</kbd>+点击片段</td><td>从当前主选中到该片段之间<b>整段加选</b></td></tr>
<tr><td style="padding:3px 10px 3px 0">拖选中的片段</td><td><b>整体移动</b>所有选中片段（相对间距保持不变，吸附以主选中为准）</td></tr>
<tr><td style="padding:3px 10px 3px 0">右键片段</td><td>选中该片段并弹出菜单：<b>属性</b>（跳到右侧属性面板）、复制、粘贴到播放头、再复制一份、<b>按播放头拆分</b>、<b>对齐到网格</b>、移到上/下一条轨道、<b>锁定·解锁</b>、全选、删除（删错了按 Ctrl+Z 撤销）。多选状态下右键 = 菜单作用于全部选中片段；点别处或 Esc 关闭</td></tr>
<tr><td style="padding:3px 10px 3px 0">右键轨道空白处</td><td>菜单：粘贴到播放头、撤销删除、全选、取消选中（不会清空当前选中）</td></tr>
<tr><td style="padding:3px 10px 3px 0">拖片段</td><td>移动位置（自动吸附网格）</td></tr>
<tr><td style="padding:3px 10px 3px 0">拖片段右缘</td><td>改时长</td></tr>
<tr><td style="padding:3px 10px 3px 0">点轨道</td><td>选中（高亮，新拖入的音效落这条）</td></tr>
<tr><td style="padding:3px 10px 3px 0">双击轨道名</td><td>重命名</td></tr>
<tr><td style="padding:3px 10px 3px 0">悬停 <span style="color:var(--accent-2)">×N</span></td><td>展开变体列表，可逐个试听</td></tr>
<tr><td style="padding:3px 10px 3px 0">拖预览区下缘</td><td>调整预览区高度（双击复位）</td></tr>
</table>

<p style="margin:14px 0 6px"><b style="color:var(--fg)">音效库</b></p>
<table style="border-collapse:collapse;font-size:12px;width:100%">
<tr><td style="padding:3px 10px 3px 0"><kbd>☆</kbd></td><td>收藏，收藏项会置顶在「★ 收藏」分组</td></tr>
<tr><td style="padding:3px 10px 3px 0">▶</td><td>试听（同一时刻只播一个）</td></tr>
<tr><td style="padding:3px 10px 3px 0">搜索框</td><td>中文名和事件名都能搜，如「铁傀儡」「dig.stone」</td></tr>
</table>

<p style="margin:14px 0 6px"><b style="color:var(--fg)">常见问题</b></p>
<div style="margin:0 0 10px;padding:9px 12px;border-left:3px solid var(--warn);background:rgba(210,153,34,.12);border-radius:3px">
  <b style="color:var(--warn)">大 GIF 拖动发钝？先把 GIF 转成 MP4 再导入。</b><br>
  大 GIF 要逐帧解码：实测 1172×941 / 100 帧的 GIF 快速拖动时，单次拖动确认平均 20~30ms、
  偶发 150ms 以上；6 帧的小 GIF 只要 4ms —— 手感就是会比小 GIF 钝（这不是卡死，是逐帧解码的代价）。<br>
  转成 MP4 后画面走视频解码，拖动更跟手、也更省内存。顶部「导入 GIF / 视频」直接吃 MP4：
  <code style="background:var(--bg-3);padding:0 4px;border-radius:2px">ffmpeg -i in.gif -pix_fmt yuv420p out.mp4</code>
</div>
<table style="border-collapse:collapse;font-size:12px;width:100%">
<tr><td style="padding:3px 10px 3px 0;white-space:nowrap"><b>拖进去没声音</b></td>
<td>先看片段上有没有波形：有波形说明文件在。再查轨道是否被 <b>M</b> 静音、
或别的轨按了 <b>S</b> 独奏（其它轨会被压暗）。</td></tr>
<tr><td style="padding:3px 10px 3px 0;white-space:nowrap"><b>按空格没反应</b></td>
<td>光标在文本框 / 搜索框里时，空格是打字，快捷键会让位；
数字框（总长、BPM）里空格照样能播放/暂停。点一下时间轴空白处最保险。</td></tr>
<tr><td style="padding:3px 10px 3px 0;white-space:nowrap"><b>GIF 不动</b></td>
<td>GIF 由播放头驱动，不自己播（暂停时定格是正常的）。按空格或拖标尺它就会跟着走；
时间轴还是空的也能按播放，只放画面。播放头越过 GIF 末尾会停在最后一帧，
预览区会写「已放完」。</td></tr>
<tr><td style="padding:3px 10px 3px 0;white-space:nowrap"><b>原版事件没声音</b></td>
<td>试听文件来自公开 OGG 镜像，个别较新的事件可能还没有对应文件。
属性面板会写明「找不到对应音频文件」，此时仍可正常导出事件 ID。</td></tr>
<tr><td style="padding:3px 10px 3px 0;white-space:nowrap"><b>大 GIF 拖动发钝 / 卡</b></td>
<td>逐帧解码的代价（没丢事件、没错帧，就是手感钝），不是卡死。
办法见上面那条黄框：<b>先把 GIF 转成 MP4 再导入</b>，拖动会跟手得多。</td></tr>
<tr><td style="padding:3px 10px 3px 0;white-space:nowrap"><b>删不掉轨道</b></td>
<td>只剩一条轨道时删除按钮是灰的，至少要保留一条。</td></tr>
</table>

<p style="margin:14px 0 0;color:var(--fg-3);font-size:11.5px">
分类与中文名依据中文 Minecraft Wiki 核对：方块名取自「方块」条目的方块列表，
生物阵营取自「生物」条目的友好生物/敌对生物章节。
</p>
</div>`;
  $('modal').style.display = 'flex';
}

/**
 * 「作者」入口（顶栏按钮 / 教程页里的按钮都走这个地址）。
 * 用系统默认浏览器打开，不在程序里内嵌网页 —— 主进程 shell.openExternal 的
 * 真实返回结果会显示在状态栏，方便用户（和我自己复验时）确认到底打开没打开。
 */
const AUTHOR_URL = 'https://space.bilibili.com/50955238';

async function openAuthorLink() {
  if (!window.mcs || typeof window.mcs.openExternal !== 'function') {
    status('当前环境无法打开外部浏览器', AUTHOR_URL);
    return;
  }
  const r = await window.mcs.openExternal(AUTHOR_URL);
  if (r && r.ok) {
    status('已在系统浏览器中打开作者主页', r.url || AUTHOR_URL);
  } else {
    status('打开作者主页失败：' + ((r && r.error) || '未知原因'), '可手动访问 ' + AUTHOR_URL);
  }
  return r;
}

// ---------------------------------------------------------------------------
// 导出系统信息（卡 t_20c2e144）
//
// 起始页「系统信息」那一栏的按钮走这里：把「只有渲染进程知道」的两块实测值
// （库规模、首次加载库耗时）打包给主进程，主进程再补上系统 / CPU / 内存 / 显卡 /
// 屏幕这些它才读得到的事实（实现见 src/main/sysinfo.js），最后写成一个 txt
// 到用户选的位置（真实的「另存为」对话框）。
//
// 为什么拆两半：库规模和加载耗时在渲染进程里，os / app.getGPUFeatureStatus /
// screen 只在主进程里有 —— 任何一边单独都凑不齐这份坐标。
// ---------------------------------------------------------------------------
function sysInfoPayload() {
  const meta = STATE.libraryMeta;
  return {
    library: {
      loaded: !!meta,
      events: meta ? meta.events : null,
      variants: meta ? meta.variants : null,
      withDesc: meta ? meta.withDesc : null,
      // 库里的音频文件到底在哪：主进程按它去数磁盘上真实的 .ogg 个数
      audioDir: STATE.audioDir || '',
    },
    firstLoadMs: (typeof STATE.libraryLoadMs === 'number') ? STATE.libraryLoadMs : null,
  };
}

async function exportSystemInfo() {
  if (!window.mcs || typeof window.mcs.exportSystemInfo !== 'function') {
    status('当前环境不支持导出系统信息', '请从程序窗口里使用（不是浏览器）');
    return { ok: false, error: 'no-api' };
  }
  const btn = $('ovBtnSysInfo');
  const oldLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
  let r = null;
  try {
    r = await window.mcs.exportSystemInfo(sysInfoPayload());
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldLabel || '导出系统信息…'; }
  }
  if (r && r.ok) {
    status('系统信息已导出：' + r.path, '把这份 txt 发回给作者，兼容性问题不用猜');
  } else if (r && r.canceled) {
    status('已取消导出系统信息');
  } else {
    status('导出系统信息失败：' + ((r && r.error) || '未知原因'));
  }
  return r;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
function exportOpts() {
  return {
    namespace: $('eNamespace').value || 'mymod',
    funcName: $('eFuncName').value || 'playMachineSequence',
    customFolder: $('eCustomFolder').value || 'custom',
  };
}

function buildAllExports() {
  const doc = STATE.doc;
  // 工程名的唯一真值是 STATE.doc；两个编辑入口会实时同步到它，导出不应反向
  // 从某个隐藏页的输入框覆盖用户刚在常用工具栏写下的名称。
  doc.name = doc.name || '未命名时序';
  const o = exportOpts();
  const base = (doc.name || 'sequence').replace(/[\\/:*?"<>|]/g, '_');

  return {
    markdown: {
      name: `${base}.策划案.md`,
      content: exportMarkdown(doc),
    },
    python: {
      name: `${base}.sound_sequence.py`,
      content: exportModSDKPython(doc, o),
    },
    sounddef: {
      name: 'sound_definitions.json',
      content: exportSoundDefinitions(doc, o),
    },
    soundfx: {
      name: `${base}.sound_effects.json`,
      content: exportAnimationSoundEffects(doc, o),
    },
    timeline: {
      name: `${base}.timeline.json`,
      content: exportTimelineJson(doc),
    },
  };
}

async function doExport(kind) {
  const all = buildAllExports();
  if (kind === 'preview') {
    const txt = [
      '════════════ 策划案 Markdown ════════════',
      all.markdown.content,
      '',
      '════════════ ModSDK Python ════════════',
      all.python.content,
      '',
      '════════════ sound_definitions.json ════════════',
      all.sounddef.content,
      '',
      '════════════ 动画 sound_effects 片段 ════════════',
      all.soundfx.content,
    ].join('\n');
    openModal('导出预览', txt, 'preview.txt');
    return;
  }
  const f = all[kind];
  const r = await window.mcs.saveFile({ defaultName: f.name, content: f.content });
  if (r.ok) {
    // 保存工程源文件 = 磁盘上的工程已是最新，脏标记要清掉；
    // 同时记住路径，下次 Ctrl+S 可直接写回。
    if (kind === 'timeline') {
      SAVE_PATH = r.path;
      markClean();
      recordRecentProject(SAVE_PATH, STATE.doc.name);
    }
    status(kind === 'timeline' ? '已保存工程：' + r.path : '已导出：' + r.path);
  } else if (!r.canceled) status('导出失败：' + r.error);
}

async function doExportAll() {
  const all = buildAllExports();
  const files = [
    all.markdown,
    all.python,
    all.sounddef,
    all.soundfx,
    all.timeline,
  ];
  const r = await window.mcs.saveMany({ files });
  if (r.ok) {
    markClean();
    openModal('导出完成', `已写入 ${r.written.length} 个文件到：\n\n${r.dir}\n\n` + r.written.map((p) => '  · ' + p).join('\n'));
    status(`已导出 ${r.written.length} 个文件`, r.dir);
  } else if (!r.canceled) {
    status('导出失败：' + r.error);
  }
}

// ---------------------------------------------------------------------------
// 视觉参考（GIF / 视频）↔ 时间轴 同步
//
// 用户需求：
//   - 播放：GIF 跟着播放头走
//   - 暂停：GIF 立刻定格在当前帧，之后不再变化
//   - 拖动：GIF 进度跟着前后移动（往回拉也倒退）
//
// 设计铁律：GIF 自己不跑时钟，位置只能来自"当前时刻"。
//   谁在喂它、该不该喂，全由 setupGifSync 里的三条判断决定；
//   暂停 = 把 transport 置成 stopped，驱动器下一帧自行退出。
// ---------------------------------------------------------------------------

/**
 * 当前"视觉时钟"取的毫秒数。
 *
 * 有音效在响 → 用音频时钟（最准，和听到的完全对齐）。
 * 没有音效（只导入了一段 GIF 想先看看画面）→ 用 STATE.playheadMs，
 *   由 startVisualOnlyClock 那个轻量时钟推进。
 */
function visualClockMs() {
  return AudioEngine.isPlaying() ? AudioEngine.currentMs() : STATE.playheadMs;
}

/**
 * GIF ↔ 时间轴 同步驱动器。
 *
 * 它只做一件事：把「当前时刻」喂给 GIF。所有"该不该动"的判断都在这里，
 * 而且必须同时满足：
 *   1) STATE.transport === 'playing'  —— 传输控制说了在播放（唯一真相）
 *   2) 用户没在拖播放头（STATE.scrubbing）
 *   3) 有音效时，音频确实在跑（音频卡死时别让画面空转）
 * 任何一条不满足 → 立刻退出，没人再喂 GIF，画面必然定格。
 */
function setupGifSync() {
  if (STATE.gifSyncTimer) { cancelAnimationFrame(STATE.gifSyncTimer); STATE.gifSyncTimer = null; }

  const drive = () => {
    STATE.gifSyncTimer = null;
    if (!STATE.gifPlayer) return;
    if (STATE.transport !== 'playing' || STATE.scrubbing) return;
    const audioRunning = AudioEngine.isPlaying();
    if (STATE.doc.clips.length && !audioRunning) return;   // 有音效但没在响：别自己走
    const t = visualClockMs();
    if (audioRunning) {
      STATE.playheadMs = t;
      updatePlayhead(t);
    }
    STATE.gifPlayer.seek(t);
    STATE.gifSyncTimer = requestAnimationFrame(drive);
  };
  STATE.gifSyncTimer = requestAnimationFrame(drive);
}

/**
 * 视频 ↔ 时间轴 同步
 * <video> 的 currentTime 可以精确设置，所以只要把播放头时间喂进去即可。
 * 视频本身不自己播（不用 play()），完全由播放头驱动，这样暂停必然定格。
 */
function setupVideoSync() {
  if (STATE.videoSyncTimer) { cancelAnimationFrame(STATE.videoSyncTimer); STATE.videoSyncTimer = null; }
  const v = STATE.videoEl;
  if (!v) return;

  const drive = () => {
    STATE.videoSyncTimer = null;
    if (!STATE.videoEl) return;
    if (STATE.transport !== 'playing' || STATE.scrubbing) return;
    const audioRunning = AudioEngine.isPlaying();
    if (STATE.doc.clips.length && !audioRunning) return;
    const t = visualClockMs();
    if (audioRunning) {
      STATE.playheadMs = t;
      updatePlayhead(t);
    }
    setVideoTime(t / 1000);
    STATE.videoSyncTimer = requestAnimationFrame(drive);
  };
  STATE.videoSyncTimer = requestAnimationFrame(drive);
}

/** 设置视频时间点（做范围保护，避免 seek 异常） */
function setVideoTime(sec) {
  const v = STATE.videoEl;
  if (!v || !isFinite(v.duration) || v.duration <= 0) return;
  const target = Math.max(0, Math.min(sec, Math.max(0, v.duration - 0.02)));
  // 差距太小就不设，避免频繁 seek 导致画面抖动
  if (Math.abs(v.currentTime - target) > 0.02) {
    try { v.currentTime = target; } catch (e) { /* 忽略 seek 竞争 */ }
  }
}

/** 统一入口：把当前视觉参考（GIF 或视频）定位到指定时间 */
function syncVisualTo(ms) {
  if (STATE.gifPlayer) STATE.gifPlayer.seek(ms);
  if (STATE.videoEl) setVideoTime(ms / 1000);
  // 模型预览也吃同一个「当前时刻」：拖播放头 / 暂停都会重画到对应姿态（卡 t_fa17801d）
  if (STATE.visualMode === 'model') MCS_MODELPREVIEW.render(ms);
  updateVisualMeta(ms);
}

/** 暂停 / 拖动后清掉三个同步驱动器（幂等） */
function stopVisualDrivers() {
  if (STATE.gifSyncTimer) { cancelAnimationFrame(STATE.gifSyncTimer); STATE.gifSyncTimer = null; }
  if (STATE.videoSyncTimer) { cancelAnimationFrame(STATE.videoSyncTimer); STATE.videoSyncTimer = null; }
  MCS_MODELPREVIEW.stopDriver();
  stopVisualOnlyClock();
}

// ---------------------------------------------------------------------------
// 只有画面、没有音效时的时钟
//   （用户常常先把 GIF 拖进来看看画面，再配声音；
//    以前这种情况按播放完全没反应，会以为 GIF 坏了）
// ---------------------------------------------------------------------------
let visualOnlyRaf = null;
let visualOnlyFrom = 0;
let visualOnlyWall = 0;

function stopVisualOnlyClock() {
  if (visualOnlyRaf) { cancelAnimationFrame(visualOnlyRaf); visualOnlyRaf = null; }
}

function startVisualOnlyClock(fromMs) {
  stopVisualOnlyClock();
  visualOnlyFrom = Math.max(0, fromMs || 0);
  visualOnlyWall = performance.now();
  const tick = () => {
    visualOnlyRaf = null;
    if (STATE.transport !== 'playing') return;
    if (STATE.doc.clips.length) return;          // 已经有音效了：交给音频时钟
    if (STATE.scrubbing) {                       // 用户在拖：让路
      visualOnlyRaf = requestAnimationFrame(tick);
      return;
    }
    const ms = visualOnlyFrom + (performance.now() - visualOnlyWall);
    if (ms >= totalMs()) { endTransport(); return; }
    STATE.playheadMs = ms;
    updatePlayhead(ms);
    visualOnlyRaf = requestAnimationFrame(tick);
  };
  visualOnlyRaf = requestAnimationFrame(tick);
}

/** 播放用的片段列表（已算好 muted：轨道静音 / 独奏） */
function clipsForPlayback() {
  const anySolo = STATE.doc.tracks.some((x) => x.solo);
  return STATE.doc.clips.map((c) => {
    const t = STATE.doc.tracks.find((x) => x.name === c.track);
    return Object.assign({}, c, { muted: t && (t.muted || (anySolo && !t.solo)) });
  });
}

/**
 * 开始播放。
 * @param fromMs 从哪一刻开始（暂停后继续播用 STATE.playheadMs）
 */
function startTransport(fromMs) {
  const clips = clipsForPlayback();
  // 模型预览和 GIF 一样算「有画面可以看」：只导入模型（还没配音效）时按播放，
  // 播放头照样推进、模型按动画动起来（K 卡 t_fa17801d）
  const hasVisual = !!(STATE.gifPlayer || STATE.videoEl
    || (STATE.visualMode === 'model' && MCS_MODELPREVIEW.scene));
  // 开始播放 = 状态变了：右侧挂着的「再点 ▶ 从头播放」这类一次性提示立即失效
  clearStatusHint();
  if (!clips.length && !hasVisual) {
    status('时间轴上还没有音效', '从左侧音效库拖一个进来试试');
    return false;
  }

  const from = Math.max(0, Math.min(fromMs || 0, Math.max(0, totalMs() - 1)));
  STATE.transport = 'playing';
  STATE.playheadMs = from;
  syncVisualTo(from);            // 先定位到起点（含倒退）
  updatePlayhead(from);

  if (clips.length) {
    AudioEngine.playSequence(clips, from, {
      totalMs: totalMs(),
      onTick: (ms) => { STATE.playheadMs = ms; updatePlayhead(ms); },
      onEnd: endTransport,
    });
  } else {
    // 没有音效也能看画面：用轻量时钟推进播放头
    startVisualOnlyClock(from);
  }

  $('btnPlay').textContent = '⏸';
  $('btnPlay').classList.add('playing');
  if (STATE.gifPlayer) setupGifSync();
  // 模型预览在播放时也要跟着走（只在「模型模式 + 正在播放」时真的动，见 model-preview.js）
  MCS_MODELPREVIEW.startDriver();
  if (STATE.videoEl) setupVideoSync();
  return true;
}

/**
 * 暂停：立刻定格在当前帧，之后画面不再变化。
 * 顺序很关键 —— 先把 transport 置成 stopped，
 * 同步驱动器的下一次回调就会自行退出，不会再有东西喂 GIF。
 */
function pauseTransport() {
  const enginePos = AudioEngine.isPlaying() ? AudioEngine.stopPosition() : null;
  STATE.transport = 'stopped';
  STATE.scrubbing = false;          // 传输控制接手：别让残留的拖动标志卡住同步
  clearStatusHint();                // 暂停是状态变化：上一次的「再点 ▶ 从头播放」不再成立
  AudioEngine.stopSequence();
  stopVisualDrivers();
  if (enginePos != null) STATE.playheadMs = Math.max(0, enginePos);
  syncVisualTo(STATE.playheadMs);      // 停在当前帧（往回拖过也不跳回去）
  updatePlayhead(STATE.playheadMs);
  $('btnPlay').textContent = '▶';
  $('btnPlay').classList.remove('playing');
}

/** 拖动播放头后重新对齐音频（播放中拖标尺用） */
function resumePlaybackAt(ms) {
  const from = Math.max(0, Math.min(ms || 0, Math.max(0, totalMs() - 1)));
  // 从"拖动定位中"回到播放：状态、按钮、状态栏三处一起改，
  // 不能只把声音放起来而让状态栏继续显示别的（那正是 P0 里的不一致）。
  STATE.transport = 'playing';
  STATE.playheadMs = from;
  syncVisualTo(from);
  updatePlayhead(from);
  if (!STATE.doc.clips.length) {
    startVisualOnlyClock(from);
  } else {
    AudioEngine.playSequence(clipsForPlayback(), from, {
      totalMs: totalMs(),
      onTick: (m) => { STATE.playheadMs = m; updatePlayhead(m); },
      onEnd: endTransport,
    });
  }
  // 拖标尺时驱动器退出了，这里必须重新启动，否则画面会停在拖完的那一帧
  if (STATE.gifPlayer) setupGifSync();
  // 模型预览在播放时也要跟着走（只在「模型模式 + 正在播放」时真的动，见 model-preview.js）
  MCS_MODELPREVIEW.startDriver();
  if (STATE.videoEl) setupVideoSync();
  $('btnPlay').textContent = '⏸';
  $('btnPlay').classList.add('playing');
  status(playStatusText());
}

/**
 * 播放到总长自动结束：停在最后一个时间点 + 最后一帧，**不回零**（产品行为）。
 *   - 播完不许自动归零，也不许只回零一半（播放头在 0、GIF 停在尾那种自相矛盾）；
 *   - 想回开头：按「停止」、Home，或者拖播放头（见 leaveEndedState）；
 *   - 此时再点播放 → 从 0ms / 首帧重新播（见 setupTransport 里的 atEnd 判断）。
 */
function endTransport() {
  STATE.transport = 'ended';
  AudioEngine.stopSequence();
  stopVisualDrivers();
  const end = totalMs();
  STATE.playheadMs = end;
  updatePlayhead(end);         // 放在 transport='ended' 之后：末尾不算"离开末尾"
  syncVisualTo(end);           // GIF / 视频停在最后一帧（超出末尾时 GIF 自己夹住）
  $('btnPlay').textContent = '▶';
  $('btnPlay').classList.remove('playing');
  statusHint(ENDED_STATUS_MSG, '再点 ▶ 从头播放');
}

/** 停止：回起点、清干净所有时钟 */
function stopTransport() {
  STATE.transport = 'stopped';
  STATE.scrubbing = false;
  clearStatusHint();               // 停止是状态变化：一次性提示跟着走
  AudioEngine.stopSequence();
  stopVisualDrivers();
  STATE.playheadMs = 0;
  syncVisualTo(0);
  updatePlayhead(0);
  $('btnPlay').textContent = '▶';
  $('btnPlay').classList.remove('playing');
}

/** 预览区元信息：GIF 放完之后要明确写出来，否则用户会以为画面卡死了 */
function updateVisualMeta(ms) {
  const el = $('metaVisual');
  if (!el) return;
  // 模型预览有自己的元信息文案（立方体/骨骼/动画进度）—— 交给 model-preview 生成
  if (STATE.visualMode === 'model' && MCS_MODELPREVIEW.scene) {
    setTailHints(false);
    const text = MCS_MODELPREVIEW.metaText(ms);
    if (el.textContent !== text) el.textContent = text;
    return;
  }
  // 没有任何视觉素材时必须写回「视觉：无」。
  // 以前这里只是 return，于是删掉 GIF / 视频 / 图片后，元信息行还留着
  // 「视觉：GIF (…) · 已放完，停在最后一帧」—— 界面说还有画面，其实已经删了。
  // 有视频 / 图片时它们的文案由各自导入函数写（不参与进度同步），这里不动。
  if (!STATE.gifAnim) {
    setTailHints(false);
    if (!STATE.videoEl && STATE.visualMode !== 'video' && STATE.visualMode !== 'image'
        && el.textContent !== '视觉：无') {
      el.textContent = '视觉：无';
    }
    return;
  }
  const at = ms == null ? STATE.playheadMs : ms;
  const done = STATE.gifAnim.totalMs > 0 && at >= STATE.gifAnim.totalMs - 1;
  const text = `视觉：GIF (${(STATE.gifAnim.totalMs / 1000).toFixed(2)}s, ${STATE.gifAnim.frameCount}帧)`
    + (done ? ' · 已放完，停在最后一帧' : '');
  // 和 DOM 现值比较（而不是自己缓存），导入视频/图片覆盖过文案时也不会错位
  if (el.textContent !== text) el.textContent = text;
  setTailHints(done);
}

/**
 * 内容实际需要多宽（不含 renderTimeline 里那个「至少 600px」的兜底）。
 * 抽出来是为了让灰尾几何只有一个定义：renderTimeline 用它铺轨道，
 * tailShadeGeom 也用它判断「GIF 末尾之后还有没有地方」。
 */
function contentWidthPx() {
  const pxPerMs = STATE.zoom;
  const furthest = STATE.doc.clips.reduce(
    (m, c) => Math.max(m, (c.startMs || 0) + (c.durationMs || 0)),
    0
  );
  return Math.max(totalMs() * pxPerMs, furthest * pxPerMs);
}

/**
 * 灰尾（时间轴上 GIF 末尾之后那段）的几何。
 * 徽标文案和 #tailShade 都读这里，保证「徽标说去看灰色区」时那块灰色区真的画着。
 * 传 contentW 可省一次重算（renderTimeline 自己已经算过）。
 */
function tailShadeGeom(contentW) {
  const cw = contentW == null ? contentWidthPx() : contentW;
  const gifEndPx = STATE.gifAnim && STATE.gifAnim.totalMs > 0
    ? STATE.gifAnim.totalMs * STATE.zoom : 0;
  const visible = gifEndPx > 0 && gifEndPx < cw - 1;
  return { visible, left: gifEndPx, width: visible ? cw - gifEndPx : 0 };
}

// 越尾徽标的文案：主句永远成立，副标题只在时间轴上真的画了灰尾时才加 —— 见 setTailHints。
const TAIL_BADGE_TEXT = '⏹ 画面已定格在 GIF 末帧';
const TAIL_BADGE_TAIL_NOTE = '（时间轴灰色区没有画面）';

/**
 * 越过 GIF 末尾时的提示层（P2-1）。
 * 现象：时间轴比 GIF 长时，播放头过了 GIF 末尾画面就不再变化，
 * 而唯一的说明是元信息行里那行小字 —— 用户没看到就会以为画面卡死。
 * 所以补一个带底色的一眼可见徽标；只在「真的越过末尾」时出现，
 * 时间轴上的灰尾由 renderTimeline 负责（两者同源，都读 gifAnim.totalMs）。
 * 副标题只在灰尾真的可见时才加：总长==GIF 时长（导入后的默认值）时
 * 时间轴上根本没有那片灰色区域，说了就是把用户支到一个不存在的地方去找解释。
 * 只改显示，不碰 GIF 解码 / 同步 / 播放行为。
 * @param {boolean} on 是否显示徽标（播放头越过 GIF 末尾）
 * @param {boolean} [shadeVisible] 灰尾此刻是否可见；省略时按 gifAnim/总长/缩放在这里算
 */
function setTailHints(on, shadeVisible) {
  const b = $('metaTailBadge');
  if (!b) return;
  const want = on ? '' : 'none';
  if (b.style.display !== want) b.style.display = want;
  const shade = shadeVisible == null ? tailShadeGeom().visible : shadeVisible;
  const text = TAIL_BADGE_TEXT + (shade ? TAIL_BADGE_TAIL_NOTE : '');
  if (b.textContent !== text) b.textContent = text;
}

/** 预览区高度可拖拽调整（存 localStorage，下次打开保持） */
function setupPreviewResizer() {
  const bar = $('previewResizer');
  const area = $('previewArea');
  if (!bar || !area) return;

  const saved = parseInt(localStorage.getItem('mcs.previewH') || '', 10);
  if (saved >= 120) area.style.height = saved + 'px';

  let dragging = false;
  let startY = 0;
  let startH = 0;

  bar.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = area.getBoundingClientRect().height;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  const onMove = (e) => {
    if (!dragging) return;
    const h = Math.max(120, Math.min(startH + (e.clientY - startY), window.innerHeight - 260));
    area.style.height = h + 'px';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    localStorage.setItem('mcs.previewH', String(Math.round(area.getBoundingClientRect().height)));
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  bar.addEventListener('dblclick', () => {
    area.style.height = '260px';
    localStorage.setItem('mcs.previewH', '260');
  });
}

// ---------------------------------------------------------------------------
// 传输控制
// ---------------------------------------------------------------------------
/**
 * 「播放中」的状态栏文案。
 * 按钮播放和拖标尺续播共用同一份说法，避免两处文案不一致
 * （用户对状态栏的信任就来自"它写的和实际听到的/看到的一样"）。
 */
function playStatusText() {
  if (!STATE.doc.clips.length) return '播放中…（没有音效，只预览画面）';
  return '播放中…' + (STATE.gifPlayer ? '（GIF 已同步）' : '');
}

function setupTransport() {
  $('btnPlay').addEventListener('click', () => {
    // 用 STATE.transport（而不是 AudioEngine.isPlaying()）判断该播还是该停。
    // 引擎状态会在"音频自然播完 / 音频文件缺失 / 播到总长"时和按钮显示不一致，
    // 那样用户点暂停会被当成"重新播放"，画面看着就是"暂停了 GIF 还在动"。
    if (STATE.transport === 'playing') {
      pauseTransport();
      // 右侧「停在 X.XXs」只在暂停期间成立：一旦续播就该消失（见 status/statusHint）
      statusHint('已暂停', `停在 ${(STATE.playheadMs / 1000).toFixed(2)}s`);
      return;
    }
    // 播到末尾后（或播放头本来就停在末尾）再点播放 → 从 0ms / 首帧重新开始。
    // 否则 startTransport 会把起点夹到 totalMs-1，一按就"播完"，看着像播放键坏了。
    const atEnd = STATE.transport === 'ended' || STATE.playheadMs >= totalMs() - 1;
    if (!startTransport(atEnd ? 0 : (STATE.playheadMs || 0))) return;
    status(playStatusText());
  });

  $('btnStop').addEventListener('click', () => {
    stopTransport();
    status('已停止');
  });

  $('rngMaster').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    AudioEngine.setMasterVolume(v);
    $('masterVal').textContent = Math.round(v * 100) + '%';
  });

  $('rngZoom').addEventListener('input', (e) => {
    STATE.zoom = Number(e.target.value);
    $('zoomVal').textContent = STATE.zoom.toFixed(2) + ' px/ms';
    renderTimeline();
    updateZoomFitHint();
  });

  // ---- Alt + 滚轮：缩放时间轴 ----（放在轨道区上）
  const zoomArea = $('scrollArea');
  zoomArea.addEventListener('wheel', (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.min(4, Math.max(0.02, STATE.zoom * factor));
    // 以鼠标位置为锚点缩放，视觉上更自然
    const rect = zoomArea.getBoundingClientRect();
    const pxInContent = e.clientX - rect.left + zoomArea.scrollLeft;
    const msAtCursor = pxInContent / STATE.zoom;
    STATE.zoom = next;
    renderTimeline();
    zoomArea.scrollLeft = msAtCursor * STATE.zoom - (e.clientX - rect.left);
    $('rngZoom').value = String(next);
    $('zoomVal').textContent = next.toFixed(2) + ' px/ms';
  }, { passive: false });

  // ---- 键盘快捷键 ----
  window.addEventListener('keydown', (e) => {
    const inField = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'
      || e.target.isContentEditable;
    // 真正要打字的地方（文本框 / 搜索框 / 备注）不能抢空格；
    // 数字框（总长、BPM、属性数值）里按空格本来什么都不会发生，
    // 所以照样当作播放/暂停 —— 否则用户改完总长按空格会"没反应"。
    const isTextEntry = e.target.tagName === 'TEXTAREA' || e.target.isContentEditable
      || (e.target.tagName === 'INPUT'
          && ['text', 'search', 'password', 'email', 'url', 'tel'].includes(e.target.type));
    // 数字框写的是文档数值，不该让浏览器把 Ctrl+Z 当作「只撤输入文字」：
    // 否则浏览器改了框里的字、文档却不动，下一次失焦还会把旧字当新改动提交。
    // 文本框则必须保留浏览器自己的文本撤销（搜索 / 标签 / 备注都依赖它）。
    const isDocNumberField = e.target.tagName === 'INPUT' && e.target.type === 'number';

    // 教程入口从工作页工具栏搬到起始页（卡 t_49c08ec4）；编辑到一半查快捷键的习惯不能丢，
    // 所以在工作页留一个不占位的入口：F1 打开同一份离线教程。
    if (e.key === 'F1') {
      e.preventDefault();
      showHelp();
      return;
    }

    // 起始页铺在最上面时，工作页的快捷键一律不吃（卡 t_49c08ec4）：用户看着工程列表
    // 按空格 / Delete / Ctrl+S，绝不该悄悄播放、删片段或写盘 —— 那些动作发生在被盖住的
    // 编辑器里，界面上一点反馈都看不见。Esc 例外，它是通用的「先关弹窗」退出键。
    if (e.key !== 'Escape' && window.MCS_OVERVIEW && MCS_OVERVIEW.isOpen && MCS_OVERVIEW.isOpen()) return;

    // 空格播放/暂停（文本框里不拦）
    //
    // 例外（卡 t_4e96920b）：焦点在搜索框的「清空 ✕」上时不抢空格 —— 它是个原生
    // <button>，浏览器本来就会用空格激活它。以前一律抢走，于是 ✕ 用 Tab 聚焦后按
    // 空格触发的是播放/暂停，清空没发生（用户的感觉正是「按了没反应」）。
    // 不推广到所有按钮：运输按钮（播放/停止）上按空格继续按
    // 「空格 = 播放/暂停」走，这条是帮助里写明的约定，别改坏。
    // （例外清单从「只有清空 ✕」扩到「清空 ✕ + 调整页里的按钮」，见下面一段。）
    const onClearSearchBtn = e.target.id === 'btnClearSearch';
    // 卡 t_c54d031b：调整页（步骤条 + 素材槽 / 角度面板）里的按钮同样放行 ——
    // 「空格 = 播放/暂停」是给运输按钮定的约定；键盘用户 Tab 到「重置角度」按空格
    // 却开始播放，就成了「按了没反应」。只认这两个容器里的 <button>，
    // 数字框 / 时间轴 / 运输按钮的行为一律不变（数字框里按空格仍是播放/暂停）。
    const onAdjustChromeBtn = e.target.tagName === 'BUTTON' && !!(e.target.closest
      && (e.target.closest('#stepBar') || e.target.closest('#adjustPanel')));
    if (e.code === 'Space' && !isTextEntry && !onClearSearchBtn && !onAdjustChromeBtn) {
      e.preventDefault();
      $('btnPlay').click();
      return;
    }

    // Esc：先关弹窗；没有弹窗时取消选中
    if (e.code === 'Escape') {
      const modalEl = $('modal');
      if (modalEl && getComputedStyle(modalEl).display !== 'none') {
        closeModal();
        return;
      }
      clearSelection();
      STATE.selectedTrack = null;
      renderTimeline(); renderProps();
      status('已取消选中');
      return;
    }

    // ---- 保存类快捷键：不分焦点，永远生效 ----
    //   P1（mcs-qa 卡 t_93fd27a1 复现）：焦点停在搜索框 / BPM / 总长这些输入框里
    //   按 Ctrl+S「完全无反应」—— 不弹「另存为」、不落盘、状态栏一字不变、
    //   标题的「•」还在；而搜索框里恰好挂着上一条「已保存工程：…」，看着像已保存。
    //   根因就是下面那句 `if (inField) return;` 把**所有**快捷键整段跳过。
    //   所以保存键必须在它**之前**拦下；其余快捷键（S=独奏 / M=静音 / 空格 /
    //   Delete / 方向键）仍走原判断，免得在输入框里打字时被误触。
    //   具体保存动作（提交「改到一半」的编辑 + 把焦点还回来）见 performSaveShortcut()。
    if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key || '').toLowerCase() === 's') {
      e.preventDefault();
      performSaveShortcut(!!e.shiftKey);   // Ctrl+Shift+S = 另存为（强制弹位置选择）
      return;
    }

    // 数字文档参数框里的撤销 / 重做走文档级历史，而不是浏览器输入文本历史。
    // 即使没有历史也要回刷输入框：用户在未提交的数字上按 Ctrl+Z 时，框里不能继续
    // 留着与文档不一致的临时文字。
    if ((e.ctrlKey || e.metaKey) && !e.altKey && isDocNumberField) {
      const k = String(e.key || '').toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        syncDocInputsFromDoc();
        return;
      }
      if (k === 'y' && !e.shiftKey) {
        e.preventDefault();
        redo();
        syncDocInputsFromDoc();
        return;
      }
    }

    // 与失焦的 change 走同一条提交处理器：数字输完按回车即确认，状态栏和标题反馈
    // 完全一致；preventDefault 避免外层快捷键把 Enter 当作试听。
    if (isDocNumberField && (e.code === 'Enter' || e.key === 'Enter')) {
      e.preventDefault();
      e.target.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (inField) return;

    // Ctrl+C / Ctrl+V / Ctrl+A：复制选中片段 / 粘贴到播放头 / 全选
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = String(e.key || '').toLowerCase();
      if (k === 'c' && !e.shiftKey) { e.preventDefault(); copySelection(); return; }
      if (k === 'v' && !e.shiftKey) { e.preventDefault(); pasteAtPlayhead(); return; }
      if (k === 'a' && !e.shiftKey) { e.preventDefault(); selectAllClips(); return; }
      // Ctrl+Z = 撤销 / Ctrl+Shift+Z = 重做（两条并存的通用撤销栈，
      // 覆盖删除、移动、改参数、改总长、加片段、轨道改动…… 见 commitUndo）
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
      // Ctrl+Y = 重做（Windows 上的常规写法，和 Ctrl+Shift+Z 等价）
      if (k === 'y' && !e.shiftKey) { e.preventDefault(); redo(); return; }
      // Ctrl+S / Ctrl+Shift+S（保存 / 另存为）已在上面那句 `if (inField) return;`
      // 之前统一拦截，这里不再重复处理 —— 关键就是它不能受焦点影响。
    }

    const clip = STATE.doc.clips.find((x) => x.id === STATE.selectedClipId);

    // Delete / Backspace：删除选中集里的全部片段（无选中时也给状态栏提示）
    if (e.code === 'Delete' || e.code === 'Backspace') {
      e.preventDefault();
      deleteSelection();
      return;
    }

    // 方向键：移动播放头；选中片段时移动片段
    //   默认按网格步进并吸附；Alt = 微调 10ms（不吸附，用于精细对齐）；
    //   Shift = 移动 1ms（最精细）
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      const dir = e.code === 'ArrowLeft' ? -1 : 1;
      const fine = e.altKey || e.shiftKey;
      const step = e.shiftKey ? 1 : (e.altKey ? 10 : STATE.doc.config.gridMs);

      if (clip) {
        if (isLocked(clip)) {
          // 锁定的片段不吃方向键：避免"想挪播放头却把对齐好的片段挪走"
          status(`「${clip.label}」已锁定 —— 右键菜单选「解锁」后再移动`, '锁定：防止误拖');
          return;
        }
        clip.startMs = Math.max(0, clip.startMs + dir * step);
        // 只有在非微调模式下才吸附，否则微调没意义
        if (STATE.doc.config.snap && !fine) {
          clip.startMs = Math.round(clip.startMs / STATE.doc.config.gridMs) * STATE.doc.config.gridMs;
        }
        // 方向键挪片段也是改文档：必须标脏（否则关窗不提示保存）+ 进撤销栈（卡 t_6b99a1fd）
        markDirty('move');
        renderTimeline(); renderProps(); revalidate();
        status(
          `片段位于 ${(clip.startMs / 1000).toFixed(3)}s` + (fine ? '（微调，已脱离网格）' : '')
        );
      } else {
        STATE.playheadMs = Math.max(0, (STATE.playheadMs || 0) + dir * step);
        updatePlayhead(STATE.playheadMs);
        syncVisualTo(STATE.playheadMs);
      }
      return;
    }

    // Home / End：播放头到开头 / 结尾
    if (e.code === 'Home') {
      e.preventDefault();
      STATE.playheadMs = 0; updatePlayhead(0); syncVisualTo(0);
      return;
    }
    if (e.code === 'End') {
      e.preventDefault();
      const t = totalMs();
      STATE.playheadMs = t; updatePlayhead(t); syncVisualTo(t);
      return;
    }

    // +/-：缩放时间轴
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      STATE.zoom = Math.min(4, STATE.zoom * 1.2);
      $('rngZoom').value = String(STATE.zoom);
      renderTimeline(); updateZoomFitHint();
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      STATE.zoom = Math.max(0.02, STATE.zoom / 1.2);
      $('rngZoom').value = String(STATE.zoom);
      renderTimeline(); updateZoomFitHint();
      return;
    }

    // F：缩放到整段刚好铺满窗口（长时序找不到头尾时很有用）
    if (!e.ctrlKey && !e.metaKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      zoomToFit();
      return;
    }

    // M / S：切换选中片段所在轨道的静音 / 独奏
    if (!e.ctrlKey && !e.metaKey && clip && (e.key === 'm' || e.key === 'M')) {
      const t = STATE.doc.tracks.find((x) => x.name === clip.track);
      if (t) { t.muted = !t.muted; markDirty('mute'); renderTimeline(); status(`${t.label}：${t.muted ? '已静音' : '取消静音'}`); }
      return;
    }
    if (!e.ctrlKey && !e.metaKey && clip && (e.key === 's' || e.key === 'S')) {
      const t = STATE.doc.tracks.find((x) => x.name === clip.track);
      if (t) { t.solo = !t.solo; markDirty('solo'); renderTimeline(); status(t.solo ? `${t.label}：独奏中` : `${t.label}：退出独奏`); }
      return;
    }

    // Enter：试听选中片段
    if (e.code === 'Enter' && clip) {
      e.preventDefault();
      $('btnAudition').click();
      return;
    }

    // Ctrl+↑/↓：把选中的片段（可多个）移到上一条 / 下一条轨道
    if (e.ctrlKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown') && clip) {
      e.preventDefault();
      moveSelectionByTrack(e.code === 'ArrowDown' ? 1 : -1);
      return;
    }

    // D：复制选中的（可能多个）片段，副本紧跟各自之后（Ctrl+D 不拦，避免和系统快捷键打架）
    if (!e.ctrlKey && !e.metaKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      duplicateSelection();
      return;
    }
  });
}

/** 复制一个片段，紧跟在原片段之后（batch=true 时由调用方统一重绘/给反馈） */
function duplicateClip(clip, opts) {
  const o = opts || {};
  const copy = makeClip(Object.assign({}, clip, {
    id: undefined,
    startMs: clip.startMs + clip.durationMs,
  }));
  STATE.doc.clips.push(copy);
  markDirty('dup');            // 卡 t_c4491bba：带 kind，撤销时说清是「复制片段」
  if (!o.batch) {
    setSelection([copy.id], copy.id);
    renderTimeline(); renderProps(); revalidate();
    status('已复制片段', (copy.startMs / 1000).toFixed(2) + 's 处');
  }
  return copy;
}

/** D 键 / 右键菜单「再复制一份」：选中的每个片段各复制一份，副本紧跟其后 */
function duplicateSelection() {
  const sel = selectedClips();
  if (!sel.length) { status('没有选中的片段 —— 先选中片段再按 D'); return 0; }
  const copies = sel.map((c) => duplicateClip(c, { batch: true }));
  setSelection(copies.map((c) => c.id), copies[0].id);
  renderTimeline(); renderProps(); revalidate();
  status(sel.length > 1 ? `已复制 ${sel.length} 个片段（副本紧跟其后）` : '已复制片段（副本紧跟其后）',
         (copies[0].startMs / 1000).toFixed(2) + 's 处');
  return copies.length;
}

// ---------------------------------------------------------------------------
// 复制 / 粘贴（剪贴板是模块级变量，不依赖系统剪贴板）
//   粘贴落点规则：粘到**播放头**位置，片段之间的相对间距保持不变。
// ---------------------------------------------------------------------------
let CLIPBOARD = null;   // { items: [{ data: 片段副本, offsetMs }] }

/** Ctrl+C / 「复制」：把选中片段放进剪贴板（相对最早片段存偏移） */
function copySelection() {
  const sel = selectedClips();
  if (!sel.length) {
    status('没有选中的片段 —— 先在时间轴上框选或点击片段，再按 Ctrl+C');
    return 0;
  }
  const base = Math.min.apply(null, sel.map((c) => c.startMs));
  CLIPBOARD = {
    items: sel.map((c) => ({
      data: JSON.parse(JSON.stringify(c)),
      offsetMs: c.startMs - base,
    })),
  };
  status(`已复制 ${sel.length} 个片段 —— 按 Ctrl+V 会粘贴到播放头位置`);
  return CLIPBOARD.items.length;
}

/** Ctrl+V / 「粘贴到播放头」：保持相对间距，新片段全部选中 */
function pasteAtPlayhead() {
  if (!CLIPBOARD || !CLIPBOARD.items.length) {
    status('剪贴板是空的 —— 先选中片段并按 Ctrl+C 复制');
    return null;
  }
  const at = Math.max(0, Math.round(STATE.playheadMs || 0));
  const created = CLIPBOARD.items.map((it) => {
    const c = makeClip(Object.assign({}, it.data, { id: undefined, startMs: at + it.offsetMs }));
    STATE.doc.clips.push(c);
    return c;
  });

  let maxEnd = 0;
  for (const c of created) maxEnd = Math.max(maxEnd, c.startMs + c.durationMs);
  autoExtendTotal(at, maxEnd - at);      // 粘到总长之外时自动延长总线

  markDirty('paste');          // 卡 t_c4491bba：带 kind，撤销时说清是「粘贴片段」
  setSelection(created.map((c) => c.id), created[0].id);
  renderTimeline(); renderProps(); revalidate();

  // 与已有片段重叠时也要说清楚，不能静默（用户会以为粘错了）
  const newIds = new Set(created.map((c) => c.id));
  let overlaps = 0;
  for (const c of created) {
    const hit = STATE.doc.clips.some((x) =>
      !newIds.has(x.id) && x.track === c.track &&
      c.startMs < x.startMs + x.durationMs && x.startMs < c.startMs + c.durationMs);
    if (hit) overlaps++;
  }
  status(`已在 ${(at / 1000).toFixed(3)}s 粘贴 ${created.length} 个片段（相对间距保持不变）`
    + (overlaps ? `　⚠ ${overlaps} 个与已有片段重叠` : ''));
  return created.map((c) => c.id);
}

/** Del / Backspace / 「删除」按钮：删除选中集里的全部片段 */
function deleteSelection() {
  const sel = selectedClips();
  if (!sel.length) { status('没有选中的片段可删除'); return 0; }
  const ids = new Set(sel.map((c) => c.id));

  // 留一份「原位快照」：删除是这里唯一会丢数据的动作，
  // 没有撤销栈时至少让 Ctrl+Z 能把这一步退回去。
  const entries = [];
  STATE.doc.clips.forEach((c, i) => {
    if (ids.has(c.id)) entries.push({ clip: c, index: i });
  });
  UNDO_DELETE = { entries };

  STATE.doc.clips = STATE.doc.clips.filter((c) => !ids.has(c.id));
  clearSelection();
  markDirty('delete');         // 卡 t_c4491bba：带 kind —— 删除这种丢数据的动作最需要说清
  renderTimeline(); renderProps(); revalidate();
  status((sel.length > 1
    ? `已删除 ${sel.length} 个片段`
    : `已删除片段「${sel[0].label}」`) + '（Ctrl+Z 可撤销）');
  return sel.length;
}

/** Ctrl+A / 右键菜单「全选」 */
function selectAllClips() {
  if (!STATE.doc.clips.length) { status('时间轴上还没有片段'); return 0; }
  const ids = STATE.doc.clips.map((c) => c.id);
  const keep = STATE.selectedClipIds.has(STATE.selectedClipId) ? STATE.selectedClipId : null;
  setSelection(ids, keep);
  renderTimeline(); renderProps();
  selectionStatus('已全选');
  return ids.length;
}

// ---------------------------------------------------------------------------
// 片段级编辑动作（右键菜单 + 快捷键共用同一套实现）
//   按播放头拆分 / 对齐到网格 / 锁定解锁 / 撤销删除
// ---------------------------------------------------------------------------

/**
 * 锁定只挡「在时间轴上移动 / 改长度」，不挡导出、复制、删除。
 * 用途：配音时最怕手一抖把已经对齐好的片段拖歪。
 */
function isLocked(c) { return !!(c && c.locked); }

/** 拆分点必须严格落在片段两端之间（贴在边缘拆等于没拆） */
function canSplitAt(c, at) {
  return !!c && at > c.startMs + 1 && at < c.startMs + c.durationMs - 1;
}

/** 当前播放头（拆分点） */
function splitPointMs() { return Math.round(STATE.playheadMs || 0); }

/** 右键菜单用：选中集里有没有「能按播放头拆」的片段 */
function splittableSelection() {
  const at = splitPointMs();
  return selectedClips().filter((c) => !isLocked(c) && canSplitAt(c, at));
}

/**
 * 按播放头拆分选中的片段。
 * 左半段沿用原片段的 id（轨道 / 参数 / 备注 / 锁定状态都不动），
 * 右半段是新建片段，并把「裁剪头」offsetMs 往后推，
 * 保证右半段接着原音频的对应位置播（不是从头再放一遍）。
 */
function splitSelectionAtPlayhead() {
  const at = splitPointMs();
  const sel = selectedClips();
  if (!sel.length) { status('没有选中的片段 —— 先选中要拆的片段'); return 0; }

  const targets = sel.filter((c) => !isLocked(c) && canSplitAt(c, at));
  if (!targets.length) {
    if (sel.every(isLocked)) {
      status('选中的片段都已锁定 —— 先在右键菜单里解锁再拆分');
    } else {
      status(`播放头不在选中的片段内部（${(at / 1000).toFixed(3)}s）`,
             '把播放头拖到片段中间再拆分');
    }
    return 0;
  }

  const rightIds = [];
  for (const c of targets) {
    const right = makeClip(Object.assign({}, c, {
      id: undefined,
      startMs: at,
      durationMs: Math.max(1, Math.round(c.startMs + c.durationMs - at)),
      offsetMs: Math.round((c.offsetMs || 0) + (at - c.startMs)),
    }));
    c.durationMs = Math.max(1, Math.round(at - c.startMs));
    STATE.doc.clips.push(right);
    rightIds.push(right.id);
  }

  markDirty('split');          // 卡 t_c4491bba：带 kind，撤销时说「拆分片段」
  setSelection(targets.map((c) => c.id).concat(rightIds), targets[0].id);
  renderTimeline(); renderProps(); revalidate();
  status(`已在 ${(at / 1000).toFixed(3)}s 拆分 ${targets.length} 个片段`
    + `（共 ${targets.length} + ${rightIds.length} 段，左右两段时长相加 = 原时长）`);
  return rightIds.length;
}

/**
 * 对齐到网格（网格步长取当前设置：固定毫秒 或 按拍 BPM）。
 * 单选：把这个片段吸到最近的网格线。
 * 多选：整组按「主选中」的落点整体平移，相对间距保持不变
 *       （各自吸会把组内的相对节奏挤变形，和拖动保持一致）。
 */
function alignSelectionToGrid() {
  const sel = selectedClips();
  if (!sel.length) { status('没有选中的片段 —— 先选中再对齐'); return 0; }

  const movable = sel.filter((c) => !isLocked(c));
  if (!movable.length) { status('选中的片段都已锁定 —— 先在右键菜单里解锁再对齐'); return 0; }

  const cfg = STATE.doc.config;
  const g = window.MCS.effectiveGridMs(cfg);
  const anchor = movable.find((c) => c.id === STATE.selectedClipId) || movable[0];

  let delta = Math.round(anchor.startMs / g) * g - anchor.startMs;
  let minStart = Infinity;
  for (const c of movable) minStart = Math.min(minStart, c.startMs);
  if (minStart + delta < 0) delta = -minStart;      // 谁也不许被推到负时间
  delta = Math.round(delta);

  for (const c of movable) c.startMs = Math.max(0, Math.round(c.startMs + delta));

  const skipped = sel.length - movable.length;
  const gridName = cfg.gridMode === 'beat' && cfg.bpm > 0
    ? `按拍（${cfg.bpm} BPM，一拍 ${Math.round(g)}ms）`
    : `${Math.round(g)}ms`;
  markDirty('align');          // 卡 t_c4491bba：带 kind，撤销时说「对齐到网格」
  renderTimeline(); renderProps(); revalidate();
  if (delta === 0) {
    status(`选中的 ${movable.length} 个片段本来就在网格上（${gridName}）`
      + (skipped ? `　⚠ ${skipped} 个已锁定未动` : ''));
  } else {
    status(`已对齐到 ${gridName} 网格：${movable.length} 个片段整体移动 `
      + `${(delta / 1000).toFixed(3)}s（相对间距保持不变）`
      + (skipped ? `　⚠ ${skipped} 个已锁定未动` : ''));
  }
  return movable.length;
}

/** 锁定 / 解锁选中的片段：force 省略时按「是否全部已锁定」自动决定（菜单语义） */
function toggleLockSelection(force) {
  const sel = selectedClips();
  if (!sel.length) { status('没有选中的片段 —— 先选中再锁定'); return 0; }
  const lock = force === undefined ? !sel.every(isLocked) : !!force;
  for (const c of sel) c.locked = lock;
  markDirty('lock');           // 卡 t_c4491bba：带 kind，撤销时说「锁定 / 解锁」
  renderTimeline(); renderProps(); revalidate();
  status(lock
    ? `已锁定 ${sel.length} 个片段 —— 不能再拖动 / 改长度（右键菜单可解锁）`
    : `已解锁 ${sel.length} 个片段 —— 可以正常拖动 / 改长度`);
  return sel.length;
}

// ---------------------------------------------------------------------------
// 删除的安全网：一次性撤销（目前没有通用撤销栈，这里只保护「删除」这一步）
//   Ctrl+Z / 右键菜单「撤销删除」都能把刚删掉的片段按原位置放回去。
// ---------------------------------------------------------------------------
let UNDO_DELETE = null;   // { entries: [{ clip, index }] }

function restoreLastDelete() {
  if (!UNDO_DELETE || !UNDO_DELETE.entries.length) {
    status('没有可撤销的删除');
    return 0;
  }
  const entries = UNDO_DELETE.entries.slice().sort((a, b) => a.index - b.index);
  for (const e of entries) {
    const idx = Math.max(0, Math.min(e.index, STATE.doc.clips.length));
    STATE.doc.clips.splice(idx, 0, e.clip);
  }
  const ids = entries.map((e) => e.clip.id);
  const n = ids.length;
  UNDO_DELETE = null;
  markDirty('delete');         // 卡 t_c4491bba：撤销「撤销删除」= 再删一次，所以标签仍是「删除片段」
  setSelection(ids, ids[0]);
  renderTimeline(); renderProps(); revalidate();
  status(`已撤销删除 —— 恢复 ${n} 个片段（位置 / 参数原样放回）`);
  return n;
}

// ---------------------------------------------------------------------------
// 保存类快捷键（Ctrl+S / Ctrl+Shift+S）的**唯一入口**
//
// 两条路径都走这里，语义必须完全一致：
//   1) 渲染进程的 keydown（普通情况，见上面的键盘处理）；
//   2) 主进程 before-input-event → IPC 'save-shortcut'
//      —— 中文输入法组字期间（拼音还没上屏），渲染进程的 keydown 只收到
//         key='Process'（keyCode 229），看不到按的是哪个字母；主进程在 keyUp
//         那一拍能看到真实的 key='s' + control，于是在主进程把这一条路接回来。
//
// 两个必须守住的点，都是实测出来的（mcs-qa 卡 t_e3735e8c 复现）：
//   a. 输入框里「改到一半」的编辑要一起存进去：BPM / 总长 / 属性数值都是
//      change（失焦）才提交的，不先提交就会把**旧值**写进 timeline.json。
//      blur() 会触发 change（值没被改过就不触发，天然幂等）。
//   b. 但 blur() 会把焦点扔到 <body>，而 <body> 就是时间轴的快捷键作用域
//      （退格 / Delete = 删片段、方向键 = 挪片段、空格 = 播放）——
//      复现：选中片段 → 点进搜索框打字 → Ctrl+S → 再按一下退格，
//      用户想删的是搜索框里那个字，结果**丢掉了一个片段**。
//      所以提交完必须把焦点还给原来那个输入框。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 输入法组字（IME composition）状态 —— 保存路径必须等组字上屏再落盘
//
// 为什么保存这一拍非要关心它（mcs-qa 卡 t_53d1d4b4 实测复现）：
//   中文输入法打字的「组字」阶段，拼音串会先写进输入框的 value，但**还没上屏**
//   （框里显示 yan'shou'NAME）。此时按 Ctrl+S：
//     · 主进程在 keyUp 把这一下转发过来 → 走到 performSaveShortcut；
//     · blur() 确实会让输入法把候选上屏，但 Chromium 的 compositionend / input
//       是**稍后**才到的另一拍，而 buildAllExports() 是同步取值 ——
//       于是磁盘里存的是半成品拼音（yan'shou'NAME），界面和标题却是上屏后的
//       yanshouNAME。用户看到什么，磁盘就必须是什么。
//   所以：正在组字时先 blur 把这一拍交给输入法，等 compositionend（以及随后那条
//   把最终文字写进文档的 input）落定，再把焦点还回去并落盘，全程只保存一次。
//   组字状态用 window 捕获阶段的 compositionstart / compositionend 跟踪，
//   覆盖面包含全部输入框（#eName / #pLabel / #pNote / 搜索框…）。
// ---------------------------------------------------------------------------
const IME = { composing: false };

window.addEventListener('compositionstart', () => { IME.composing = true; }, true);
window.addEventListener('compositionend', () => { IME.composing = false; }, true);

/**
 * 等「组字上屏」落定后回调一次。
 *
 * blur() 之后输入法提交候选，会先后派发 compositionend 和一条 input —— 后者才是
 * 把最终文字写进文档（doc.name / clip.label / clip.note…）的那一拍，所以不能
 * blur 完就立刻取值。事件先后顺序各浏览器/输入法不一，这里两边都等：
 *   · compositionend 之后再等 80ms 收 input；收到 input 后 40ms 收尾；
 *   · 兜底 500ms：有些输入法失焦也不上屏，那时也必须保存（宁可存到半成品，
 *     也不能让用户白按一次 Ctrl+S、工程还一直脏着）。
 * arm() 在监听器装好之后才执行（组字那一拍就交给它，通常是 blur()），
 * 免得 blur 同步派出 compositionend 时我们还没开始监听。
 */
function whenCompositionSettled(fn, arm) {
  let done = false;
  let settle = 0;
  const finish = () => {
    if (done) return;
    done = true;
    document.removeEventListener('compositionend', onEnd, true);
    document.removeEventListener('input', onInput, true);
    clearTimeout(settle); clearTimeout(hard);
    fn();
  };
  const onInput = () => { clearTimeout(settle); settle = setTimeout(finish, 40); };
  const onEnd = () => {
    document.addEventListener('input', onInput, true);
    clearTimeout(settle); settle = setTimeout(finish, 80);
  };
  const hard = setTimeout(finish, 500);
  document.addEventListener('compositionend', onEnd, true);
  if (typeof arm === 'function') {
    try { arm(); } catch (e) { /* 忽略：提交失败也不能拦住保存 */ }
  }
}

function performSaveShortcut(saveAs) {
  const focused = document.activeElement;
  const isField = !!focused && focused !== document.body
    && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.isContentEditable);
  if (!isField) return saveProjectShortcut(!!saveAs);

  // 属性面板的输入框有可能在提交过程中被重绘替换掉，所以先记 id，再按 id 找回来。
  const id = focused.id || '';
  const findBack = () => (id ? document.getElementById(id) : (focused.isConnected ? focused : null));
  const refocus = () => {
    const back = findBack();
    if (back && typeof back.focus === 'function') {
      try { back.focus(); } catch (e) { /* 忽略 */ }
    }
  };

  // 输入法还在组字（拼音没上屏）：先让 blur 把这一拍提交给输入法，
  // 等 compositionend + input 落定后再把焦点还回去并落盘 —— 磁盘内容 = 用户看到的内容。
  if (IME.composing) {
    status('中文输入法还在组字 —— 已在上屏后立即保存…', '这次 Ctrl+S 不会丢');
    return new Promise((resolve) => {
      whenCompositionSettled(() => {
        refocus();
        resolve(saveProjectShortcut(!!saveAs));
      }, () => {
        try { focused.blur(); } catch (e) { /* 忽略：提交失败也不能拦住保存 */ }
      });
    });
  }

  try { focused.blur(); } catch (e) { /* 忽略：提交失败也不能拦住保存 */ }
  refocus();
  return saveProjectShortcut(!!saveAs);
}

// ---------------------------------------------------------------------------
// Ctrl+S：保存工程源文件（timeline.json）
//   有保存位置就直接写回；没有位置就弹「另存为」让用户选（并在状态栏说清楚）。
//   这个函数只做保存这一件事 —— 绝不修改轨道 / 片段的任何状态。
// ---------------------------------------------------------------------------
let SAVE_PATH = null;      // 最近一次保存 timeline.json 的完整路径

async function saveProjectShortcut(forceDialog) {
  const f = buildAllExports().timeline;
  if (SAVE_PATH && !forceDialog) {
    // 写回「用户上次定下的那个文件」：目录 **和文件名** 都取自 SAVE_PATH。
    // 这里绝不能再用 f.name（= 工程名.timeline.json），否则用户在「另存为」
    // 里自己起的文件名会被顶掉 —— 同目录里会另生一个按工程名自动命名的副本，
    // 用户那份永远停在旧内容，而状态栏还在报原路径（界面和磁盘对不上）。
    const cut = Math.max(SAVE_PATH.lastIndexOf('\\'), SAVE_PATH.lastIndexOf('/'));
    const dir = cut > 0 ? SAVE_PATH.slice(0, cut) : SAVE_PATH;
    const name = cut > 0 ? SAVE_PATH.slice(cut + 1) : f.name;
    const r = await window.mcs.saveManyToDir({ dir, files: [{ name, content: f.content }] });
    if (r && r.ok) {
      // 以磁盘上真正写入的路径为准：状态栏报的必须就是它
      SAVE_PATH = (r.written && r.written[0]) || SAVE_PATH;
      markClean();
      status('已保存工程：' + SAVE_PATH, 'Ctrl+S 保存');
      recordRecentProject(SAVE_PATH, STATE.doc.name);
      return SAVE_PATH;
    }
    status('写回原位置失败，请重新选择保存位置：' + ((r && r.error) || '未知错误'));
  } else if (!SAVE_PATH) {
    status('还没有保存过 —— 请在「另存为」对话框里选择 timeline.json 的保存位置');
  }
  const r2 = await window.mcs.saveFile({
    defaultName: f.name,
    content: f.content,
    filters: [{ name: 'TimeLine JSON', extensions: ['json'] }],
  });
  if (r2 && r2.ok) {
    SAVE_PATH = r2.path;
    markClean();
    status('已保存工程：' + r2.path, 'Ctrl+S 保存');
    recordRecentProject(SAVE_PATH, STATE.doc.name);
    return r2.path;
  }
  if (r2 && !r2.canceled) status('保存失败：' + r2.error);
  else status('已取消保存 —— 工程没有写入磁盘');
  return null;
}

// 说明（卡 t_49c08ec4）：这里原来还有一份同名的 continueAfterUnsavedChanges，
// 与下方（overviewApi 之前）那一份重复。函数声明会整体提升、后者生效，前者是死代码，
// 且它绕过了 performSaveShortcut 的输入法组字提交，留着迟早会咬人 —— 已删掉，只保留一份。

// ---------------------------------------------------------------------------
// 时间轴右键菜单
//   片段菜单：属性 / 复制 / 粘贴到播放头 / 再复制一份 / 按播放头拆分 /
//             对齐到网格 / 移到上一条·下一条轨道 / 锁定·解锁 / 全选 / 删除
//   空白菜单：粘贴到播放头 / 撤销删除 / 全选 / 取消选中
//   菜单容器只有一个：#clipMenu（见 index.html），别新建第二个，
//   否则右键会同时弹出两个菜单。
// ---------------------------------------------------------------------------

/** 「移到上一条 / 下一条轨道」：整组一起平移，相对层级不变（dir = -1 上移 / +1 下移） */
function moveSelectionByTrack(dir) {
  const sel = selectedClips();
  if (!sel.length) { status('没有选中的片段 —— 先选中要换轨的片段'); return 0; }
  const movable = sel.filter((c) => !isLocked(c));
  if (!movable.length) { status('选中的片段都已锁定 —— 先在右键菜单里解锁再换轨'); return 0; }

  const names = STATE.doc.tracks.map((t) => t.name);
  const idxs = movable.map((c) => names.indexOf(c.track));
  const lo = Math.min.apply(null, idxs);
  const hi = Math.max.apply(null, idxs);
  // 整组必须有地方可去：上移时整组最上面那条不能在顶，下移同理
  if (lo < 0 || (dir < 0 && lo === 0) || (dir > 0 && hi === names.length - 1)) {
    status(dir < 0 ? '已经在最上面一条轨道了' : '已经在最下面一条轨道了');
    return 0;
  }
  const skipped = sel.length - movable.length;
  for (const c of movable) c.track = names[names.indexOf(c.track) + dir];
  const t = STATE.doc.tracks.find((x) => x.name === movable[0].track);
  STATE.selectedTrack = movable[0].track;
  markDirty('move');           // 卡 t_c4491bba：带 kind（换轨道也是「移动片段」）
  renderTimeline(); renderProps(); revalidate();
  status(`已把 ${movable.length} 个片段移到「${t ? t.label : movable[0].track}」`
    + (skipped ? `　⚠ ${skipped} 个已锁定未动` : ''));
  return movable.length;
}

function menuAction(act) {
  switch (act) {
    case 'copy': copySelection(); break;
    case 'paste': pasteAtPlayhead(); break;
    case 'duplicate': duplicateSelection(); break;
    case 'delete': deleteSelection(); break;
    case 'split': splitSelectionAtPlayhead(); break;
    case 'align': alignSelectionToGrid(); break;
    case 'lock': toggleLockSelection(true); break;
    case 'unlock': toggleLockSelection(false); break;
    case 'undoDelete': restoreLastDelete(); break;
    // 通用撤销 / 重做（卡 t_6b99a1fd）：右键菜单和 Ctrl+Z / Ctrl+Y 是同一套栈
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'moveUp': moveSelectionByTrack(-1); break;
    case 'moveDown': moveSelectionByTrack(1); break;
    case 'selectAll': selectAllClips(); break;
    case 'deselect':
      clearSelection(); renderTimeline(); renderProps(); status('已取消选中');
      break;
    case 'props': {
      // 「属性」= 把眼睛带到右侧属性面板：切到属性页签 + 闪一下边框
      const tab = document.querySelector('.tab[data-tab="props"]');
      if (tab) tab.click();
      const body = $('tab-props');
      if (body) {
        body.classList.remove('ctx-flash');
        void body.offsetWidth;          // 重启 CSS 动画
        body.classList.add('ctx-flash');
        setTimeout(() => body.classList.remove('ctx-flash'), 1000);
      }
      const n = STATE.selectedClipIds.size;
      status(n > 1
        ? `属性面板在右侧 —— 已选中 ${n} 个片段，面板里显示整组摘要`
        : '属性面板在右侧 —— 选中的片段参数在那里改');
      break;
    }
    default: break;
  }
}

function setupLaneContextMenu() {
  const lanes = $('laneArea');
  const menu = $('clipMenu');
  if (!lanes || !menu) return;

  const closeMenu = () => { menu.style.display = 'none'; menu.innerHTML = ''; };

  const renderMenu = (items, x, y) => {
    menu.innerHTML = items.map((it) => (it.sep
      ? '<div class="ctx-sep"></div>'
      : `<button class="ctx-item" data-act="${esc(it.act)}"`
        + `${it.disabled ? ' disabled' : ''}`
        + `${it.hint ? ` title="${esc(it.hint)}"` : ''}>`
        + `<span>${esc(it.label)}</span><span class="ctx-key">${esc(it.key || '')}</span></button>`
    )).join('');
    menu.style.display = 'block';
    // 别超出窗口边缘（先量尺寸再落位，左右/上下都夹住）
    const r = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.dataset.anchorX = x;
    menu.dataset.anchorY = y;
  };

  const hasClipboard = () => !!(CLIPBOARD && CLIPBOARD.items.length);
  const hasUndo = () => !!(UNDO_DELETE && UNDO_DELETE.entries.length);

  lanes.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const clipEl = e.target.closest('.clip');

    if (!clipEl) {
      // ---- 右键空白：只放和整条时间轴有关的动作（不清空选中） ----
      renderMenu([
        { act: 'paste', label: '粘贴到播放头', key: 'Ctrl+V', disabled: !hasClipboard(),
          hint: hasClipboard() ? '' : '剪贴板是空的：先选中片段按 Ctrl+C 复制' },
        // 「撤销 / 重做」走通用撤销栈（卡 t_6b99a1fd）：删除只是它能撤的动作之一，
        // 移动片段 / 改长度 / 改参数 / 改总长 / 加轨道 都各算一步。
        { act: 'undo', label: '撤销', key: 'Ctrl+Z', disabled: !canUndo(),
          hint: canUndo() ? UNDO_LABELS[(UNDO.past[UNDO.past.length - 1] || {}).kind] || '' : '还没有可撤销的操作' },
        { act: 'redo', label: '重做', key: 'Ctrl+Y', disabled: !canRedo(),
          hint: canRedo() ? UNDO_LABELS[(UNDO.future[UNDO.future.length - 1] || {}).kind] || '' : '没有可重做的操作' },
        { sep: 1 },
        { act: 'selectAll', label: '全选', key: 'Ctrl+A' },
        { act: 'deselect', label: '取消选中', key: 'Esc' },
      ], e.clientX, e.clientY);
      return;
    }

    const id = clipEl.dataset.clipId;
    // 右键未选中的片段 = 只选它；右键已在选中集里的片段 = 菜单作用于整组
    if (!STATE.selectedClipIds.has(id)) {
      setSelection([id], id);
      selectionStatus('已选中');
    } else {
      STATE.selectedClipId = id;
      selectionStatus('已选中');
    }
    renderTimeline(); renderProps();

    const sel = selectedClips();
    const n = sel.length;
    const suffix = n > 1 ? `（${n} 个）` : '';
    const allLocked = sel.every(isLocked);
    const anyMovable = sel.some((c) => !isLocked(c));
    const splitCount = splittableSelection().length;
    const at = splitPointMs();

    // 「移到上下轨」的可达性：整组是否还有地方可去
    const names = STATE.doc.tracks.map((t) => t.name);
    const idxs = sel.map((c) => names.indexOf(c.track));
    const lo = idxs.length ? Math.min.apply(null, idxs) : 0;
    const hi = idxs.length ? Math.max.apply(null, idxs) : 0;

    renderMenu([
      { act: 'props', label: '属性' + suffix },
      { sep: 1 },
      { act: 'copy', label: '复制' + suffix, key: 'Ctrl+C' },
      { act: 'paste', label: '粘贴到播放头', key: 'Ctrl+V', disabled: !hasClipboard(),
        hint: hasClipboard() ? '' : '剪贴板是空的：先复制再粘贴' },
      { act: 'duplicate', label: '再复制一份（紧跟其后）', key: 'D' },
      { sep: 1 },
      { act: 'split', label: '按播放头拆分' + (splitCount > 1 ? `（${splitCount} 个）` : ''),
        key: '',
        disabled: !splitCount,
        hint: splitCount ? '' : (allLocked
          ? '选中的片段都已锁定，先解锁'
          : `播放头（${(at / 1000).toFixed(3)}s）不在选中的片段内部`) },
      { act: 'align', label: n > 1 ? '对齐到网格（整组保持间距）' : '对齐到网格', key: '',
        disabled: !anyMovable, hint: anyMovable ? '' : '选中的片段都已锁定，先解锁' },
      { act: 'moveUp', label: '移到上一条轨道', key: 'Ctrl+↑',
        disabled: !anyMovable || lo <= 0, hint: lo <= 0 ? '已经在最上面一条轨道了' : '' },
      { act: 'moveDown', label: '移到下一条轨道', key: 'Ctrl+↓',
        disabled: !anyMovable || hi >= names.length - 1,
        hint: hi >= names.length - 1 ? '已经在最下面一条轨道了' : '' },
      { sep: 1 },
      allLocked
        ? { act: 'unlock', label: '解锁' + suffix, key: '' }
        : { act: 'lock', label: '锁定' + suffix, key: '' },
      { act: 'undo', label: '撤销', key: 'Ctrl+Z', disabled: !canUndo(),
        hint: canUndo() ? '撤一步就回到这次改动之前' : '还没有可撤销的操作' },
      { act: 'redo', label: '重做', key: 'Ctrl+Y', disabled: !canRedo(),
        hint: canRedo() ? '' : '没有可重做的操作' },
      { sep: 1 },
      { act: 'selectAll', label: '全选', key: 'Ctrl+A' },
      { act: 'deselect', label: '取消选中', key: 'Esc' },
      { sep: 1 },
      { act: 'delete', label: '删除' + suffix, key: 'Del',
        hint: '删除后可按 Ctrl+Z 撤销' },
    ], e.clientX, e.clientY);
  });

  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.ctx-item');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    closeMenu();
    menuAction(act);
  });

  // 置灰项「为什么点不了」的原因：只写在 title 上，原生提示在置灰按钮上又不可靠，
  // 用户其实看不到。键盘路径本来就会把同类原因打到状态栏（Ctrl+V 说「剪贴板是空的…」、
  // Ctrl+↑ 说「已经在最上面一条轨道了」……），所以鼠标路径也照做，两条路径口径一致。
  // 只处理置灰项：能点亮的项（如「删除」带 hint）悬停不改状态栏，避免覆盖上一步反馈。
  menu.addEventListener('mouseover', (e) => {
    const b = e.target.closest('.ctx-item');
    if (!b || !b.disabled) return;
    const hint = b.getAttribute('title');
    if (hint) status(hint);
  });

  // 点别处 / 滚动 / Esc / 失焦都关掉菜单
  window.addEventListener('mousedown', (e) => {
    if (menu.style.display === 'block' && !menu.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);
  const sa = $('scrollArea');
  if (sa) sa.addEventListener('scroll', closeMenu);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
}


// GIF 播放位置由 setupGifSync / syncGifTo 统一控制：
// 完整的 GIF 解码器（gif.js）已经能逐帧渲染，所以暂停和 seek 都是精确的。

// ---------------------------------------------------------------------------
// 顶部按钮
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 工程库 / 工程总览的渲染侧接线（卡 t_fa17801d）
//
// 判定逻辑只有一份：openProjectFromText()。顶栏「打开」、工程总览点卡片、
// 工程总览里的「打开工程文件…」全部走它 —— 打开成功的判定、失败时的诊断文案、
// 「最近工程」记录、视觉参考恢复，四处行为必须一致。
// ---------------------------------------------------------------------------

/** 工程文件不是工程 → 给人能看懂的原因（与 parsers 里的模型/动画诊断同一风格） */
function projectDiagnosis(content, err, filePath) {
  const name = String(filePath || '').split(/[\\/]/).pop() || '(无名)';
  if (err) {
    const j = MCS_PARSERS.explainJsonError(content || '', err);
    const lines = [`文件：${filePath || name}`, `解析失败：${j.rawMessage}`];
    if (j.where) lines.push(`位置：${j.where}`);
    lines.push('', '可能的原因：');
    for (const r of j.reasons) lines.push('  · ' + r);
    lines.push('', '怎么办：');
    lines.push('  · 用本工具的「保存 / 导出全部」重新导出一份 timeline.json；');
    lines.push('  · 策划案 .md、sound_definitions.json 这些都不是工程文件，只有 .timeline.json 是。');
    return { level: 'error', title: '这个文件不是合法的工程 JSON（解析失败）', lines };
  }
  let doc = null;
  try { doc = JSON.parse(content || ''); } catch (e) { /* 上面已处理 */ }
  const keys = doc && typeof doc === 'object' ? Object.keys(doc).slice(0, 10) : [];
  const lines = [
    `文件：${filePath || name}`,
    `顶层字段：${keys.length ? keys.join(', ') : '(不是对象)'}`,
    '',
  ];
  if (doc && doc.sound_definitions) {
    lines.push('这是 sound_definitions.json（音效注册片段），不是工程文件。');
    lines.push('工程文件是导出时生成的 <名称>.timeline.json。');
  } else if (doc && (doc.animations || doc.elements || doc.meta)) {
    lines.push('这看起来是模型 / 动画文件，不是工程文件。');
    lines.push('要编辑它请点顶栏「导入模型」/「导入动画」；工程请打开 .timeline.json。');
  } else {
    lines.push('工程文件必须同时包含 clips（片段数组）与 config（网格 / 总长等设置）。');
  }
  lines.push('', '怎么办：在「工程总览」里点本工具存过的工程，或先把当前工程「保存到工程库」。');
  return { level: 'error', title: '这个文件不是工程文件（timeline.json）', lines };
}

/** 记一条「最近工程」（失败不影响主流程：只是便利功能） */
async function recordRecentProject(p, name) {
  try {
    if (!p || !window.mcs || !window.mcs.recordProject) return;
    await window.mcs.recordProject({ path: p, name: name || '' });
  } catch (e) { /* 忽略 */ }
}

/**
 * 打开（导入）一份工程内容 → 灌进编辑器。
 * @param opts.source 来源标记（只影响状态栏文案）
 */
async function openProjectFromText(content, filePath, opts) {
  const o = opts || {};
  let doc = null;
  try {
    doc = JSON.parse(content);
  } catch (e) {
    showImportDiagnosis(projectDiagnosis(content, e, filePath));
    status('打开失败：不是合法的 JSON', filePath);
    return { ok: false, error: e.message };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.clips) || !doc.config) {
    showImportDiagnosis(projectDiagnosis(content, null, filePath));
    status('打开失败：这不是工程文件', filePath);
    return { ok: false, error: '缺少 clips / config' };
  }

  // 手改过 / 第三方工具生成的工程常常只写自己关心的字段（比如 clips[] 里没有 pitch），
  // 而渲染 / 播放 / 导出各处会**直接**读这些值 —— 缺一个就抛未捕获异常、时间轴画一半。
  // 统一在这里补齐成 makeClip 的形状（正常工程逐字段全等，行为不变）。
  // 「循环播放」已在卡 t_6b5016ec 里整体移除：老工程里的 loop / loopEndMs 由
  // normalizeImportedDoc 当废弃字段丢掉（不留半截、也不顺手丢别的东西）。
  // 先在这里数一下有几个片段用过，好在状态栏给一句人话 —— 提示只出现这一次，
  // 打开后一存盘，文件里就没有这两个字段了。
  const legacyLoopClips = Array.isArray(doc.clips)
    ? doc.clips.filter((c) => c && typeof c === 'object' && (c.loop || c.loopEndMs != null)).length
    : 0;
  normalizeImportedDoc(doc);

  STATE.doc = doc;
  clearSelection();
  SAVE_PATH = filePath || null;   // 之后 Ctrl+S 直接写回这个文件
  syncDocInputsFromDoc();         // 输入框 / 标题一次刷成新文档的值（与撤销共用一处真相）
  STATE.totalTouched = false;     // 打开的工程：总长还没在这次会话里被用户改过
  markClean();
  undoReset();                    // 换工程 = 清空撤销历史（卡 t_6b99a1fd）
  // 换工程也要清掉「这一档上次选了哪条动画」的会话记忆（卡 t_96cd9241）：
  // 它只是本次会话里的手选记录、不属于文档。不清的话，打开的新工程若没在文件里记 animName，
  // 画布会莫名其妙播起上一个工程选过的动画（自验探针在「坏字段工程」用例上逮到过）。
  STATE.animSel = { keyframe: null, molang: null };

  // 预览画布：先把上一个工程的模型清掉，避免「界面显示 A、工程里是 B」
  MCS_MODELPREVIEW.clear();
  STATE.gifPlayer = null; STATE.gifRenderer = null; STATE.gifAnim = null;
  STATE.videoEl = null; STATE.visualMode = 'none';
  applyVisualStage();
  updateVisualSwitchButton();

  renderTimeline(); renderProps(); revalidate();
  status('已打开工程：' + filePath + (legacyLoopClips
    ? `　· 提示：该工程用过已移除的「循环播放」（${legacyLoopClips} 个片段），现已按「只播一次」处理，`
      + '要重复播放请复制片段'
    : ''), o.source || '');

  recordRecentProject(filePath, doc.name);            // 最近工程（异步，不拦界面）
  await restoreVisualFromDoc(doc, filePath);          // 工程里记着模型 → 重新画回画布
  return { ok: true };
}

/**
 * 打开工程后恢复「视觉参考」。
 * 恢复模型 + 动画（卡 t_96cd9241）：两者都是外部路径引用，重开时读一次就能画 / 能摆姿态。
 * GIF 的 dataUrl 在回存时被刻意剔除（体积），且旧工程的 GIF 路径常常已经不在，
 * 贸然去读会引入新的失败路径 —— 那不在本卡范围内（既有 GIF 行为保持不变）。
 */
async function restoreVisualFromDoc(doc, filePath, opts) {
  const o = opts || {};
  const v = (doc && doc.visual) || {};
  const modelPath = v.modelPath || (v.kind === 'model' ? v.path : null);
  const mediaPath = v.mediaPath || ((v.kind !== 'model' && v.kind !== 'none') ? v.path : null);
  // 视角（卡 t_c54d031b）：先把字段按规格 §4 校验好，画布再按它画。
  // 缺字段 → 默认视角（老工程打开后的观感与改动前逐像素一致）；坏值 → 回落默认值；
  // 全程只读，不往工程文件里写任何东西。
  const restoredView = viewFromVisual(v);
  const isOpen = !o.silent;                 // 打开工程（要给人话反馈）还是撤销/重做（安静恢复）
  // 先撤掉上一个文档遗留的运行时画面，再按当前文档的两个独立素材槽重建。
  clearMediaRuntime();
  MCS_MODELPREVIEW.clear();
  STATE.bbInfo = null;
  if (mediaPath) await importGif(mediaPath, { noStep: true, restore: true });   // 恢复过程不把用户从当前页带走，也不改文档

  /**
   * 恢复动画（卡 t_96cd9241，规格 §4）：
   *   记着 animFile → 把那份 .animation.json 读回来，并按 animName 选中那一条；
   *   只记着 animName（模型自带动画）→ 交给对齐逻辑按名字选中。
   * 全程 silent：不弹窗、不改时间轴总长、不标脏 —— 撤销/重做也不会因此多出撤销步。
   */
  const restoreAnim = async () => {
    if (v.animFile) {
      await importAnimation(v.animFile, { silent: true, noStep: true, selectName: v.animName || null });
    } else {
      reconcileAnimSelection({ persist: false });
    }
    return MCS_MODELPREVIEW.animName;
  };

  if (!modelPath) {
    if (!mediaPath) {
      STATE.visualMode = 'none';
      applyVisualStage();
      $('metaVisual').textContent = '视觉：无';
      $('metaDuration').textContent = '总时长：--';
      $('metaBones').textContent = '骨骼：--';
    }
    await restoreAnim();                    // 没有模型也可以有动画列表（等模型导进来就能播）
    updateVisualSwitchButton();
    renderViewFields(restoredView);
    updateVisualSlots();
    return mediaPath || null;
  }
  const chk = await window.mcs.readTextFile(modelPath);
  if (!chk.ok) {
    STATE.assetIssues.push({
      level: 'warn',
      fromModel: true,
      message: `工程里记的模型「${modelPath}」现在读不到了（${chk.error}）—— 画布上没有模型可显示，其余内容不受影响。`,
    });
    revalidate();
    await restoreAnim();
    updateVisualSwitchButton();
    renderViewFields(restoredView);
    updateVisualSlots();
    return mediaPath || null;
  }
  // 恢复过程一律 silent：不弹「模型解析结果」弹窗（规格 §4：改成状态栏一句话）。
  await importBBModel(modelPath, {
    silent: true,
    noStep: true,
    announceRestore: isOpen,     // 打开工程才补状态栏说明；撤销/重做不抢「已撤销：…」那句
  });
  await restoreAnim();
  // 按工程里存的视角把画布画一次（模型是异步读完才画的，这里保证角度真的套上了）
  if (STATE.visualMode === 'model' && hasRenderableModel()) {
    MCS_MODELPREVIEW.render(STATE.playheadMs || 0);
  }
  updateVisualSwitchButton();
  renderViewFields(restoredView);
  updateVisualSlots();
  return modelPath;
}

/**
 * 把工程名同步到「输入框 / 文档 / 窗口标题」三处。
 * 「另存为新名字」时用它：工程名改了，卡片名、文件名、文件里的 name 才会一致
 * （只改文件名不改工程名的话，总览上两张卡片还是同名，用户照样分不清）。
 */
function setDocName(name) {
  const v = String(name == null ? '' : name);
  $('eName').value = v;
  $('inpProjectName').value = v;
  if (STATE.doc.name !== v) {
    STATE.doc.name = v;
    // 「改名」也要带上自己的 kind（卡 t_26c09aac 第一条）：
    // 不带参数会落到 commitUndo('op')，撤销时状态栏写「已撤销：操作」——
    // 用户在工程库里看到卡片改名，撤销提示却说得很含糊。
    markDirty('name');
  }
  updateWindowTitle();
}

/**
 * 把当前工程存进工程库（工程总览里的按钮）；成功则把 SAVE_PATH 指过去。
 *
 * 同名工程**先问再写**（卡 t_5a1c18be 第一条）：默认工程名固定是「未命名时序」，
 * 「新建 → 保存到工程库」连着来两次必然撞名；以前是静默覆盖 ——
 * 先存的那份内容没了，而用户只看到事后一行状态栏文字，会以为两份都在。
 * 现在先让主进程查一次，有同名工程就让用户选「覆盖 / 另存为新名字 / 取消」，
 * 选「另存为」时连工程名一起改掉，保证卡片名 / 文件名 / 内容三处一致。
 *
 * 把当前工程的 SAVE_PATH 一起报给主进程（卡 t_26c09aac 第三条）：撞名的那个文件
 * 就是「我正在编辑的这份」时，主进程会把默认键放在「更新这份」而不是「另存为」——
 * 否则用户每次改完再点保存，工程库里都会凭空多一张 X (2) 卡片，改动反而没进原来那份。
 */
async function saveProjectToLibrary() {
  let action = 'new';
  let conflict = null;
  try {
    conflict = await window.mcs.resolveLibrarySaveName({ name: STATE.doc.name, currentPath: SAVE_PATH });
  } catch (e) {
    conflict = null;       // 拿不到冲突信息不该拦住保存：按老路存（主进程会如实报 overwrote）
  }
  const mine = !!(conflict && conflict.mine);      // 撞名的文件 = 我正在编辑的这份
  if (conflict && conflict.ok && conflict.conflict) {
    action = conflict.action;
    if (action === 'cancel') {
      const existed = (conflict.existing && conflict.existing.fileName) || conflict.fileName || '';
      status('已取消保存：工程库里已有「' + existed + '」，这次没有写入任何文件',
             '想两份都留下：先把工程名改一个（比如加个「v2」）再存');
      return null;
    }
    if (action === 'rename' && conflict.name) setDocName(conflict.name);
  }

  const all = buildAllExports();
  const r = await window.mcs.saveProjectToLibrary({
    name: STATE.doc.name,
    content: all.timeline.content,
    expectNew: action === 'rename',   // 刚算出来的空位又被人占了 → 如实报错，不静默覆盖
  });
  if (!r || !r.ok) {
    if (r && r.conflict) {
      status('这次没存成：工程库里已经有同名工程「' + STATE.doc.name + '」了',
             '再点一次「保存当前到工程库」，重新选覆盖 / 另存为');
      return null;
    }
    status('存入工程库失败：' + ((r && r.error) || '未知错误'));
    return null;
  }
  SAVE_PATH = r.path;      // 之后 Ctrl+S 直接写回工程库这一份
  markClean();
  if (action === 'rename') {
    status(mine
      ? '已另存为新名字「' + STATE.doc.name + '」：' + r.path
      : '工程库里已有同名工程，已改存为「' + STATE.doc.name + '」：' + r.path,
      mine ? '你原来那份保持不动，现在编辑的是新存的这一份' : '工程名也一起改了，卡片上不会和原来那份混起来');
  } else if (r.overwrote) {
    if (mine) {
      // 撞名的就是自己正在编辑的这份（卡 t_26c09aac 第三条）：这不是「顶掉别人的工程」，
      // 文案不能说成覆盖风险，否则用户每次存自己那份都要犹豫一下
      status('已更新你正在编辑的这份工程：' + r.path,
             '内容已换成最新版本（这一步撤销不了）');
    } else {
      status('已覆盖工程库里的同名工程：' + r.path,
             '原来那份的内容已被替换（这一步撤销不了）—— 想留两份就先改工程名再存');
    }
  } else {
    status('已保存到工程库：' + r.path, '点「工程总览」可以看到它');
  }
  return r.path;
}

/**
 * 离开当前工程前统一确认：新建、打开、回工程列表共用，避免任一入口静默丢改动。
 * 保存失败或用户取消另存为时仍停在原工程，不能假装已经安全离开。
 */
async function continueAfterUnsavedChanges() {
  if (!STATE.dirty) return true;
  const choice = await window.mcs.confirmUnsavedChanges();
  if (choice === 'discard') return true;
  if (choice !== 'save') return false;
  await performSaveShortcut(false);
  return !STATE.dirty;
}

/** 起始页要的回调集合（overview.js 只管画，动作都在这里） */
function overviewApi() {
  return {
    listProjects: () => window.mcs.listProjects(),
    openPath: async (p) => {
      if (!await continueAfterUnsavedChanges()) return { ok: false, canceled: true };
      const fr = await window.mcs.readTextFile(p);
      if (!fr.ok) { status('读取失败：' + fr.error, p); return { ok: false, error: fr.error }; }
      return openProjectFromText(fr.content, p, { source: '工程总览' });
    },
    openProjectFile: async () => {
      if (!await continueAfterUnsavedChanges()) return { ok: false, canceled: true };
      const r = await window.mcs.pickProjectFile();
      if (!r || !r.ok) {
        if (r && !r.canceled) {
          showImportDiagnosis(projectDiagnosis('', null, r.path || ''));
          status('打开失败：' + (r.error || '未知错误'), r.path);
        } else {
          status('已取消打开工程');
        }
        return { ok: false };
      }
      return openProjectFromText(r.content, r.path, { source: '工程总览' });
    },
    newProject: async () => {
      if (!await continueAfterUnsavedChanges()) return { ok: false, canceled: true };
      createNewProject();
      return { ok: true };
    },
    openProjectsFolder: async () => {
      const r = await window.mcs.openProjectsFolder();
      status(r && r.ok ? '已在文件管理器里打开工程库' : '打开工程库失败：' + ((r && r.error) || ''),
             (r && r.dir) || '');
    },
    notify: (msg) => status(msg, '这条最近工程需要你手动处理'),
    openHelp: showHelp,
    openAuthor: openAuthorLink,
    exportSystemInfo,
    onOpen: () => { clearStatusHint(); },
  };
}

function createNewProject() {
  STATE.doc = makeDocument({ name: '未命名时序' });
  clearSelection();
  SAVE_PATH = null;      // 新工程还没有保存位置，Ctrl+S 会先问一次
  STATE.bbInfo = null; STATE.animInfos = [];
  STATE.assetIssues = [];        // 清掉上一个工程模型/动画带来的告警
  $('previewGif').style.display = 'none';
  $('previewEmpty').style.display = 'block';
  $('previewGif').src = '';
  // 新工程把画布上的模型/视觉参考一起清干净（残留上一个工程的模型 = 界面和工程对不上）
  MCS_MODELPREVIEW.clear();
  STATE.gifPlayer = null; STATE.gifRenderer = null; STATE.gifAnim = null;
  STATE.videoEl = null; STATE.visualMode = 'none';
  applyVisualStage();
  updateVisualSwitchButton();
  $('metaVisual').textContent = '视觉：无';
  // 画布像素也要擦掉：显示区域虽然已经隐藏，但残留画面会被截图和自动化读到
  // （「新建后画布是空的」应当是像素意义上也空）
  (function () {
    const cv = $('previewCanvas');
    if (!cv) return;
    const c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#101216';
    c.fillRect(0, 0, cv.width, cv.height);
  })();
  // 界面上的设置值必须跟着新文档一起刷新：工程名 / BPM / 网格 / 吸附 / 总长。
  // 以前这里只手写回总长和名字，BPM 输入框留着上一个工程的值 —— 用户看到 55、
  // Ctrl+S 存到磁盘的却是 0（新建工程的默认值），导出的拍线 / 时间换算也跟着错。
  // 复用「打开工程 / 撤销」共用的那一个函数，别再各写一份（卡 t_e4a641d4 D2）。
  syncDocInputsFromDoc();
  STATE.totalTouched = false;   // 新工程：总长还没被用户改过（GIF 导入可以再自动给初值）
  markClean();
  undoReset();                  // 撤销栈必须清空：旧工程的快照绝不能被撤进新工程（卡 t_6b99a1fd）
  $('metaBones').textContent = '骨骼：--';
  $('metaDuration').textContent = '总时长：--';
  renderTimeline(); renderProps(); revalidate();
  status('已新建时序');
}

function setupTopbar() {
  $('btnLoadVanilla').addEventListener('click', loadVanillaLibrary);
  $('btnScanFolder').addEventListener('click', scanFolder);
  $('btnBackToProjects').addEventListener('click', async () => {
    if (!await continueAfterUnsavedChanges()) return;
    await MCS_OVERVIEW.open(overviewApi());
  });
  $('btnZoomFit').addEventListener('click', zoomToFit);
  $('btnAddFiles').addEventListener('click', addFiles);
  $('inpSearch').addEventListener('input', () => { updateSearchClear(); renderLibrary(); });
  setupSearchClear();

  $('btnImportGif').addEventListener('click', async () => {
    // 按钮标题写的是「导入 GIF / 视频 / 图片」，对话框的过滤器就必须真的能选到视频。
    // 以前这里只写图像扩展名，Windows 下用户在弹出的框里根本看不到 .mp4，
    // 「导入视频」这条路人只能靠手打路径 —— 本卡验收（导入 MP4 → 删除）会直接卡住。
    const r = await window.mcs.pickFiles({
      title: '选择 GIF / 视频 / 图片',
      filters: [
        { name: '图像（GIF / 图片）', extensions: ['gif', 'png', 'jpg', 'jpeg', 'webp'] },
        { name: '视频', extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv'] },
      ],
    });
    if (r.ok) importGif(r.paths[0]);
  });

  $('btnImportBB').addEventListener('click', async () => {
    const r = await window.mcs.pickFiles({
      title: '选择 Blockbench 模型',
      filters: [{ name: 'Blockbench 模型', extensions: ['bbmodel', 'json'] }],
    });
    if (r.ok) importBBModel(r.paths[0]);
  });

  $('btnImportAnim').addEventListener('click', async () => {
    const r = await window.mcs.pickFiles({
      title: '选择动画文件',
      filters: [{ name: '动画 JSON', extensions: ['json'] }],
    });
    if (r.ok) importAnimation(r.paths[0]);
  });

  $('btnNew').addEventListener('click', async () => {
    if (!await continueAfterUnsavedChanges()) return;
    createNewProject();
  });

  $('btnSaveTimeline').addEventListener('click', () => saveProjectShortcut(false));

  $('btnOpenTimeline').addEventListener('click', async () => {
    if (!await continueAfterUnsavedChanges()) return;
    const r = await window.mcs.pickFiles({
      title: '打开 timeline.json',
      filters: [{ name: 'TimeLine JSON', extensions: ['json'] }],
    });
    if (!r.ok) return;
    const fr = await window.mcs.readTextFile(r.paths[0]);
    if (!fr.ok) { status('读取失败：' + fr.error); return; }
    // 打开 = 导入工程：与「工程总览」点卡片走同一条实现（判定 / 诊断 / 最近工程一份）
    await openProjectFromText(fr.content, r.paths[0], { source: '顶栏打开' });
  });

  $('btnExportAll').addEventListener('click', doExportAll);

  // ---------------------------------------------------------------------------
  // 这几项（网格 / 吸附 / BPM / 总长 / 工程名）都会**写进 timeline.json**，
  // 所以只要值真的变了就必须标脏 —— 否则用户改完 BPM 直接关窗，主进程
  // before-quit 只看到 hasUnsavedChanges=false，不弹二次确认，改动静默丢失
  // （mcs-qa 卡 t_e3735e8c 复现；本卡 t_1e297c55 修）。
  // 反向约束：值没变（点进框里又离开、原样提交、改一下又改回来）绝不能标脏，
  // 所以先比较再赋值，只有真的不同才调用 markDirty()。
  //
  // 顺序铁律（卡 t_c4491bba 修）：**先改文档、再 markDirty(kind)**。
  //   commitUndo() 比的是「改完的文档快照」与「上一次记下的快照」；写成「先标脏、
  //   后赋值」时两份快照一模一样 → 这一步根本不入撤销栈（Ctrl+Z 只会说
  //   「没有可撤销的操作」），而且 UNDO.lastJson 停在旧值，这次改动会悄悄并进
  //   下一次撤销步 —— 用户按 Ctrl+Z 撤掉的是别的东西，BPM / 吸附却留在那儿。
  //   所以这里的比较值先算好，赋值放在 markDirty 之前。
  // 每一项都带上自己的 kind：不带参数会落到 'op'，撤销提示就变成含糊的「操作」。
  // ---------------------------------------------------------------------------
  $('selGrid').addEventListener('change', (e) => {
    const v = e.target.value;
    const cfg = STATE.doc.config;
    if (v === 'beat') {
      // 按拍：吸附步长由 BPM 算出。没设 BPM 时先给个合理默认，
      // 否则用户选了「按拍」却看不到任何变化。
      const changed = cfg.gridMode !== 'beat' || !(cfg.bpm > 0);
      cfg.gridMode = 'beat';
      if (!(cfg.bpm > 0)) {
        cfg.bpm = 120;
        $('inpBpm').value = 120;
      }
      if (changed) markDirty('grid');       // 改完文档再记 —— 见上面的「顺序铁律」
      $('chkBeats').checked = true;
      status(`网格改为「按拍」：${STATE.doc.config.bpm} BPM（一拍 ${Math.round(60000 / STATE.doc.config.bpm)}ms）`,
             '拖动时会吸附到拍点上');
    } else {
      const ms = Number(v);
      const changed = cfg.gridMode !== 'ms' || cfg.gridMs !== ms;   // 先算再改：比较值必须在赋值前取好
      cfg.gridMode = 'ms';
      cfg.gridMs = ms;
      if (changed) markDirty('grid');       // ← 卡 t_c4491bba：这一支原来是「先标脏、后赋值」，等于白按
    }
    renderTimeline();
  });
  $('chkSnap').addEventListener('change', (e) => {
    const v = !!e.target.checked;
    const changed = STATE.doc.config.snapToGrid !== v;   // 比较值必须在赋值前取好
    STATE.doc.config.snapToGrid = v;
    if (changed) markDirty('snap');        // ← 卡 t_c4491bba：原来是「先标脏、后赋值」
    renderTimeline();
  });
  $('inpBpm').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    const changed = v !== STATE.doc.config.bpm;         // 比较值必须在赋值前取好
    STATE.doc.config.bpm = v;
    if (changed) markDirty('bpm');         // ← 卡 t_c4491bba：原来是「先标脏、后赋值」
    renderTimeline();
    const bpm = STATE.doc.config.bpm;
    if (bpm > 0) {
      status(`BPM = ${bpm}（一拍 ${Math.round(60000 / bpm)}ms，一小节 ${Math.round(60000 / bpm * 4)}ms）`,
             STATE.doc.config.gridMode === 'beat' ? '吸附已按拍对齐' : '拍线已显示');
    } else {
      status('BPM = 0（不显示拍线）', '填入 BPM 后会自动画出拍线和小节线');
    }
  });
  $('chkBeats').addEventListener('change', renderTimeline);
  $('inpTotalMs').addEventListener('change', (e) => {
    // 总长的唯一写入口：吸附网格 + 下限（最后一段音效的结束时间）+ 状态栏说法。
    // 以前这里直接 `totalMs = max(200, value)`，于是能把总长缩到最后一段音效前面，
    // 那一段就再也播不到（卡 t_6b99a1fd 修）。
    const r = setTotalMs(e.target.value, { source: 'input' });
    if (r.clamped) {
      status(`总长不能短于 ${(r.floor / 1000).toFixed(3)}s（最后一段音效的结束时间）`,
        `已停在 ${(r.value / 1000).toFixed(3)}s；想更短就先把它前面的音效挪走或缩短`);
    } else {
      status(`${fmtMs(r.value)} = ${(r.value / 1000).toFixed(3)}s`,
        r.changed ? '总长已更新（播放 / 时间显示都按它走）' : '数值没变');
    }
  });

  // 导出按钮
  document.querySelectorAll('.exp-btn').forEach((b) => {
    b.addEventListener('click', () => doExport(b.dataset.exp));
  });
  const bindProjectNameInput = (id, mirrorId) => $(id).addEventListener('input', (e) => {
    const v = e.target.value;
    $(mirrorId).value = v;
    if (v === STATE.doc.name) return;   // 值没变（点进去又离开 / 输入法空操作）不标脏
    STATE.doc.name = v;
    markDirty('name');                  // 与 setDocName 同一个 kind：撤销时说的是「修改工程名」
    updateWindowTitle();                // markDirty 在已经脏时会提前返回，所以这里再刷一次标题
  });
  bindProjectNameInput('eName', 'inpProjectName');
  bindProjectNameInput('inpProjectName', 'eName');

  // tabs
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab-body').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('tab-' + t.dataset.tab).classList.add('active');
    });
  });

  // 弹窗
  $('btnCloseModal').addEventListener('click', closeModal);
  $('btnCopyModal').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(modalContent);
      status('已复制到剪贴板');
    } catch (e) { status('复制失败：' + e.message); }
  });
  $('btnSaveModal').addEventListener('click', async () => {
    const r = await window.mcs.saveFile({ defaultName: modalName, content: modalContent });
    if (r.ok) status('已保存：' + r.path);
  });
  $('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });

  $('btnRevalidate').addEventListener('click', revalidate);


  // ---- 预览区：模型 ↔ GIF/视频 切换 ----
  const btnVS = $('btnVisualSwitch');
  if (btnVS) btnVS.addEventListener('click', () => {
    const mode = switchVisualTarget();
    if (mode === 'model') status('已切到模型预览（按播放头套用动画姿态）', '点「看 GIF」可切回');
    else if (mode) status('已切回 ' + (mode === 'gif' ? 'GIF' : (mode === 'video' ? '视频' : '图片')) + ' 预览', '模型预览还在，随时可切回');
  });
  const btnRemoveMedia = $('btnRemoveMedia');
  if (btnRemoveMedia) btnRemoveMedia.addEventListener('click', () => removeVisualAsset('media'));
  const btnRemoveModel = $('btnRemoveModel');
  if (btnRemoveModel) btnRemoveModel.addEventListener('click', () => removeVisualAsset('model'));
}

// ---------------------------------------------------------------------------
// 全局拖拽（文件从系统拖入）
// ---------------------------------------------------------------------------
function setupGlobalDrop() {
  const overlay = $('dropOverlay');
  let depth = 0;

  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer.types.includes('application/x-mcs-sound')) return;
    depth++;
    overlay.style.display = 'flex';
  });
  window.addEventListener('dragleave', () => {
    depth--;
    if (depth <= 0) { depth = 0; overlay.style.display = 'none'; }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.style.display = 'none';
    if (e.dataTransfer.types.includes('application/x-mcs-sound')) return;

    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;

    for (const f of files) {
      const p = f.path;
      if (!p) continue;
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.bbmodel')) {
        await importBBModel(p);
      } else if (lower.endsWith('.animation.json') || (lower.endsWith('.json') && /anim/i.test(lower))) {
        await importAnimation(p);
      } else if (['.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp',
                  '.mp4', '.webm', '.mov', '.m4v', '.ogv'].some((x) => lower.endsWith(x))) {
        await importGif(p);
      } else if (['.ogg', '.wav', '.mp3', '.flac', '.m4a'].some((x) => lower.endsWith(x))) {
        addToLibrary([{
          name: f.name.replace(/\.[^.]+$/, ''),
          relPath: f.name,
          absPath: p,
          ext: '.' + f.name.split('.').pop().toLowerCase(),
          size: f.size,
        }]);
        status('已添加音频：' + f.name);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function boot() {
  // 模型/动画进预览画布：先把宿主回调交给 model-preview（卡 t_fa17801d）
  MCS_MODELPREVIEW.init({
    canvasEl: () => $('previewCanvas'),
    stageEl: () => $('previewStage'),
    state: () => STATE,
    readBinaryFile: (p) => window.mcs.readBinaryFile(p),
    audioPlaying: () => AudioEngine.isPlaying(),
    clockMs: () => visualClockMs(),
    // 视角的唯一来源（卡 t_c54d031b）：model-preview 每次渲染都来问一次，
    // 两个页面共用这一份 —— 不会出现「调整页一个角度、音效页另一个角度」。
    view: () => rendererView(),
    setMetaText: (t) => {
      const el = $('metaVisual');
      if (el && el.textContent !== t) el.textContent = t;
    },
  });
  loadFavorites();
  setupTopbar();
  setupTransport();
  setupTimelineDrop();
  setupClipInteraction();
  setupLaneContextMenu();
  setupTrackButtons();
  setupGlobalDrop();
  setupPreviewResizer();
  bindProps();
  updateWindowTitle();
  updateZoomFitHint();

  // 主进程在关窗确认里选「返回保存」时，会发 request-save 过来。
  // 直接触发保存（等同点「导出全部」），用户不用再找按钮。
  try {
    if (window.mcs && window.mcs.onRequestSave) {
      window.mcs.onRequestSave(() => {
        status('已返回编辑器 —— 正在保存…', '如需另存为其它位置，请用「导出全部」');
        doExportAll();
      });
    }
  } catch (e) { /* 忽略 */ }

  // 中文输入法组字（拼音还没上屏）期间按 Ctrl+S / Ctrl+Shift+S：
  // 渲染进程的 keydown 只收到 key='Process'，看不出按的是 's' —— 由主进程在
  // before-input-event 里接住并转发过来（见 src/main/main.js 的
  // attachSaveShortcutBridge）。走同一个 performSaveShortcut，语义完全一致。
  try {
    if (window.mcs && window.mcs.onSaveShortcut) {
      window.mcs.onSaveShortcut((payload) => {
        performSaveShortcut(!!(payload && payload.saveAs));
      });
    }
  } catch (e) { /* 忽略 */ }
  // 启动时同步一次未保存状态
  syncDirtyToMain();

  $('inpTotalMs').value = STATE.doc.config.totalMs;
  syncDocInputsFromDoc();

  renderTimeline();
  renderProps();
  revalidate();
  renderLibrary();

  status('就绪 — 点左侧「原版库」加载约 1000+ 个原版音效事件（具体数量以这次实际加载为准），或直接把 GIF / 音频拖进来');
  // 冷启动先展示工程列表；编辑器只在新建或成功打开工程后出现。
  MCS_OVERVIEW.open(overviewApi());
}

// ---------------------------------------------------------------------------
// 测试钩子（仅用于自动化验证，不影响正常使用）
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 本卡（t_fa17801d）的自动化观测钩子：
//   __MCS_VISUAL__     预览画布现在显示什么（模式 / 模型统计 / 像素指纹 / 元信息）
//   __MCS_OVERVIEW__   工程总览的状态（条目、卡片数、工程库目录）
//   __MCS_LOAD_PROJECT__ / __MCS_SAVE_TO_LIBRARY__ / __MCS_OPEN_OVERVIEW__ / __MCS_VISUAL_SWITCH__
// 验收脚本一律用它们取值，不靠人眼看截图。
// ---------------------------------------------------------------------------
window.__MCS_VISUAL__ = () => {
  const canvas = document.getElementById('previewCanvas');
  const sn = (window.MCS_MODELPREVIEW && MCS_MODELPREVIEW.snapshot) ? MCS_MODELPREVIEW.snapshot() : {};
  return Object.assign(sn, {
    mode: STATE.visualMode,
    fps: null,
    stage: {
      canvas: !!(canvas && canvas.style.display !== 'none'),
      video: !!(document.getElementById('previewVideo') && document.getElementById('previewVideo').style.display !== 'none'),
      img: !!(document.getElementById('previewGif') && document.getElementById('previewGif').style.display !== 'none'),
      empty: !!(document.getElementById('previewEmpty') && document.getElementById('previewEmpty').style.display !== 'none'),
    },
    metaVisual: document.getElementById('metaVisual') ? document.getElementById('metaVisual').textContent : null,
    switchButton: (function () {
      const b = document.getElementById('btnVisualSwitch');
      return b ? { visible: b.style.display !== 'none', label: b.textContent, target: b.dataset.target || null } : null;
    })(),
    gif: {
      hasPlayer: !!STATE.gifPlayer,
      frames: STATE.gifAnim ? STATE.gifAnim.frameCount : 0,
      canvasW: canvas ? canvas.width : 0,
      canvasH: canvas ? canvas.height : 0,
    },
    pixels: (window.MCS_MODELVIEW && canvas) ? MCS_MODELVIEW.canvasStats(canvas) : null,
  });
};
window.__MCS_OVERVIEW__ = () => (window.MCS_OVERVIEW && MCS_OVERVIEW.dump ? MCS_OVERVIEW.dump() : null);
window.__MCS_OPEN_OVERVIEW__ = async () => {
  await MCS_OVERVIEW.open(overviewApi());
  return window.__MCS_OVERVIEW__();
};
window.__MCS_CLOSE_OVERVIEW__ = () => { MCS_OVERVIEW.close(); return window.__MCS_OVERVIEW__(); };
window.__MCS_LOAD_PROJECT__ = async (p) => {
  const fr = await window.mcs.readTextFile(p);
  if (!fr.ok) return { ok: false, error: fr.error };
  return openProjectFromText(fr.content, p, { source: '测试' });
};
window.__MCS_SAVE_TO_LIBRARY__ = () => saveProjectToLibrary();
// 导出系统信息（卡 t_20c2e144）：真正点按钮那条路 = 走「另存为」对话框；
// 只想看文本内容时用 collect 那条（不弹框、不写盘）。
window.__MCS_EXPORT_SYSINFO__ = () => exportSystemInfo();
window.__MCS_SYSINFO_PAYLOAD__ = () => sysInfoPayload();
window.__MCS_VISUAL_SWITCH__ = () => switchVisualTarget();
window.__MCS_REMOVE_VISUAL__ = (slot) => removeVisualAsset(slot || 'media', false);
window.__MCS_IMPORT__ = {
  model: (p) => importBBModel(p),
  animation: (p) => importAnimation(p),
  media: (p) => importGif(p),
};
window.__MCS_SET_PLAYHEAD__ = (ms) => {
  STATE.playheadMs = Math.max(0, Math.min(Number(ms) || 0, totalMs()));
  updatePlayhead(STATE.playheadMs);
  syncVisualTo(STATE.playheadMs);
  return STATE.playheadMs;
};

window.__MCS_DEBUG__ = () => ({
  libTotal: STATE.library.length,
  libEvents: STATE.library.filter((x) => x.kind === 'event').length,
  libFiles: STATE.library.filter((x) => x.kind !== 'event').length,
  clips: STATE.doc.clips.length,
  issues: STATE.issues.length,
  exportable: STATE.doc.clips.filter((c) => c.soundId || c.soundPath).length,
});

window.__MCS_ADD_EVENT__ = async (info, startMs, trackName) => {
  // 事件片段：从库里拿第一个变体探测真实时长，避免片段长度都是占位 500ms
  let dur = 500;
  try {
    const v = window.MCS_EVENTS.pickVariant(info.event, 0);
    if (v && v.absPath) {
      const d = await AudioEngine.probeDuration(v.absPath);
      if (d) dur = d;
    }
  } catch (e) { /* 用默认时长 */ }

  const clip = makeClip({
    label: info.event,
    soundId: info.event,
    soundPath: '',
    kind: 'event',
    category: info.category || '',
    variantCount: info.variantCount || 1,
    startMs: startMs,
    durationMs: dur,
    srcDurMs: dur,   // 源音频自然长度：非破坏性裁剪「最远能拖回哪儿」的边界（卡 t_47b9fab2）
    track: trackName || STATE.doc.tracks[0].name,
  });
  STATE.doc.clips.push(clip);
  setSelection([clip.id], clip.id);
  markDirty('add');            // 卡 t_c4491bba：带 kind（测试钩子：加一个原版事件片段）
  renderTimeline();
  renderProps();
  revalidate();
  return clip.id;
};

window.__MCS_EXPORT__ = () => ({
  md: exportMarkdown(STATE.doc, STATE.library),
  py: exportModSDKPython(STATE.doc, STATE.library),
  defs: exportSoundDefinitions(STATE.doc, STATE.library),
});

// 返回当前片段（已按轨道静音/独奏计算好 muted）
window.__MCS_GET_CLIPS__ = () => STATE.doc.clips.map((c) => {
  const t = STATE.doc.tracks.find((x) => x.name === c.track);
  const anySolo = STATE.doc.tracks.some((x) => x.solo);
  return Object.assign({}, c, { muted: t && (t.muted || (anySolo && !t.solo)) });
});

window.__MCS_IMPORT_GIF__ = (p) => importGif(p);
window.__MCS_STATE__ = () => STATE;

// ---------------------------------------------------------------------------
// 卡 t_c54d031b 的观测钩子：步骤页 / 视角 / 素材槽
//   __MCS_STEP__       当前在哪个步骤页、按钮选中态、右栏换了没有、画布用的角度
//   __MCS_SLOTS__      两个素材槽的文案与按钮显隐（QA 直接读真实 DOM）
//   __MCS_SET_STEP__   切页（等价于点步骤条上的按钮）
//   __MCS_SET_VIEW__   直接改视角（等价于拖动 / 改数字框），进撤销栈
//   __MCS_RESET_VIEW__ 点「重置角度」的执行体
// ---------------------------------------------------------------------------
window.__MCS_STEP__ = () => {
  const btn = (id) => {
    const b = document.getElementById(id);
    return b ? { text: b.textContent.trim(), active: b.classList.contains('active'), shown: b.style.display !== 'none' } : null;
  };
  const tabs = document.querySelector('#rightPanel .tabs');
  const adj = document.getElementById('adjustPanel');
  const v = currentView();
  return {
    step: STATE.step,
    page: document.body ? document.body.dataset.page : null,
    btnAdjust: btn('btnStepAdjust'),
    btnSound: btn('btnStepSound'),
    btnGoAdjust: btn('btnGoAdjust'),
    adjustPanelShown: !!(adj && adj.offsetParent !== null),
    tabsShown: !!(tabs && tabs.offsetParent !== null),
    emptyText: (document.getElementById('previewEmpty') || {}).textContent || null,
    view: { x: v.x, y: v.y, z: v.z, zoom: v.zoom, panX: v.panX, panY: v.panY, animMode: v.animMode, animName: v.animName, playMode: v.playMode },
    fields: {
      x: ($('inpAngleX') || {}).value, y: ($('inpAngleY') || {}).value, z: ($('inpAngleZ') || {}).value,
      zoom: ($('rngAngleZoom') || {}).value, zoomText: ($('angleZoomVal') || {}).textContent,
    },
    renderedView: (window.MCS_MODELPREVIEW && MCS_MODELPREVIEW.snapshot) ? MCS_MODELPREVIEW.snapshot().view : null,
    docVisual: JSON.parse(JSON.stringify(STATE.doc.visual || {})),
  };
};
window.__MCS_SLOTS__ = () => {
  const slot = (nameId, subId, btnId) => {
    const n = document.getElementById(nameId), s = document.getElementById(subId), b = document.getElementById(btnId);
    return {
      name: n ? n.textContent : null, sub: s ? s.textContent : null,
      btnShown: !!(b && b.style.display !== 'none'), btnLabel: b ? b.textContent.trim() : null,
    };
  };
  const imp = document.getElementById('btnSlotImportMedia');
  return {
    model: slot('slotModelName', 'slotModelSub', 'btnSlotRemoveModel'),
    media: slot('slotMediaName', 'slotMediaSub', 'btnSlotRemoveMedia'),
    mediaImportLabel: imp ? imp.textContent.trim() : null,
  };
};
window.__MCS_SET_STEP__ = (s) => setStep(s);
window.__MCS_SET_VIEW__ = (patch) => { const v = applyView(patch || {}); markDirty('view'); return v; };
window.__MCS_RESET_VIEW__ = () => resetView(false);

// ---------------------------------------------------------------------------
// 卡 t_96cd9241 的观测钩子：动画两档 / 列表 / 选中 / 播放方式 / 空状态
//   __MCS_ANIM__        当前档、当前档列表（含表达式逐处说明）、选中项、画布实际在播的动画
//   __MCS_ANIM_TIER__   换档（等价于点「关键帧动画」/「Molang 语言动画」）
//   __MCS_ANIM_SELECT__ 选中一条（等价于点列表里那一行），key = `来源:名字`
//   __MCS_ANIM_PLAY__   切播放方式（跟随播放头 / 独立预览）
// ---------------------------------------------------------------------------
window.__MCS_ANIM__ = () => {
  const view = currentView();
  const sel = MCS_MODELPREVIEW.selectedEntry ? MCS_MODELPREVIEW.selectedEntry() : null;
  const row = (e) => ({
    key: animKey(e), name: e.name, source: e.source, tier: animTierOf(e),
    lengthMs: e.lengthMs || 0,
    boneCount: (e.stats && e.stats.boneCount) || 0,
    keyCount: (e.stats && e.stats.keyCount) || 0,
    timeCount: (e.stats && e.stats.timeCount) || 0,
    exprCount: (e.stats && e.stats.exprCount) || 0,
    otherCount: (e.stats && e.stats.otherCount) || 0,
    expressions: (e.expressions || []).map((x) => MCS_PARSERS.expressionNote(x)),
  });
  const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
  const shown = (id) => { const el = document.getElementById(id); return !!el && el.style.display !== 'none'; };
  const btn = (id) => {
    const b = document.getElementById(id);
    return b ? { text: b.textContent.trim(), active: b.classList.contains('active'), aria: b.getAttribute('aria-selected') } : null;
  };
  const catalog = MCS_MODELPREVIEW.catalog || [];
  return {
    tier: view.animMode,
    playMode: view.playMode,
    btnKey: btn('btnAnimModeKey'),
    btnMolang: btn('btnAnimModeMolang'),
    btnFollow: btn('btnPlayModeFollow'),
    btnStandalone: btn('btnPlayModeStandalone'),
    hint: txt('animModeHint'),
    countText: txt('animCountHint'),
    playHint: txt('adjustPlayModeHint'),
    list: animListFor(view.animMode).map(row),
    allTiers: catalog.map((e) => ({ key: animKey(e), tier: animTierOf(e), exprCount: (e.stats && e.stats.exprCount) || 0 })),
    selected: sel ? row(sel) : null,
    canvas: {
      animName: (window.MCS_MODELPREVIEW && MCS_MODELPREVIEW.snapshot) ? MCS_MODELPREVIEW.snapshot().animName : null,
      animSource: MCS_MODELPREVIEW.snapshot ? MCS_MODELPREVIEW.snapshot().animSource : null,
      animLengthMs: MCS_MODELPREVIEW.snapshot ? MCS_MODELPREVIEW.snapshot().animLengthMs : 0,
      posedBones: MCS_MODELPREVIEW.snapshot ? MCS_MODELPREVIEW.snapshot().posedBones : [],
    },
    rowsDom: Array.from(document.querySelectorAll('#animList .anim-row')).map((el) => ({
      key: el.dataset.animKey, text: el.textContent, selected: el.classList.contains('selected'), aria: el.getAttribute('aria-selected'),
    })),
    empty: txt('animEmpty'), emptyShown: shown('animEmpty'),
    support: txt('animSupport'), supportShown: shown('animSupport'),
    docVisual: JSON.parse(JSON.stringify(STATE.doc.visual || {})),
    playheadMs: Math.round(STATE.playheadMs || 0),
    transport: STATE.transport,
  };
};
window.__MCS_ANIM_TIER__ = (t) => { setAnimTier(t); return window.__MCS_ANIM__(); };
window.__MCS_ANIM_SELECT__ = (key) => { selectAnimByKey(key); return window.__MCS_ANIM__(); };
window.__MCS_ANIM_PLAY__ = (m) => { setPlayMode(m); return window.__MCS_ANIM__(); };

// 多选与复制粘贴的自动化观测钩子（给 QA / 右键菜单卡复用）
window.__MCS_SELECTION__ = () => ({
  ids: Array.from(STATE.selectedClipIds),
  primary: STATE.selectedClipId,
  domSelected: Array.from(document.querySelectorAll('.clip.selected')).map((e) => e.dataset.clipId),
  domPrimary: (function () { const e = document.querySelector('.clip.selected.primary'); return e ? e.dataset.clipId : null; })(),
  selBoxVisible: (function () { const b = $('selBox'); return !!b && b.style.display === 'block'; })(),
  clipboard: CLIPBOARD ? CLIPBOARD.items.length : 0,
  status: $('statusMsg').textContent,
});
window.__MCS_EDIT__ = {
  copy: () => copySelection(),
  paste: () => pasteAtPlayhead(),
  del: () => deleteSelection(),
  all: () => selectAllClips(),
  duplicate: () => duplicateSelection(),
  clear: () => { clearSelection(); renderTimeline(); renderProps(); },
  // 右键菜单里的片段级动作（自动化测试直接调用同一套实现）
  split: () => splitSelectionAtPlayhead(),
  align: () => alignSelectionToGrid(),
  lock: () => toggleLockSelection(true),
  unlock: () => toggleLockSelection(false),
  undoDelete: () => restoreLastDelete(),
  moveTrack: (dir) => moveSelectionByTrack(dir < 0 ? -1 : 1),
  menu: (act) => menuAction(act),
};

/** 右键菜单快照（自动化观测用）：可见性 / 位置 / 菜单项与置灰状态 */
window.__MCS_MENU__ = () => {
  const m = document.getElementById('clipMenu');
  const items = m ? Array.from(m.querySelectorAll('.ctx-item')).map((b) => ({
    act: b.dataset.act,
    label: b.querySelector('span') ? b.querySelector('span').textContent : '',
    key: b.querySelector('.ctx-key') ? b.querySelector('.ctx-key').textContent : '',
    disabled: !!b.disabled,
    hint: b.getAttribute('title') || '',
    rect: (function () {
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })(),
  })) : [];
  const r = m ? m.getBoundingClientRect() : null;
  return {
    visible: !!m && m.style.display === 'block',
    rect: r ? { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right),
                bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) } : null,
    anchor: m ? { x: Number(m.dataset.anchorX || 0), y: Number(m.dataset.anchorY || 0) } : null,
    items,
    order: items.map((i) => i.act),
  };
};

// 完整调试接口（自动化测试用）
const DBG = window.__MCS_DEBUG__;
DBG.loadVanilla = async () => {
  $('btnLoadVanilla').click();
  await new Promise((r) => setTimeout(r, 1500));
  return STATE.library.length;
};
DBG.clips = () => STATE.doc.clips.map((c) => {
  const t = STATE.doc.tracks.find((x) => x.name === c.track);
  const anySolo = STATE.doc.tracks.some((x) => x.solo);
  return Object.assign({}, c, { muted: !!(t && (t.muted || (anySolo && !t.solo))) });
});
DBG.addEvent = (info, ms, track) => window.__MCS_ADD_EVENT__(info, ms, track);
DBG.importBBModel = (p) => importBBModel(p);
DBG.importAnimation = (p) => importAnimation(p);
DBG.resolveClip = (c) => resolveClipAudio(c);
DBG.selectClip = (id) => { setSelection([id], id); renderTimeline(); renderProps(); };
DBG.seekGif = (ms) => { STATE.playheadMs = ms; updatePlayhead(ms); syncVisualTo(ms); return ms; };
DBG.gif = () => {
  const c = $('previewCanvas');
  return {
    hasPlayer: !!STATE.gifPlayer,
    frameCount: STATE.gifAnim ? STATE.gifAnim.frameCount : 0,
    totalMs: STATE.gifAnim ? STATE.gifAnim.totalMs : 0,
    canvasVisible: !!(c && c.style.display !== 'none'),
    metaText: $('metaVisual').textContent,
  };
};
/**
 * 传输/同步状态快照。
 * 卡在"GIF 到底还动没动"这类问题上时，先看这个：
 *   transport 是否还笑着 playing、驱动定时器是否还活着、
 *   GIF 停在几毫秒、播放头又在几毫秒 —— 三个数一对就知道谁不对。
 */
DBG.transport = () => ({
  state: STATE.transport,
  transport: STATE.transport,          // 兼容：两个名字都返回
  audioPlaying: AudioEngine.isPlaying(),
  scrubbing: !!STATE.scrubbing,
  playheadMs: Math.round(STATE.playheadMs || 0),
  totalMs: Math.round(totalMs()),
  atEnd: STATE.playheadMs >= totalMs() - 1,   // 播放头是否停在末尾
  gifMs: STATE.gifPlayer ? Math.round(STATE.gifPlayer.getTime()) : null,
  gifDriverAlive: !!STATE.gifSyncTimer,
  videoDriverAlive: !!STATE.videoSyncTimer,
  visualOnlyClockAlive: !!visualOnlyRaf,
  btn: $('btnPlay').textContent,
  statusMsg: $('statusMsg').textContent,      // 状态栏原文（QA 用来核对"说的和实际一致"）
  statusRight: $('statusRight').textContent,
});
DBG.pressPlay = () => { $('btnPlay').click(); return DBG.transport(); };
DBG.pressStop = () => { $('btnStop').click(); return DBG.transport(); };
DBG.tracks = () => STATE.doc.tracks.map((t) => ({
  name: t.name, label: t.label, muted: !!t.muted, solo: !!t.solo,
}));
DBG.showAudioHelp = () => openAudioHelpModal();

// ---- 卡 t_6b99a1fd：总长 / 边界条 / 撤销栈的观测点（只读观测，不改行为）----
/** 总长相关的全部数字与几何：QA 用它核对「配置值 / 生效值 / 下限 / 抓手位置」是否同源 */
DBG.total = () => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const grip = document.getElementById('totalGrip');
  const edge = document.getElementById('totalEdge');
  const cfg = Math.round(STATE.doc.config.totalMs || 0);
  return {
    cfgTotal: cfg,
    effectiveTotal: Math.round(totalMs()),        // 播放 / 边界真正用的值
    floor: totalFloorMs(),                        // 下限 = 最后一段音效的结束时间
    clipsMaxEnd: clipsMaxEndMs(),
    minTotalMs: MIN_TOTAL_MS,
    raisedByFloor: Math.round(totalMs()) > cfg,   // 生效值是不是被下限顶上去的
    gripExists: !!grip,
    gripRect: rect(grip),
    gripLabel: grip ? grip.textContent : null,
    edgeRect: rect(edge),
    dragging: !!TOTAL_DRAG,
    totalTouched: !!STATE.totalTouched,
    inpTotalMs: $('inpTotalMs') ? $('inpTotalMs').value : null,
    timeDisplay: $('timeDisplay').textContent,
  };
};
/** 抓手中心的窗口坐标（自动化拖拽的落点；没有抓手时 null） */
DBG.gripPoint = () => {
  const g = document.getElementById('totalGrip');
  if (!g) return null;
  const r = g.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};
/** 撤销栈快照：能不能撤 / 能不能重做 / 栈里各步是什么动作 */
DBG.undoState = () => ({
  canUndo: canUndo(),
  canRedo: canRedo(),
  undoDepth: undoDepth(),
  redoDepth: redoDepth(),
  kinds: UNDO.past.map((e) => e.kind),
  redoKinds: UNDO.future.map((e) => e.kind),
  lastKind: UNDO.lastKind,
});
DBG.undo = () => undo();
DBG.redo = () => redo();
DBG.setTotal = (ms) => setTotalMs(ms, { source: 'input' });
// Help 的两条路都暴露出来，方便自动化分别验：
//   showHelp()              → 内置离线 HTML 教程窗口（正常路径）
//   showHelpFallback()      → 主进程开不出窗口时的兜底弹窗（「Help 不得为空」的底线）
DBG.showHelp = () => showHelp();
DBG.showHelpFallback = () => { openHelpModalFallback(); return $('modalBody').innerText.length; };
// 「导出系统信息」（卡 t_20c2e144）：
//   sysInfoPayload() 看渲染进程会交给主进程哪些实测值（库规模 / 首次加载耗时）
//   exportSysInfo()  走完整的「另存为」对话框那条路
DBG.sysInfoPayload = () => sysInfoPayload();
DBG.exportSysInfo = () => exportSystemInfo();

// 卡 t_6b99a1fd 的启动初始化：总长边界条的拖拽管道 + 撤销栈基准。
// 故意**不塞进 boot() 体内**：boot 是每张卡都会动的地方，并行开发时（本项目同工作区
// 同时跑 5 张卡）最容易被别人的整段覆盖吃掉 —— 本轮就被吃掉过一次，表现为
// 「边界条画得出来、却怎么拖都不动」（没有任何 mousemove 管道）。挂在 DOMContentLoaded 上
// 与 boot 平级，功能就不再依赖别人的改动。
window.addEventListener('DOMContentLoaded', () => {
  setupTotalBoundary();       // 抓手 / 边界线的拖拽管道（window 级监听，重绘不丢）
  undoReset();                // 撤销栈的基准 = 启动时这份文档（否则「第一处改动」撤不回去）
  // 卡 t_c54d031b：步骤条（① 模型/GIF 调整 ↔ ② 音效）与调整页的接线。
  // 同样挂在这里而不是 boot() 里 —— boot 是最容易被并行卡整段覆盖的地方。
  setupStepSwitch();
  // 卡 t_96cd9241：调整页「动画」一栏（两档列表 + 播放方式）的接线，同样挂这里
  setupAnimPanel();
});
/**
 * 片段几何快照（卡 t_47b9fab2）：条长 / 倍速 / 源内起止 / 淡入淡出 / 实际会响多久。
 * 一个对象看全 —— 开发自测与 QA 都用它核对，免得各自手算一套算错。
 */
DBG.clipGeom = (id) => {
  const c = id ? STATE.doc.clips.find((x) => x.id === id)
               : STATE.doc.clips.find((x) => x.id === STATE.selectedClipId);
  if (!c) return null;
  const el = document.querySelector('.clip[data-clip-id="' + c.id + '"]');
  return {
    id: c.id, label: c.label,
    startMs: c.startMs, durationMs: c.durationMs, pitch: rateOf(c),
    offsetMs: Math.max(0, c.offsetMs || 0),
    srcEndMs: c.srcEndMs != null ? c.srcEndMs : null,
    srcTotalMs: srcTotalMs(c),
    contentMs: Math.round(contentMs(c)),
    audibleMs: Math.round(audibleMs(c)),
    trimmed: isTrimmed(c),
    fadeInMs: c.fadeInMs || 0, fadeOutMs: c.fadeOutMs || 0,
    fadePreset: matchFadePreset(c),
    endMs: c.startMs + c.durationMs,
    domTrimBadge: !!(el && el.querySelector('.c-badge.trim')),
    domFadeIn: !!(el && el.querySelector('.c-fade.in')),
    domFadeOut: !!(el && el.querySelector('.c-fade.out')),
    domBadge: el && el.querySelector('.c-badge.fade') ? el.querySelector('.c-badge.fade').textContent : null,
  };
};

window.addEventListener('DOMContentLoaded', boot);

})();  // end IIFE — 避免污染全局作用域
