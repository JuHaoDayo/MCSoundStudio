/**
 * timeline.js — 时间轴数据模型
 *
 * 设计要点：
 *  - 所有时间内部统一用 **毫秒 (ms)** 存储，避免浮点秒的精度问题。
 *  - 导出时才换算到 tick / 秒。网格精度可配置（默认 50ms = 1 tick）。
 *  - 数据结构刻意保持扁平且可 JSON 序列化，方便「回存编辑器」。
 */

'use strict';

(function () {

/** 全局配置 */
const DEFAULT_CONFIG = {
  gridMs: 50,            // 固定网格精度，默认 1 tick
  gridMode: 'ms',        // 'ms' = 用固定毫秒网格；'beat' = 用 BPM 算出的一拍
  snapToGrid: true,      // 拖拽时是否吸附
  totalMs: 5000,         // 时间轴总长度
  bpm: 0,                // 拍速。0 = 未设置；配合 gridMode='beat' 或拍线开关使用
  beatsPerBar: 4,
};

/** 一条音效片段（clip） */
function makeClip(opts) {
  return {
    id: opts.id || ('clip_' + Math.random().toString(36).slice(2, 10)),
    // 音效来源
    soundId: opts.soundId || '',           // 游戏内事件名，如 'mob.zombie.say'
    soundPath: opts.soundPath || '',       // 本地文件路径（预览用）
    label: opts.label || opts.soundId || '未命名',
    // 'event' = 原版音效事件（导出写事件名，游戏自行随机选变体）
    // 'file'  = 普通音频文件（需注册成自定义音效）
    kind: opts.kind || 'file',
    category: opts.category || '',         // 原版事件的分类（block/neutral/...）
    variantCount: opts.variantCount || 1,  // 原版事件的变体数（仅提示用）

    // 时间（ms）
    startMs: opts.startMs != null ? opts.startMs : 0,
    // durationMs = 片段在**时间轴上占的长度**（条长），不等于素材长度：
    //   条长 = 素材长度 ÷ 播放倍速；拖右边缘改条长时倍速会等比跟着变。
    durationMs: opts.durationMs != null ? opts.durationMs : 500,
    // 源内入点（非破坏性裁剪的「头」）：从音频内部的哪一点开始播
    offsetMs: opts.offsetMs || 0,
    // 源内出点（非破坏性裁剪的「尾」）：播到音频内部的哪一点为止。
    // null = 一直播到源音频自然结尾（= 没裁尾）。裁剪过的东西**没有被销毁**，
    // 把边缘拖回去就能恢复（见 setTrimmedHead / setTrimmedTail）。
    srcEndMs: opts.srcEndMs != null ? opts.srcEndMs : null,
    // 源音频自然时长（添加时探测得到）。裁剪的「最多能拖回多远」要用它当边界；
    // 老工程里没有这个字段时，第一次裁剪会把当时的内容末端钉进来。
    srcDurMs: opts.srcDurMs != null ? opts.srcDurMs : null,

    // 参数
    volume: opts.volume != null ? opts.volume : 1.0,   // 0..1
    // pitch 既是音高也是**播放倍速**：MC 的 PlayCustomMusic(pitch) 与 Web Audio 的
    // playbackRate 都是「磁带式变速」（速度与音高一起变），所以这里只有一个旋钮，
    // 拖片段右边缘改条长时改的就是它。
    pitch: opts.pitch != null ? opts.pitch : 1.0,      // 0..256（中国版），安全区 0.5..2
    // 「循环播放」已在卡 t_6b5016ec 里整体移除：传进来的 loop / loopEndMs 一律忽略，
    // 片段只「播一次」。要重复播放 = 复制片段（右键「再复制一份」/ Ctrl+D）。

    // 效果：淡入 / 淡出（毫秒）。0 = 硬切。两者之和不得超过条长（normalizeFades 保证）。
    fadeInMs: opts.fadeInMs != null ? opts.fadeInMs : 0,
    fadeOutMs: opts.fadeOutMs != null ? opts.fadeOutMs : 0,
    // 最近一次套用的效果预设 id（仅用于界面回显）；手改淡入淡出后变 'custom'
    fadePreset: opts.fadePreset || 'none',

    // 变体
    variantMode: opts.variantMode || 'auto',   // 'auto' = 用整个事件（引擎随机）；'locked' = 锁定到某个变体
    lockedVariant: opts.lockedVariant || null,

    // 分组 / 分层
    track: opts.track || 'main',               // 轨道名，用于分层
    color: opts.color || null,

    // 锁定：防止在时间轴上误拖 / 误改长度（右键菜单「锁定片段」；导出不受影响）
    locked: !!opts.locked,

    // 备注
    note: opts.note || '',
  };
}

/** 一条轨道 */
function makeTrack(name, opts) {
  return {
    name,
    label: (opts && opts.label) || name,
    muted: false,
    solo: false,
    gain: 1.0,
  };
}

/** 时间轴文档 */
function makeDocument(opts) {
  const o = opts || {};
  return {
    version: 1,
    name: o.name || '未命名时序',
    config: Object.assign({}, DEFAULT_CONFIG, o.config || {}),
    tracks: o.tracks || [makeTrack('main', { label: '主轨' })],
    clips: o.clips || [],
    // 视觉参考
    visual: {
      kind: o.visualKind || 'none',   // 'none' | 'gif' | 'image' | 'anim'
      path: o.visualPath || null,     // gif / png 文件路径
      dataUrl: null,                  // 若为 gif，读取后的 dataUrl
      // 若视觉参考是 .animation.json，记录动画名与时长
      animFile: null,
      animName: null,
      naturalMs: null,                // 素材（gif/动画）的自然总时长
      manualMs: null,                 // 用户手动校正的总时长（优先）
    },
  };
}

// ---------------------------------------------------------------------------
// 网格 / BPM
// ---------------------------------------------------------------------------

/** 把毫秒吸附到网格 */
function snapMs(ms, config) {
  if (!config.snapToGrid) return Math.round(ms);
  const g = effectiveGridMs(config);
  return Math.round(ms / g) * g;
}

/**
 * 当前实际吸附步长。
 * 网格选「按拍」时用 BPM 算出来的一拍时长，否则用固定毫秒值。
 */
function effectiveGridMs(config) {
  if (config.gridMode === 'beat') {
    if (config.bpm > 0) return 60000 / config.bpm;
    return config.gridMs || 50;   // 没设 BPM 就退回固定网格
  }
  return config.gridMs || 50;
}

/** 由 BPM 计算一小节的毫秒数 */
function barMs(config) {
  if (!config.bpm || config.bpm <= 0) return null;
  const beatMs = 60000 / config.bpm;
  return beatMs * (config.beatsPerBar || 4);
}

/** 毫秒 -> tick（50ms 一格） */
function msToTick(ms) {
  return Math.round(ms / 50);
}

/** 毫秒 -> 秒（保留 4 位小数，和 Blockbench 写法一致） */
function msToSec(ms) {
  return Math.round((ms / 1000) * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// 片段几何：条长 ↔ 播放倍速 / 非破坏性裁剪 / 淡入淡出
//
// 三条铁律（本文件的 helper 和 audio.js 的播放器必须用同一套）：
//   1. 条长（durationMs）× 倍速（pitch）= 素材实际会被播放的长度（contentMs）。
//      「拖右边缘改条长」= 等比改倍速，等式永远成立（除非倍速撞到 0.25~4 的钳制）。
//   2. 素材只有 [offsetMs, srcOutMs] 这一段会被播；条长比它长就静音、比它短就
//      在条尾切断 —— **声音绝不越过片段条**。
//   3. 裁剪是非破坏性的：只改 offsetMs / srcEndMs 这两个「源内起止」，
//      文件本身不动，边缘拖回去就能恢复。
// ---------------------------------------------------------------------------

const MIN_DURATION_MS = 30;     // 片段最小条长（和拖动时的钳制一致）
const MIN_RATE = 0.25;          // 倍速下限（与 sound_definitions 导出的钳制一致）
const MAX_RATE = 4.0;           // 倍速上限

/** 播放倍速 = pitch（磁带式变速：速度和音高一起变） */
function rateOf(c) {
  const v = c && c.pitch != null ? Number(c.pitch) : 1;
  return (Number.isFinite(v) && v > 0) ? v : 1;
}

/**
 * 源音频的自然时长（裁剪时「最远能拖回哪儿」的边界）。
 * 老工程 / 探测失败的片段没有 srcDurMs，就退回「当前内容末端」——
 * 这样至少不会凭空变长；第一次真裁剪时 setTrimmedTail 会把它钉住。
 */
function srcTotalMs(c) {
  const known = c && c.srcDurMs != null ? Number(c.srcDurMs) : NaN;
  if (Number.isFinite(known) && known > 0) return Math.round(known);
  return Math.max(1, Math.round((c.offsetMs || 0) + (c.durationMs || 0) * rateOf(c)));
}

/** 源内出点（真实值，永远落在 [入点, 源总长] 之间；null 视作到自然结尾） */
function srcOutMs(c) {
  const total = srcTotalMs(c);
  const inMs = Math.max(0, c.offsetMs || 0);
  const raw = c && c.srcEndMs != null ? Number(c.srcEndMs) : total;
  const v = Number.isFinite(raw) ? raw : total;
  return Math.max(inMs, Math.min(v, total));
}

/** 这个片段实际会用到的素材长度（倍速 1.0 下的毫秒数） */
function contentMs(c) {
  return Math.max(0, srcOutMs(c) - Math.max(0, c.offsetMs || 0));
}

/** 被裁过吗（起或止任一被裁） */
function isTrimmed(c) {
  return (c && c.offsetMs || 0) > 0 || (c && c.srcEndMs != null);
}

/**
 * 从条起点算起，声音**最晚**在条内多少毫秒处结束 —— 播放器靠它切断声音。
 * 正常情况就等于条长；素材不够长时会小于条长（后半段静音）。
 */
function audibleMs(c) {
  const rate = rateOf(c);
  return Math.max(0, Math.min(c.durationMs || 0, contentMs(c) / rate));
}

/**
 * 拖右边缘改条长 = 等比改倍速（卡 t_47b9fab2 第 1 条）。
 * 素材长度不变，条长变成 newDur 时倍速 = 原倍速 × 原条长 ÷ 新条长。
 * 倍速会被钳到 [0.25, 4]：撞上限时等式不再成立（声音会提前播完或在条尾被切断），
 * 返回的 clamped 让调用方能如实告诉用户。
 */
function setStretchedDuration(c, newDur) {
  if (!c) return null;
  const oldDur = Math.max(1, c.durationMs || 1);
  const oldRate = rateOf(c);
  const dur = Math.max(MIN_DURATION_MS, Math.round(newDur));
  const want = oldRate * oldDur / dur;
  const rate = Math.max(MIN_RATE, Math.min(MAX_RATE, want));
  c.durationMs = dur;
  c.pitch = Math.round(rate * 1000) / 1000;
  return { dur, rate: c.pitch, want: Math.round(want * 1000) / 1000, clamped: Math.abs(want - rate) > 1e-6 };
}

/**
 * Alt + 右边缘：非破坏性裁剪**尾部**。起点不动、倍速不动，只把「源内出点」往里推。
 * 往右拖回去 = 恢复被裁掉的素材（最远到源音频自然结尾）。
 * @returns {{dur:number, out:number|null, hitEnd:boolean}}
 */
function setTrimmedTail(c, newDur) {
  if (!c) return null;
  const rate = rateOf(c);
  const total = srcTotalMs(c);
  // 老工程没有源总长：把「当前内容末端」钉成边界，之后拖回才不会凭空变长
  if (c.srcDurMs == null) c.srcDurMs = total;
  const inMs = Math.max(0, c.offsetMs || 0);
  const maxDur = Math.max(MIN_DURATION_MS, (total - inMs) / rate);
  const want = Math.round(newDur);
  const dur = Math.max(MIN_DURATION_MS, Math.min(want, Math.round(maxDur)));
  const out = inMs + dur * rate;
  c.durationMs = dur;
  // 拉到自然结尾就把「裁尾」标记清掉：文档里不留一条等于全长的假裁剪
  c.srcEndMs = (out >= total - 0.5) ? null : Math.round(out);
  return { dur, out: c.srcEndMs, hitEnd: want > maxDur + 0.5 };
}

/**
 * Alt + 左边缘：非破坏性裁剪**头部**。条尾不动、倍速不动，起点与「源内入点」一起往右走。
 * 往左拖回去 = 恢复被裁掉的头（最远到源音频开头 offsetMs=0、条起点 0）。
 * @param deltaMs 正数 = 往右裁，负数 = 往左恢复
 */
function setTrimmedHead(c, deltaMs) {
  if (!c) return null;
  const rate = rateOf(c);
  const inMs = Math.max(0, c.offsetMs || 0);
  const start = Math.max(0, c.startMs || 0);
  const end = start + Math.max(1, c.durationMs || 1);
  const minDelta = -Math.round(inMs / rate);                    // 最多恢复到源开头
  const maxDelta = Math.round((c.durationMs || 1) - MIN_DURATION_MS);  // 条长不能裁到 0
  const want = Math.round(deltaMs || 0);
  const d = Math.max(minDelta, Math.min(maxDelta, want));
  const newStart = Math.max(0, Math.round(start + d));
  const actual = newStart - start;                              // 被 0 钳住时的真实位移
  c.startMs = newStart;
  c.offsetMs = Math.max(0, Math.round(inMs + actual * rate));
  c.durationMs = Math.max(MIN_DURATION_MS, Math.round(end - newStart));
  return { delta: actual, offsetMs: c.offsetMs, hitStart: want < minDelta - 0.5, hitMin: want > maxDelta + 0.5 };
}

/** 淡入 + 淡出不得超过条长（否则两段斜坡会互相吃掉）；返回钳制后的值 */
function normalizeFades(c) {
  if (!c) return null;
  const dur = Math.max(1, c.durationMs || 1);
  let fin = Math.max(0, Math.round(Number(c.fadeInMs) || 0));
  let fout = Math.max(0, Math.round(Number(c.fadeOutMs) || 0));
  fin = Math.min(fin, dur);
  fout = Math.min(fout, Math.max(0, dur - fin));
  c.fadeInMs = fin;
  c.fadeOutMs = fout;
  return { inMs: fin, outMs: fout };
}

/**
 * 效果预设：可见可选的「一档」淡入淡出。
 * 比例按条长算，所以同一个预设套在 200ms 和 2s 的片段上都合理。
 * fixedIn/fixedOut = 固定毫秒（给「去爆音」这种与长度无关的短淡用）。
 */
const FADE_PRESETS = [
  { id: 'none', label: '无（硬切）', inPct: 0, outPct: 0 },
  { id: 'fadeIn', label: '淡入', inPct: 0.15, outPct: 0 },
  { id: 'fadeOut', label: '淡出', inPct: 0, outPct: 0.15 },
  { id: 'fadeBoth', label: '淡入 + 淡出', inPct: 0.15, outPct: 0.15 },
  { id: 'soft', label: '软起软落（长淡）', inPct: 0.3, outPct: 0.3 },
  { id: 'clickFree', label: '极短淡（去爆音）', fixedIn: 10, fixedOut: 20 },
];
function fadePresetById(id) { return FADE_PRESETS.find((p) => p.id === id) || FADE_PRESETS[0]; }

/** 套用效果预设（写 fadeInMs / fadeOutMs） */
function applyFadePreset(c, id) {
  if (!c) return null;
  const p = fadePresetById(id);
  const dur = Math.max(1, c.durationMs || 1);
  c.fadeInMs = p.fixedIn != null ? p.fixedIn : Math.round(dur * (p.inPct || 0));
  c.fadeOutMs = p.fixedOut != null ? p.fixedOut : Math.round(dur * (p.outPct || 0));
  c.fadePreset = p.id;
  normalizeFades(c);
  return { id: p.id, label: p.label, inMs: c.fadeInMs, outMs: c.fadeOutMs };
}

/** 当前片段匹配哪个预设（界面上用来回显下拉框；都不匹配 = 'custom'） */
function matchFadePreset(c) {
  if (!c) return 'none';
  const dur = Math.max(1, c.durationMs || 1);
  const fin = Math.max(0, Math.round(Number(c.fadeInMs) || 0));
  const fout = Math.max(0, Math.round(Number(c.fadeOutMs) || 0));
  for (const p of FADE_PRESETS) {
    const want = {
      durationMs: dur,
      fadeInMs: p.fixedIn != null ? p.fixedIn : Math.round(dur * (p.inPct || 0)),
      fadeOutMs: p.fixedOut != null ? p.fixedOut : Math.round(dur * (p.outPct || 0)),
    };
    const n = normalizeFades(want);
    if (n.inMs === fin && n.outMs === fout) return p.id;
  }
  return 'custom';
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 检查时序中的问题。
 * 返回 [{level:'error'|'warn'|'info', clipId, message}]
 */
function validate(doc) {
  const issues = [];
  const cfg = doc.config;

  for (const c of doc.clips) {
    // pitch 安全区检查（中国版 0-256，但听感安全区 0.5-2）
    if (c.pitch < 0.5 || c.pitch > 2.0) {
      issues.push({
        level: c.pitch <= 0 || c.pitch > 256 ? 'error' : 'warn',
        clipId: c.id,
        message: `pitch=${c.pitch} 超出听感安全区 [0.5, 2.0]` +
          (c.pitch > 256 || c.pitch <= 0 ? '，且超出引擎允许范围 [0, 256]' : '，会出现明显变声'),
      });
    }
    if (c.volume < 0 || c.volume > 1.0) {
      issues.push({
        level: c.volume > 1 ? 'warn' : 'error',
        clipId: c.id,
        message: `volume=${c.volume} 应为 0..1；超过 1 会叠加音源可能爆音`,
      });
    }
    if (c.startMs < 0) {
      issues.push({ level: 'error', clipId: c.id, message: `起始时间 ${c.startMs}ms 为负` });
    }
    if (c.startMs > cfg.totalMs) {
      issues.push({
        level: 'warn', clipId: c.id,
        message: `起始时间 ${c.startMs}ms 超出时间轴总长 ${cfg.totalMs}ms`,
      });
    }
    // 吸附检查
    if (cfg.snapToGrid && c.startMs % (cfg.gridMs || 50) !== 0) {
      const snapped = msToTick(c.startMs) * 50;
      issues.push({
        level: 'info', clipId: c.id,
        message: `将在导出时从 ${c.startMs}ms 吸附到 ${snapped}ms（${msToTick(c.startMs)} tick）`,
      });
    }
    // 音频未附着
    if (!c.soundPath && !c.soundId) {
      issues.push({ level: 'error', clipId: c.id, message: '未指定音效' });
    }

    // ---- 裁剪 / 变速 / 淡入淡出（卡 t_47b9fab2）----
    // 只报「真的有问题」的：正常编辑出来的值不会踩到这些分支。
    if (c.offsetMs != null && c.offsetMs < 0) {
      issues.push({ level: 'error', clipId: c.id, message: `裁剪起点 ${c.offsetMs}ms 为负（源内入点不能小于 0）` });
    }
    if (c.srcEndMs != null) {
      if (c.srcEndMs <= 0) {
        issues.push({ level: 'warn', clipId: c.id, message: `裁剪终点 ${c.srcEndMs}ms 不合法` });
      } else if (c.srcEndMs <= (c.offsetMs || 0)) {
        issues.push({
          level: 'warn', clipId: c.id,
          message: `裁剪起止无效：终点 ${c.srcEndMs}ms 不晚于起点 ${c.offsetMs || 0}ms，这一段没有素材可播`,
        });
      } else if (c.srcDurMs != null && c.srcEndMs > c.srcDurMs) {
        issues.push({
          level: 'warn', clipId: c.id,
          message: `裁剪终点 ${c.srcEndMs}ms 超出源音频长度 ${c.srcDurMs}ms，导出时会按实际长度截断`,
        });
      }
    }
    if (c.srcDurMs != null && (c.offsetMs || 0) > c.srcDurMs) {
      issues.push({
        level: 'warn', clipId: c.id,
        message: `裁剪起点 ${c.offsetMs}ms 超出源音频长度 ${c.srcDurMs}ms`,
      });
    }
    if ((c.fadeInMs || 0) + (c.fadeOutMs || 0) > c.durationMs) {
      issues.push({
        level: 'warn', clipId: c.id,
        message: `淡入 ${c.fadeInMs || 0}ms + 淡出 ${c.fadeOutMs || 0}ms 超过片段长度 ${c.durationMs}ms，`
          + '播放时会给淡出让路（淡出会被压缩）',
      });
    }
    if ((c.fadeInMs || 0) < 0 || (c.fadeOutMs || 0) < 0) {
      issues.push({ level: 'error', clipId: c.id, message: '淡入 / 淡出时长不能为负' });
    }
  }

  // 重叠警告（同轨道）
  const byTrack = {};
  for (const c of doc.clips) {
    (byTrack[c.track] = byTrack[c.track] || []).push(c);
  }
  for (const t of Object.keys(byTrack)) {
    const list = byTrack[t].slice().sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      const prevEnd = prev.startMs + prev.durationMs;
      if (cur.startMs < prevEnd) {
        issues.push({
          level: 'info',
          clipId: cur.id,
          message: `与同轨道「${prev.label}」时间重叠（${prev.startMs}~${prevEnd}ms）`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 导出：策划案 Markdown
// ---------------------------------------------------------------------------

function fmtMs(ms) {
  return `${ms}ms (${msToSec(ms)}s, ${msToTick(ms)}tick)`;
}

/**
 * 取原版音效库（卡 t_3623451f）。
 * 渲染进程里由 event-audio.js 提供 window.MCS_EVENTS；导出逻辑也可能被脚本沙箱
 * 单独调用（没加载那个模块），这时返回空对象 —— 导出仍然能跑，只是不写变体相关的行。
 */
function eventLib() {
  return (typeof window !== 'undefined' && window.MCS_EVENTS) || {};
}

/** 该片段要写进导出的音效名：指定变体 → 单独注册的钉变体名；否则原事件名 */
function exportSoundName(c) {
  const lib = eventLib();
  const pin = lib.pinNameOf ? lib.pinNameOf(c) : null;
  return pin || c.soundId || c.label;
}

function exportMarkdown(doc) {
  const v = doc.visual;
  // 总长以顶栏「总长(ms)」为准（卡 t_6b99a1fd）：以前这里优先取素材的自然时长，
  // 于是「用户改了总长、导入动画后又变回素材长度」，导出的策划案和界面对不上。
  const totalMs = doc.config.totalMs;
  const L = [];

  L.push(`# 音效时序策划案：${doc.name}`);
  L.push('');
  L.push(`> 本文件由 MCSoundStudio 自动生成，可直接粘贴进策划文档。`);
  L.push('');
  L.push('## 一、基础信息');
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('|---|---|');
  L.push(`| 时序总长 | ${fmtMs(totalMs)} |`);
  L.push(`| 网格精度 | ${doc.config.gridMs}ms（1 tick = 50ms） |`);
  if (doc.config.bpm > 0) {
    L.push(`| BPM | ${doc.config.bpm}（${doc.config.beatsPerBar}/4 拍） |`);
  }
  if (v.kind !== 'none') {
    L.push(`| 视觉参考 | ${v.kind}${v.animName ? ' · 动画 `' + v.animName + '`' : ''} |`);
    if (v.path || v.animFile) L.push(`| 源文件 | \`${v.path || v.animFile}\` |`);
  }
  L.push('');

  L.push('## 二、时序编排');
  L.push('');
  L.push('按时间顺序排列：');
  L.push('');

  const sorted = doc.clips.slice().sort((a, b) => a.startMs - b.startMs);
  if (!sorted.length) {
    L.push('_（尚未添加任何音效）_');
    L.push('');
  } else {
    L.push('| # | 时间点 | 音效 | 音量 | 音高 | 时长 | 说明 |');
    L.push('|---|---|---|---|---|---|---|');
    sorted.forEach((c, i) => {
      const pitchNote = c.pitch !== 1.0 ? `**${c.pitch}**` : '1.0';
      const volNote = c.volume !== 1.0 ? `**${c.volume}**` : '1.0';
      L.push(
        `| ${i + 1} | ${fmtMs(c.startMs)} | \`${c.soundId || c.label}\` | ${volNote} | ${pitchNote} | ${c.durationMs}ms | ${c.note || ''} |`
      );
    });
    L.push('');
  }

  L.push('## 三、分层结构');
  L.push('');
  const byTrack = {};
  for (const c of doc.clips) (byTrack[c.track] = byTrack[c.track] || []).push(c);
  // 只导出真正用到的轨道：空轨道（如默认的「主轨」没放东西）
  // 写进策划案只会让人以为漏了内容
  const usedTracks = doc.tracks.filter((tk) => (byTrack[tk.name] || []).length);
  const emptyTracks = doc.tracks.filter((tk) => !(byTrack[tk.name] || []).length);

  if (!usedTracks.length) {
    L.push('_（还没有放置任何音效）_');
    L.push('');
  }
  for (const tk of usedTracks) {
    const list = (byTrack[tk.name] || []).sort((a, b) => a.startMs - b.startMs);
    L.push(`### 轨道：${tk.label} \`${tk.name}\``);
    L.push('');
    for (const c of list) {
      const parts = [`**${fmtMs(c.startMs)}** → \`${c.soundId || c.label}\``];
      if (c.volume !== 1) parts.push(`音量 ${c.volume}`);
      if (c.pitch !== 1) parts.push(`音高 ${c.pitch}`);
      if (c.note) parts.push(`备注：${c.note}`);
      L.push('- ' + parts.join('，'));
    }
    L.push('');
  }
  if (emptyTracks.length) {
    L.push(`> 另有 ${emptyTracks.length} 条空轨道（${emptyTracks.map((t) => t.label).join('、')}）未放置音效，未列入上表。`);
    L.push('');
  }

  // 节奏型描述
  const withBpm = doc.config.bpm > 0;
  if (withBpm && sorted.length >= 2) {
    L.push('## 四、节奏型');
    L.push('');
    const beatMs = 60000 / doc.config.bpm;
    L.push(`以 **${doc.config.bpm} BPM**（每拍 ${Math.round(beatMs)}ms）为基准，各音效落点：`);
    L.push('');
    for (const c of sorted) {
      const bars = doc.config.beatsPerBar || 4;
      const totalBeats = c.startMs / beatMs;
      const beatIdxAll = Math.floor(totalBeats);
      const barNo = Math.floor(beatIdxAll / bars) + 1;
      const beatInBar = (beatIdxAll % bars) + 1;
      // 拍内偏移（如落在第 2 拍的后 40%），方便对鼓点
      const frac = totalBeats - beatIdxAll;
      const fracTxt = frac > 0.01 ? `，拍内 +${(frac * 100).toFixed(0)}%` : '';
      L.push(`- \`${c.soundId || c.label}\` → **第 ${barNo} 小节第 ${beatInBar} 拍**${fracTxt}`
        + `（绝对拍位 ${totalBeats.toFixed(3)}）`);
    }
    L.push('');
  }

  // pitch 设计意图
  const pitchChanged = sorted.filter((c) => c.pitch !== 1.0);
  if (pitchChanged.length) {
    L.push('## ' + (withBpm ? '五' : '四') + '、音高设计');
    L.push('');
    L.push('以下音效通过**微调音高**制造听感差异（同一素材不同参数）：');
    L.push('');
    for (const c of pitchChanged) {
      const dir = c.pitch > 1 ? '升调' : '降调';
      const delta = (c.pitch - 1) * 100;
      // 写成「+50%」而不是「50%」：后者会被读成「原速的 50%」，
      // 而 pitch 1.5 实际是「比原速快/高 50%」，方向完全相反
      const deltaStr = (delta > 0 ? '+' : '') + delta.toFixed(0) + '%';
      L.push(`- \`${c.soundId || c.label}\`：pitch = **${c.pitch}**（${dir}，比原速 ${deltaStr}）`);
    }
    L.push('');
  }

  // 裁剪起止 / 变速 / 淡入淡出（卡 t_47b9fab2）：只要有一样，就单独写一节。
  // 为什么单开一节而不是往上面那张表里塞列：上面那张表的位置是稳定的（别的脚本按
  // 「第几列是时长」在核对），而起止裁剪要写清楚「源内起 → 源内止 + 素材长度 + 条长」，
  // 塞进去会把表挤得没法看。
  const tweaked = sorted.filter((c) => isTrimmed(c) || rateOf(c) !== 1
    || (c.fadeInMs || 0) > 0 || (c.fadeOutMs || 0) > 0);
  if (tweaked.length) {
    const secNo = 3 + (withBpm ? 1 : 0) + (pitchChanged.length ? 1 : 0) + 1;
    const CN = { 4: '四', 5: '五', 6: '六', 7: '七', 8: '八' };
    L.push(`## ${CN[secNo] || secNo}、裁剪起止与效果（非破坏性）`);
    L.push('');
    L.push('> 「源内起 → 止」= 用到素材内部的那一段；文件本身没有被改动，'
      + '在编辑器里把边缘拖回去就能恢复。播放倍速即 pitch（磁带式变速：速度与音高一起变）。');
    L.push('');
    L.push('| 音效 | 时间点 | 源内起 → 止 | 素材保留 | 片段长度 | 播放倍速 | 淡入 / 淡出 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const c of tweaked) {
      const inMs = Math.max(0, c.offsetMs || 0);
      const outMs = srcOutMs(c);
      const total = srcTotalMs(c);
      const range = `${inMs}ms → ${outMs}ms（源 ${total}ms${isTrimmed(c) ? '' : '，未裁剪'}）`;
      const rate = rateOf(c);
      const rateTxt = rate === 1 ? '1.00x' : `**${rate.toFixed(2)}x**`;
      const fin = c.fadeInMs || 0, fout = c.fadeOutMs || 0;
      const fadeTxt = (fin || fout)
        ? [fin ? `淡入 ${fin}ms` : '', fout ? `淡出 ${fout}ms` : ''].filter(Boolean).join(' / ')
        : '硬切';
      L.push(`| \`${c.soundId || c.label}\` | ${fmtMs(c.startMs)} | ${range} | `
        + `${Math.round(contentMs(c))}ms | ${c.durationMs}ms | ${rateTxt} | ${fadeTxt} |`);
    }
    L.push('');
    if (tweaked.some((c) => !isTrimmed(c) && rateOf(c) !== 1)) {
      L.push('倍速是为了让音效正好铺满时间轴上那一条（拖片段右边缘改长度 = 等比改倍速）。'
        + '导出到 ModSDK 时写进 `PlayCustomMusic` 的 pitch 参数，引擎同样会**同时改速度和音高**；'
        + '真要「变速不变调」，得先在音频软件里处理素材。');
      L.push('');
    }
  }

  // 指定变体（卡 t_3623451f）：随机变体是引擎行为（写事件名就够），指定变体必须
  // 写清楚「具体哪一个文件」，否则策划照着表去听会听到另一个变体 —— 库里 863 个
  // 事件有多个变体，这不是边角情况。
  const pinned = sorted.map((c) => ({
    clip: c,
    pin: eventLib().pinnedEntry ? eventLib().pinnedEntry(c) : null,
  })).filter((x) => x.pin);
  if (pinned.length) {
    L.push('## 附：指定变体（固定播放哪一个）');
    L.push('');
    L.push('> 这些片段在界面上选了「指定变体」，不走引擎随机。'
      + '导出到 ModSDK 时用的是一个**单独注册的事件名**（见 `sound_definitions.json` 里的 '
      + '`<事件名>__v<序号>`），它只挂这一个文件；原版事件名本身仍然会随机，别混用。');
    L.push('');
    L.push('| 音效 | 时间点 | 指定变体 | 变体文件 | 变体自带音量 / 音高 |');
    L.push('|---|---|---|---|---|');
    for (const { clip, pin } of pinned) {
      L.push(`| \`${pin.event}\` | ${fmtMs(clip.startMs)} | 第 ${pin.index + 1} / ${pin.total} 个 `
        + `(\`${pin.name}\`) | \`${pin.file}\` | ${pin.volume} / ${pin.pitch} |`);
    }
    L.push('');
  }

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 导出：ModSDK Python
// ---------------------------------------------------------------------------

function exportModSDKPython(doc, opts) {
  const o = opts || {};
  const ns = o.namespace || 'mymod';
  const funcName = o.funcName || 'playMachineSequence';
  // 同 exportMarkdown：总长只认顶栏的值（卡 t_6b99a1fd）
  const totalMs = doc.config.totalMs;
  const sorted = doc.clips.slice().sort((a, b) => a.startMs - b.startMs);

  const L = [];
  L.push('# -*- coding: utf-8 -*-');
  L.push('"""');
  L.push(`音效时序播放器：${doc.name}`);
  L.push('');
  L.push('由 MCSoundStudio 自动生成。');
  L.push('');
  L.push('用法（在客户端 System 中调用）：');
  L.push(`    self.${funcName}(pos)`);
  L.push('');
  L.push('说明：');
  L.push('  - 使用 mod.client.component.audioCustomCompClient.AudioCustomComponentClient');
  L.push('  - PlayCustomMusic(name, pos, volume, pitch, loop, entityId)');
  L.push('    （第 5 个参数 loop 固定传 False：本工具已不提供「循环播放」，只产出「播一次」）');
  L.push('  - 音效名必须已在 sound_definitions.json 中注册');
  L.push('  - 界面上选了「指定变体」的片段，音效名形如 <事件名>__v<序号>，它只在');
  L.push('    导出的 sound_definitions.json 里注册：那份文件必须一起打进资源包，');
  L.push('    否则这个名字不存在、引擎不会播（原版事件名本身仍然会随机，别混用）');
  L.push('  - 时间调度基于 tick（50ms），非网格时间点已吸附');
  L.push('  - 片段做过「裁剪 / 淡入淡出」的：本接口没有这些参数（只能给 name/pos/volume/pitch/loop），');
  L.push('    时间表行末注释里标明了，需按注释先在音频软件里把素材处理好');
  L.push('"""');
  L.push('');
  L.push('import mod.client.extraClientApi as clientApi');
  L.push('');
  L.push('');
  L.push('class SoundSequencePlayer(object):');
  L.push(`    """${doc.name} 播放器"""`);
  L.push('');
  L.push('    # 时序总长（ms）');
  L.push(`    TOTAL_MS = ${totalMs}`);
  L.push('');
  L.push('    # 时序表： (延迟ms, 音效名, 音量, 音高)   # 行末注释是备注');
  L.push('    # 延迟相对于序列开始时刻');
  L.push('    TIMELINE = [');
  sorted.forEach((c) => {
    // 指定变体的片段写「单独注册过的钉变体名」（见 exportSoundDefinitions 的注册项），
    // 随机变体片段照旧写原事件名（引擎随机 = 与界面上的「随机变体」一致）
    const name = exportSoundName(c);
    // 裁剪 / 倍速 / 淡入淡出在 ModSDK 接口里没有对应参数
    // （PlayCustomMusic 只能给 name/pos/volume/pitch/loop），
    // 所以写进行末注释：做资源的人照着先在音频软件里处理素材。
    const extra = [];
    const pin = eventLib().pinnedEntry ? eventLib().pinnedEntry(c) : null;
    if (pin) {
      extra.push(`指定变体 第${pin.index + 1}/${pin.total}个·${pin.file}`
        + `（变体自带 音量${pin.volume}/音高${pin.pitch}）`);
    }
    if (isTrimmed(c)) extra.push(`裁剪 源内 ${Math.max(0, c.offsetMs || 0)}ms → ${srcOutMs(c)}ms`);
    if (rateOf(c) !== 1) extra.push(`倍速 ${rateOf(c).toFixed(2)}x（即 pitch）`);
    if ((c.fadeInMs || 0) || (c.fadeOutMs || 0)) {
      extra.push(`淡入 ${c.fadeInMs || 0}ms / 淡出 ${c.fadeOutMs || 0}ms`);
    }
    const note = [c.note || '', extra.join('，')].filter(Boolean).join(' | ')
      .replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    // 第 5 个参数（引擎的 loop 开关）不看片段了：本工具只产出「播一次」，
    // 统一在 _fire() 里固定传 False。表里不再有「是否循环」这一列。
    L.push(`        (${c.startMs}, "${name}", ${c.volume}, ${c.pitch}),  # ${note}`);
  });
  L.push('    ]');
  L.push('');
  L.push('    def __init__(self, levelId=None):');
  L.push('        self.levelId = levelId or clientApi.GetLevelId()');
  L.push('        self.comp = clientApi.GetEngineCompFactory().CreateCustomAudio(self.levelId)');
  L.push('        self._timers = []');
  L.push('        self._playingIds = []');
  L.push('');
  L.push('    def play(self, pos=(0.0, 0.0, 0.0), entityId=None, volumeScale=1.0, pitchScale=1.0):');
  L.push('        """');
  L.push('        播放整个时序。所有音效统一从"序列开始时刻"对齐。');
  L.push('');
  L.push('        :param pos: 播放位置（世界坐标元组）；若 entityId 不为空则为相对坐标');
  L.push('        :param entityId: 绑定的实体 id，绑定后音效跟随实体、且不受 16 格距离限制');
  L.push('        :param volumeScale: 全局音量缩放');
  L.push('        :param pitchScale: 全局音高缩放');
  L.push('        """');
  L.push('        import time');
  L.push('        self.stop()');
  L.push('        t0 = time.time()');
  L.push('        for item in self.TIMELINE:');
  L.push('            delayMs, name, volume, pitch = item');
  L.push('            if delayMs <= 0:');
  L.push('                self._fire(name, pos, volume * volumeScale, pitch * pitchScale, entityId)');
  L.push('            else:');
  L.push('                # 注意：所有延迟都相对 t0，而不是层层嵌套，避免计时器漂移累积');
  L.push('                self._schedule(delayMs / 1000.0, name, pos,');
  L.push('                               volume * volumeScale, pitch * pitchScale, entityId)');
  L.push('');
  L.push('    def _schedule(self, delaySec, name, pos, volume, pitch, entityId):');
  L.push('        """用计时器延迟播放（延迟单位为秒）。"""');
  L.push('');
  L.push('        def _cb():');
  L.push('            self._fire(name, pos, volume, pitch, entityId)');
  L.push('');
  L.push('        # CreateGame 组件的 AddTimer(秒, 回调)');
  L.push('        timerComp = clientApi.GetEngineCompFactory().CreateGame(self.levelId)');
  L.push('        timerComp.AddTimer(delaySec, _cb)');
  L.push('');
  L.push('    def _fire(self, name, pos, volume, pitch, entityId):');
  L.push('        """实际播放一次音效。"""');
  L.push('        # 音量钳制到 [0, 1]（中国版接口限制）');
  L.push('        volume = max(0.0, min(1.0, volume))');
  L.push('        # 音高钳制到引擎允许范围 [0, 256]');
  L.push('        pitch = max(0.0, min(256.0, pitch))');
  L.push('        try:');
  L.push('            musicId = self.comp.PlayCustomMusic(');
  L.push('                name, pos, volume, pitch, False,  # loop 固定 False = 只播一次');
  L.push('                entityId');
  L.push('            )');
  L.push('            if musicId and not str(musicId).startswith("-"):');
  L.push('                self._playingIds.append(musicId)');
  L.push('            else:');
  L.push('                # 错误码：-1 服务端不可播 / -2 位置错 / -4 播放失败 /');
  L.push('                #        -5 实体不存在 / -6 距玩家超过 16 格被跳过');
  L.push('                print("[SoundSequence] 播放失败 %s, err=%s" % (name, musicId))');
  L.push('        except Exception as e:');
  L.push('            print("[SoundSequence] 异常 %s: %s" % (name, e))');
  L.push('');
  L.push('    def stop(self):');
  L.push('        """停止本播放器触发的所有音效。"""');
  L.push('        for mid in self._playingIds:');
  L.push('            try:');
  L.push('                self.comp.StopCustomMusicById(mid, 0.2)');
  L.push('            except Exception:');
  L.push('                pass');
  L.push('        self._playingIds = []');
  L.push('        self._timers = []');
  L.push('');
  L.push('');
  L.push('# ---------------------------------------------------------------------------');
  L.push('# 接入示例：在客户端 System 中');
  L.push('# ---------------------------------------------------------------------------');
  L.push('#');
  L.push('# import mod.client.extraClientApi as clientApi');
  L.push('# class MyClientSystem(clientApi.GetClientSystemCls()):');
  L.push('#     def __init__(self, namespace, systemName):');
  L.push('#         super(MyClientSystem, self).__init__(namespace, systemName)');
  L.push(`#         self.player = SoundSequencePlayer()`);
  L.push('#');
  L.push('#     def onMachineDeploy(self, machinePos):');
  L.push(`#         self.player.play(pos=machinePos, volumeScale=1.0, pitchScale=1.0)`);
  L.push('');

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 导出：sound_definitions.json 片段
// ---------------------------------------------------------------------------

function exportSoundDefinitions(doc, opts) {
  const o = opts || {};
  // 收集所有音效：有 soundId 的直接用；没有的（自定义音频）生成一个 id
  const defs = {};
  const seen = new Set();        // 自定义音频的 id 去重（老逻辑）
  const seenPins = new Set();    // 钉变体名去重（卡 t_4e96920b）
  // 记录被跳过的原版事件，写进注释让用户知道为什么文件是空的
  const vanillaSkipped = [];
  // 指定变体（卡 t_3623451f）注册出来的「钉变体名」，同样的原因要写进注释
  const pinnedRegs = [];

  for (const c of doc.clips) {
    // 原版事件已在游戏内注册，不需要重复定义；
    // 但要在导出说明里讲清楚，否则用户会以为导出失败
    if (c.kind === 'event' && c.soundId) {
      // 例外：指定变体（卡 t_3623451f）。原版事件名底下挂着一串变体、引擎随机挑，
      // 想固定成某一个，只能另注册一个 key（sounds 里只放那一个文件）。
      //
      // 去重必须按「钉变体名」而不是事件名（卡 t_4e96920b 修）：
      // 以前这里是 `const id = c.soundId || c.label; if (seen.has(id)) continue;`
      // —— 去重发生在「这是不是指定变体」判断**之前**，于是同一个事件在时间轴上
      // 出现两次、只有第二个片段选了「指定变体」时，第二个片段整段被跳过：
      // ModSDK Python 里引用了 hit.stone__v3，sound_definitions.json 里却没有这个
      // key（还是空对象），资源包给游戏 → 那一刻没声音，用户完全不知道。
      // 现在按钉变体名去重：同一事件的**不同**钉变体都会注册；同一个钉变体名出现
      // 两次时只注册一次，sounds 里也不重复塞同一条。
      const pin = eventLib().pinnedEntry ? eventLib().pinnedEntry(c) : null;
      if (pin) {
        if (!seenPins.has(pin.name)) {
          seenPins.add(pin.name);
          defs[pin.name] = {
            category: c.category || o.category || 'block',
            min_distance: 0.0,
            max_distance: o.maxDistance != null ? o.maxDistance : 16.0,
            sounds: [],
          };
          pinnedRegs.push({
            name: pin.name, event: pin.event, index: pin.index, total: pin.total, file: pin.file,
          });
        }
        const entry = defs[pin.name];
        const rel = 'sounds/' + pin.file;
        if (!entry.sounds.some((s) => s.name === rel)) {
          entry.sounds.push({
            name: rel,
            volume: pin.volume,
            pitch: pin.pitch,
            load_on_low_memory: true,
          });
        }
      } else {
        vanillaSkipped.push(c.soundId);
      }
      continue;
    }

    const id = c.soundId || c.label;
    if (seen.has(id)) continue;
    seen.add(id);

    // 本地自定义音频（没有 soundId，只有路径）需要注册
    if (c.soundPath) {
      // 文件名去掉扩展名，作为资源包里的音频文件名
      const baseName = String(c.label || id).replace(/[\\/:*?"<>|]/g, '_');
      const rel = 'sounds/' + (o.customFolder || 'custom') + '/' + baseName;
      const variant = {
        name: rel,
        volume: typeof c.volume === 'number' ? c.volume : 1.0,
        // 基岩 sound_definitions 里 pitch 用相对倍率，0.5~2.0 之外会被钳
        pitch: typeof c.pitch === 'number'
          ? Math.max(0.25, Math.min(4.0, c.pitch))
          : 1.0,
        load_on_low_memory: true,
      };
      if (!defs[id]) {
        defs[id] = {
          category: c.category || o.category || 'block',
          min_distance: 0.0,
          max_distance: o.maxDistance != null ? o.maxDistance : 16.0,
          sounds: [],
        };
      }
      defs[id].sounds.push(variant);
    }
  }

  const out = {
    format_version: '1.14.0',
    sound_definitions: defs,
  };

  // 自定义音效为 0 时加一段 _说明，避免用户打开看到空对象以为出错
  if (Object.keys(defs).length === 0) {
    out._说明 = vanillaSkipped.length
      ? `本时序使用的 ${new Set(vanillaSkipped).size} 个音效全部是原版事件，`
        + `游戏内已存在，无需重复注册。原版事件：${[...new Set(vanillaSkipped)].join(', ')}`
      : '本时序还没有自定义音频，不需要 sound_definitions.json。'
        + '把自定义音频（ogg/wav）拖进时间轴后，这里会自动生成注册项。';
  } else if (pinnedRegs.length) {
    // 有「指定变体」注册项时必须说明怎么用：原版事件名照样随机，这些新名字才固定
    out._指定变体说明 = pinnedRegs.map((p) =>
      `${p.name} = ${p.event} 的第 ${p.index + 1}/${p.total} 个变体（sounds/${p.file}）；`
      + '资源包里需要有这个 ogg（可从原版资源包拷到同路径），ModSDK 里用它替代原事件名。');
  }
  return JSON.stringify(out, null, 2);
}

// ---------------------------------------------------------------------------
// 导出：Blockbench animation 的 sound_effects 片段
// ---------------------------------------------------------------------------

/**
 * 如果你的动画是数据驱动的 .animation.json，可以直接把音效挂到关键帧上。
 * 生成可直接粘贴进 animation 定义的 "sound_effects" 块。
 */
function exportAnimationSoundEffects(doc, opts) {
  const o = opts || {};
  const sorted = doc.clips.slice().sort((a, b) => a.startMs - b.startMs);
  const block = {};
  for (const c of sorted) {
    const t = msToSec(c.startMs);
    const key = String(t);
    const entry = {
      // 指定变体的片段要用「注册过的钉变体名」（同 exportSoundDefinitions / Python）：
      // 以前这里写 c.soundId，于是一个钉住第 3 个变体的片段在动画里仍写原事件名，
      // 引擎照样随机 —— 和另外三个产物对不上（卡 t_4e96920b 顺带修）。
      effect: c.shortName || exportSoundName(c),
    };
    if (c.volume !== 1.0) entry.volume = c.volume;
    if (c.pitch !== 1.0) entry.pitch = c.pitch;
    if (!block[key]) block[key] = [];
    block[key].push(entry);
  }
  return JSON.stringify({ sound_effects: block }, null, '\t');
}

// ---------------------------------------------------------------------------
// 导入容错：外部工程缺字段时补齐（卡 t_59ec2202）
//
// 背景（实测，见 dev-verify-t_59ec2202/probe-pitch-compat-BEFORE-fix.log）：
//   把一份手改过 / 第三方工具生成的 *.timeline.json 放进工程库点卡片导入，
//   只要 clips[] 里缺 pitch，渲染就在 renderTimeline 里抛未捕获异常
//   （`c.pitch.toFixed(2)`），**时间轴画到一半就断**（4 个片段只画出 1 个），
//   同一份工程再去导出还会在 exportMarkdown 里 `doc.visual.kind` 处炸掉。
//   缺 tracks 时更早炸（`STATE.doc.tracks.some`），缺 config 时输入框收到
//   "undefined" 控制台报错。
//
// 为什么在**导入这一处**统一补齐，而不是在每个读取点各写一个 || 默认值：
//   片段的 pitch / volume / kind 会被渲染、播放、校验、四份导出各读一次，
//   逐个加兜底总有漏网的（本卡就是漏在渲染角标上）。这里补齐一次，
//   下游所有消费者拿到的都是**和 makeClip 同形状**的片段 —— 与「老工程缺
//   srcDurMs」既有的兜底思路一致，只是从单字段扩到整类字段。
//
// 铁律：只补「缺失 / 类型不合法」的字段，**文件里写明的合法值一个字都不改**。
//   正常工程（程序自己存的）本来就不缺字段，走完这里逐字段全等 → 行为不变。
// ---------------------------------------------------------------------------

/**
 * 能当有限数用就用（含 "1.5" 这种数字字符串），否则退回默认值。
 * 注意 null / undefined / 空串 / 布尔 都算「这个字段没写」：
 * 不能靠 Number(null) === 0 —— 那会把「没裁尾」(srcEndMs: null) 变成 0，
 * 而 0 是合法的源内出点，会把片段判成「裁过」且实际发不出声。
 */
function numOr(v, dflt) {
  if (v == null || v === '' || typeof v === 'boolean') return dflt;
  const n = (typeof v === 'string') ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 非负有限数（时间类字段用；负数在这套模型里没有意义） */
function nonNegNum(v, dflt) {
  const n = numOr(v, NaN);
  return Number.isFinite(n) ? Math.max(0, n) : dflt;
}

/** 字符串字段：非空字符串原样留，其它一律给默认值 */
function strOr(v, dflt) {
  return (typeof v === 'string' && v.length) ? v : dflt;
}

/** 取一个工程里没用过的片段 id（缺失 / 重复时用） */
function freshClipId(used) {
  let id;
  do { id = 'clip_' + Math.random().toString(36).slice(2, 10); } while (used.has(id));
  used.add(id);
  return id;
}

/**
 * 把一条外部片段补成 makeClip 的形状（就地修改，返回同一个对象）。
 * 非对象的垃圾条目（null / 数字 / 字符串）会被换成一条默认片段而不是被丢掉 ——
 * 与 renderTimeline「片段引用了不存在的轨道就补建轨道，而不是静默丢弃」同一取舍：
 * 宁可留下一眼能看见、能删掉的空片段，也不要凭空少一条。
 */
function normalizeClipCompat(raw, opts) {
  const o = opts || {};
  const c = (raw && typeof raw === 'object') ? raw : {};

  c.id = strOr(c.id, '');
  if (!c.id || o.used.has(c.id)) c.id = freshClipId(o.used); else o.used.add(c.id);

  c.soundId = strOr(c.soundId, '');
  c.soundPath = strOr(c.soundPath, '');
  c.label = strOr(c.label, c.soundId || '未命名');
  c.kind = strOr(c.kind, 'file');
  c.category = strOr(c.category, '');
  c.variantCount = Math.max(1, Math.round(numOr(c.variantCount, 1)));

  c.startMs = Math.round(nonNegNum(c.startMs, 0));
  const dur = numOr(c.durationMs, 500);
  c.durationMs = Math.round(dur > 0 ? dur : 500);
  c.offsetMs = Math.round(nonNegNum(c.offsetMs, 0));
  // 这两个 null = 「没裁尾 / 源长未知」，不能凭空补值（补了会被当成「裁过」）
  c.srcEndMs = Number.isFinite(numOr(c.srcEndMs, NaN)) ? Math.round(nonNegNum(c.srcEndMs, 0)) : null;
  const sd = numOr(c.srcDurMs, NaN);
  c.srcDurMs = (Number.isFinite(sd) && sd > 0) ? Math.round(sd) : null;

  // pitch 既是音高也是播放倍速：缺失 / 非数 / <=0 一律按 1.0 兜底
  const pitch = numOr(c.pitch, NaN);
  c.pitch = (Number.isFinite(pitch) && pitch > 0) ? pitch : 1.0;
  const vol = numOr(c.volume, NaN);
  c.volume = Number.isFinite(vol) ? Math.max(0, vol) : 1.0;

  // 「循环播放 / 循环区间终点」已在卡 t_6b5016ec 里整体移除：老工程里夹带的这两个字段
  // 按**废弃字段**处理 —— 从对象上删掉（不能留着，否则保存 / 导出会把它们原样写回去，
  // 变成「界面上没有、文件里还有」的半截状态）。除此之外一个字段都不动：
  // 第三方工具写进来的其它键照旧原样留着（与 config / visual 的处理一致）。
  delete c.loop;
  delete c.loopEndMs;

  c.fadeInMs = Math.round(nonNegNum(c.fadeInMs, 0));
  c.fadeOutMs = Math.round(nonNegNum(c.fadeOutMs, 0));
  c.fadePreset = strOr(c.fadePreset, 'none');

  // 变体：lockedVariant 是「变体下标」（数字）。老工程里也可能存文件名 / 数字串 ——
  // 事件层的 lockedVariantIndex 自己会 Number() 并夹回合法范围（那条注释里明说了
  // 「存的是文件路径」这一种），所以数字与非空字符串都**原样留着**，
  // 只把 null / 空串 / 对象这类解释不了的值归 null。
  // （别把这行写成「只认非空字符串」—— 那会把老工程锁定的变体悄悄丢掉，退回随机。）
  c.variantMode = strOr(c.variantMode, 'auto');
  {
    const lv = c.lockedVariant;
    const keepNum = (typeof lv === 'number' && Number.isFinite(lv));
    const keepStr = (typeof lv === 'string' && lv.length > 0);
    c.lockedVariant = (keepNum || keepStr) ? lv : null;
  }

  c.track = strOr(c.track, o.defaultTrack);
  c.color = (typeof c.color === 'string' && c.color.length) ? c.color : null;
  c.locked = !!c.locked;
  c.note = strOr(c.note, '');
  return c;
}

/**
 * 导入一份工程（外部文件 / 旧工程）前，把缺的字段补齐。就地修改并返回同一份 doc。
 *
 * @returns {object} 传进来的那份 doc（已补齐）
 */
function normalizeImportedDoc(doc) {
  if (!doc || typeof doc !== 'object') return doc;

  // ---- config：缺键补默认值（已有键一个都不动，只有「不是数」的才回退）----
  const cfg = (doc.config && typeof doc.config === 'object') ? doc.config : {};
  const D = DEFAULT_CONFIG;
  doc.config = {
    gridMs: (numOr(cfg.gridMs, NaN) > 0) ? Math.round(numOr(cfg.gridMs, NaN)) : D.gridMs,
    gridMode: (cfg.gridMode === 'beat' || cfg.gridMode === 'ms') ? cfg.gridMode : D.gridMode,
    snapToGrid: (cfg.snapToGrid == null) ? D.snapToGrid : !!cfg.snapToGrid,
    totalMs: (numOr(cfg.totalMs, NaN) > 0) ? Math.round(numOr(cfg.totalMs, NaN)) : D.totalMs,
    bpm: Math.max(0, numOr(cfg.bpm, NaN) || 0),                    // 0 = 未设置，合法
    beatsPerBar: (numOr(cfg.beatsPerBar, NaN) > 0) ? Math.round(numOr(cfg.beatsPerBar, NaN)) : D.beatsPerBar,
  };
  // 保留第三方工具可能写进来的其它键，只补我们认识的这几个
  for (const k of Object.keys(cfg)) if (!(k in doc.config)) doc.config[k] = cfg[k];

  doc.name = strOr(doc.name, '未命名时序');

  // ---- visual：缺了会让策划案导出在 `doc.visual.kind` 处抛异常（exportMarkdown），
  //      导入 GIF / 模型时也会往 STATE.doc.visual.kind 上写值 ----
  const rawV = (doc.visual && typeof doc.visual === 'object') ? doc.visual : {};
  const numOrNull = (x) => (Number.isFinite(numOr(x, NaN)) ? numOr(x, null) : null);
  doc.visual = {
    kind: strOr(rawV.kind, 'none'),
    path: (typeof rawV.path === 'string' && rawV.path) ? rawV.path : null,
    dataUrl: (typeof rawV.dataUrl === 'string' && rawV.dataUrl) ? rawV.dataUrl : null,
    animFile: (typeof rawV.animFile === 'string' && rawV.animFile) ? rawV.animFile : null,
    animName: (typeof rawV.animName === 'string' && rawV.animName) ? rawV.animName : null,
    naturalMs: numOrNull(rawV.naturalMs),
    manualMs: numOrNull(rawV.manualMs),
  };
  // 模型预览等用途会在 visual 上另挂键（如 modelPath），一并留住
  for (const k of Object.keys(rawV)) if (!(k in doc.visual)) doc.visual[k] = rawV[k];

  // ---- tracks：至少一条，字段补全 ----
  const rawTracks = Array.isArray(doc.tracks) ? doc.tracks.filter((t) => t && typeof t === 'object') : [];
  doc.tracks = rawTracks.map((t) => ({
    name: strOr(t.name, 'main'),
    label: strOr(t.label, strOr(t.name, 'main')),
    muted: !!t.muted,
    solo: !!t.solo,
    gain: Number.isFinite(numOr(t.gain, NaN)) ? numOr(t.gain, 1) : 1.0,
  }));
  if (!doc.tracks.length) doc.tracks = [makeTrack('main', { label: '主轨' })];
  const defaultTrack = doc.tracks[0].name;

  // ---- clips ----
  const used = new Set();
  const rawClips = Array.isArray(doc.clips) ? doc.clips : [];
  doc.clips = rawClips.map((c) => normalizeClipCompat(c, { used, defaultTrack }));
  // 片段引用了工程里没有的轨道：补建（renderTimeline 里也有一层同样目的兜底，
  // 放在这里是为了「读 doc 的人也看到同一条轨道」，导出的轨道表才不缺行）
  for (const c of doc.clips) {
    if (!doc.tracks.some((t) => t.name === c.track)) {
      doc.tracks.push(makeTrack(c.track, { label: c.track }));
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 导出：timeline.json（回存）
// ---------------------------------------------------------------------------

function exportTimelineJson(doc) {
  // dataUrl 可能非常大（gif base64），回存时剔除
  const copy = JSON.parse(JSON.stringify(doc));
  if (copy.visual) copy.visual.dataUrl = null;
  return JSON.stringify(copy, null, 2);
}

// Export to global for renderer (no module system in plain script)
window.MCS = {
  DEFAULT_CONFIG,
  makeClip,
  makeTrack,
  makeDocument,
  snapMs,
  effectiveGridMs,
  barMs,
  msToTick,
  msToSec,
  validate,
  exportMarkdown,
  exportModSDKPython,
  exportSoundDefinitions,
  exportAnimationSoundEffects,
  exportTimelineJson,
  // 片段几何：条长 ↔ 倍速 / 非破坏性裁剪 / 淡入淡出（卡 t_47b9fab2）
  MIN_DURATION_MS,
  MIN_RATE,
  MAX_RATE,
  FADE_PRESETS,
  rateOf,
  srcTotalMs,
  srcOutMs,
  contentMs,
  isTrimmed,
  audibleMs,
  setStretchedDuration,
  setTrimmedTail,
  setTrimmedHead,
  normalizeFades,
  fadePresetById,
  applyFadePreset,
  matchFadePreset,
  // 导入容错：外部工程（手改 / 第三方生成）缺字段时补齐（卡 t_59ec2202）
  normalizeImportedDoc,
};

})();  // end IIFE — 避免污染全局作用域
