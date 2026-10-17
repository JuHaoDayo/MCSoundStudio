/**
 * audio.js — Web Audio 播放引擎
 *
 * 提供：
 *  - 加载本地音频文件（通过 file:// URL 或 data URL）
 *  - 按音量 / 音高（变速）播放
 *  - 时序调度（在给定毫秒点触发）
 *  - 全局时间轴游标（供 UI 同步 GIF 与播放头）
 *
 * 注意：这里用 AudioBufferSourceNode.playbackRate 实现 pitch。
 * 这与 Minecraft 的 pitch 语义**不完全相同**：
 *   MC 的 pitch 同时改变速度和音高（类似磁带变速），
 *   Web Audio 的 playbackRate 也是同时变速变调，所以听感近似一致。
 */

'use strict';

(function () {

const MCSAudioEngine = (function () {
  let ctx = null;
  const buffers = new Map();        // key: filePath -> AudioBuffer
  let masterGain = null;

  // 播放状态
  let playing = false;
  let startedAt = 0;               // AudioContext 时间基准
  let startOffsetMs = 0;           // 从时间轴的哪个 ms 开始
  let scheduledNodes = [];
  let rafId = null;
  let onTick = null;               // 回调： (currentMs) => void
  let onEnd = null;

  // 预览播放单例：同一时刻只允许一个试听音在响
  let previewHandle = null;

  /** 停掉当前试听（幂等） */
  function stopPreview() {
    if (previewHandle) {
      try { previewHandle.stop(0.02); } catch (e) { /* 已停 */ }
      previewHandle = null;
    }
  }

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 1.0;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function setMasterVolume(v) {
    ensureCtx();
    masterGain.gain.value = v;
  }

  /** 把本地路径转成可 fetch 的 URL */
  function toUrl(filePath) {
    if (!filePath) return null;
    if (filePath.startsWith('data:') || filePath.startsWith('http')) return filePath;
    // Windows 路径 -> file:// URL
    let p = filePath.replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    return 'file://' + encodeURI(p);
  }

  /**
   * 片段几何（条长 / 源内起止 / 倍速）——和 timeline.js 用**同一套** helper。
   * timeline.js 在 index.html 里排在 audio.js 前面，所以正常都能取到；
   * 取不到时退回本地等价实现，避免「加载顺序一变就放错」。
   */
  function geomOf(c) {
    const M = window.MCS;
    if (M && typeof M.contentMs === 'function' && typeof M.rateOf === 'function') {
      return { contentMs: M.contentMs(c), inMs: Math.max(0, c.offsetMs || 0), rate: M.rateOf(c) };
    }
    const rate = (c.pitch != null && Number(c.pitch) > 0) ? Number(c.pitch) : 1;
    const inMs = Math.max(0, c.offsetMs || 0);
    const total = (c.srcDurMs != null && Number(c.srcDurMs) > 0)
      ? Number(c.srcDurMs) : inMs + (c.durationMs || 0) * rate;
    const raw = c.srcEndMs != null ? Number(c.srcEndMs) : total;
    const out = Math.min(Math.max(Number.isFinite(raw) ? raw : total, inMs), total);
    return { contentMs: Math.max(0, out - inMs), inMs, rate };
  }

  /** 加载音频到 buffer 缓存 */
  async function load(filePath) {
    if (buffers.has(filePath)) return buffers.get(filePath);
    ensureCtx();
    const url = toUrl(filePath);
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr);
    buffers.set(filePath, buf);
    return buf;
  }

  /** 探测音频自然时长（ms） */
  async function probeDuration(filePath) {
    try {
      const buf = await load(filePath);
      return Math.round(buf.duration * 1000);
    } catch (e) {
      return null;
    }
  }

  /**
   * 立即播放一个音效（用于试听按钮）。
   * @returns {object} 可 stop() 的句柄
   */
  async function playOne(filePath, opts) {
    const o = opts || {};
    ensureCtx();
    // 单例：先停掉上一个试听
    stopPreview();
    let buf;
    try {
      buf = await load(filePath);
    } catch (e) {
      console.warn('音频加载失败:', filePath, e);
      return null;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o.pitch != null ? o.pitch : 1.0;

    const g = ctx.createGain();
    g.gain.value = o.volume != null ? o.volume : 1.0;

    src.connect(g);
    g.connect(masterGain);

    const offsetSec = (o.offsetMs || 0) / 1000;
    // 试听永远是「播一次」：「循环播放」已在卡 t_6b5016ec 里整体移除
    src.start(0, offsetSec);
    const handle = {
      stop: (fadeSec) => {
        try {
          if (fadeSec && fadeSec > 0) {
            g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
            g.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeSec);
            src.stop(ctx.currentTime + fadeSec);
          } else {
            src.stop();
          }
        } catch (e) { /* already stopped */ }
      },
      /**
       * 变速播放（不改音高）。
       * 原版事件之间只差变体，用微调 rate 就能做出「听感不同」的效果。
       */
      setRate: (r) => { try { src.playbackRate.value = r; } catch (e) { /* */ } },
      /** 改变音量（用于预览时的实时调整） */
      setVolume: (v) => { try { g.gain.value = v; } catch (e) { /* */ } },
    };
    previewHandle = handle;
    return handle;
  }

  /**
   * 播放整条时序。
   * @param clips  时间轴片段数组（需已带 durationMs）
   * @param fromMs 从哪个时间点开始
   */
  function playSequence(clips, fromMs, opts) {
    const o = opts || {};
    ensureCtx();
    stopSequence();

    playing = true;
    startOffsetMs = fromMs || 0;
    startedAt = ctx.currentTime;
    scheduledNodes = [];
    onTick = o.onTick || null;
    onEnd = o.onEnd || null;

    const totalMs = o.totalMs || 60000;

    for (const c of clips) {
      if (c.muted) continue;
      const relMs = c.startMs - startOffsetMs;
      if (relMs < -1) continue;                // 已过去
      const when = startedAt + Math.max(0, relMs) / 1000;

      (async () => {
        // 解析实际要播的文件：
        //   kind='event' → 查原版库拿变体（游戏内随机，这里也随机）
        //   kind='file'  → 直接用 soundPath
        const EV = window.MCS_EVENTS;
        let filePath = c.soundPath;
        let resVol = 1, resPitch = 1;
        if (c.kind === 'event' && c.soundId && EV) {
          const r = EV.resolveForPlayback(c);
          if (!r || !r.absPath) {
            console.warn('事件无可用音频:', c.soundId);
            return;
          }
          filePath = r.absPath;
          resVol = r.volume != null ? r.volume : 1;
          resPitch = r.pitch != null ? r.pitch : 1;
        }
        if (!filePath) return;

        let buf;
        try { buf = await load(filePath); } catch (e) { return; }
        if (!playing) return;

        const src = ctx.createBufferSource();
        src.buffer = buf;
        // 最终 pitch = 事件自身 pitch × 片段 pitch
        const rate = (c.pitch != null ? c.pitch : 1.0) * resPitch;
        src.playbackRate.value = rate;

        // ---- 片段几何：条长 / 源内起止（与 timeline.js 同一套）----
        const geom = geomOf(c);
        const barSec = Math.max(0, c.durationMs || 0) / 1000;
        const contentSec = geom.contentMs / 1000;      // 裁剪后剩下的素材长度（源时间）
        const offsetSec = geom.inMs / 1000;
        // 「声音不得越出片段条」：条长比素材长就静音收尾，比素材短就在条尾切断。
        // （「循环播放」已在卡 t_6b5016ec 里整体移除，这里只剩「播一次」这一条路径）
        const audibleSec = Math.min(barSec, contentSec / rate);

        const g = ctx.createGain();
        const vol = (c.volume != null ? c.volume : 1.0) * resVol;
        g.gain.value = vol;
        src.connect(g);
        g.connect(masterGain);

        // ---- 淡入 / 淡出包络（条内的斜坡；两者之和不超过会响的长度）----
        const finSec = Math.min(Math.max(0, c.fadeInMs || 0) / 1000, audibleSec);
        const foutSec = Math.min(Math.max(0, c.fadeOutMs || 0) / 1000, Math.max(0, audibleSec - finSec));
        if (finSec > 0 || foutSec > 0) {
          const t0 = when;
          const tEnd = t0 + audibleSec;
          if (finSec > 0) {
            g.gain.setValueAtTime(0, t0);
            g.gain.linearRampToValueAtTime(vol, t0 + finSec);
          } else {
            g.gain.setValueAtTime(vol, t0);
          }
          if (foutSec > 0) {
            const tFade = Math.max(t0 + finSec, tEnd - foutSec);
            g.gain.setValueAtTime(vol, tFade);
            g.gain.linearRampToValueAtTime(0, tEnd);
          }
        }

        try {
          // 第三个参数是「播多久」（源时间），再叠一发 stop 兜底：
          // 素材比条长时在条尾切断，比条短时自然结束（不会越过片段条继续响）。
          src.start(when, offsetSec, Math.max(0, contentSec));
          const stopWhen = when + audibleSec;
          if (stopWhen > ctx.currentTime) src.stop(stopWhen);
        } catch (e) {
          // start 时间已过去，忽略
        }
        scheduledNodes.push(src);
      })();
    }

    // 播放头回调
    const tick = () => {
      if (!playing) return;
      const curMs = startOffsetMs + (ctx.currentTime - startedAt) * 1000;
      if (onTick) onTick(Math.min(curMs, totalMs));
      if (curMs >= totalMs) {
        stopSequence();
        if (onEnd) onEnd();
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  /** 当前播放头位置（ms），未播放时返回上次 offset */
  function currentMs() {
    if (!playing || !ctx) return startOffsetMs;
    return Math.max(startOffsetMs, startOffsetMs + (ctx.currentTime - startedAt) * 1000);
  }

  /** 停止前记录位置：暂停后要停在同一时间点 */
  let lastPos = 0;
  function position() {
    return playing ? currentMs() : lastPos;
  }

  function stopSequence() {
    if (playing) lastPos = currentMs();
    playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    for (const s of scheduledNodes) {
      try { s.stop(); } catch (e) { /* ignore */ }
    }
    scheduledNodes = [];
  }

  function isPlaying() { return playing; }
  function currentMs() {
    if (!playing) return startOffsetMs;
    return startOffsetMs + (ctx.currentTime - startedAt) * 1000;
  }

  return {
    ensureCtx,
    setMasterVolume,
    load,
    probeDuration,
    playOne,
    stopPreview,
    playSequence,
    stopSequence,
    currentMs,
    stopPosition: position,
    isPlaying,
  };
})();

window.MCS_AUDIO = MCSAudioEngine;

})();  // end IIFE — 避免污染全局作用域
