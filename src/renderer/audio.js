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
  const loadingBuffers = new Map(); // key: filePath -> 正在加载的 Promise（并发去重）
  let masterGain = null;

  // 播放状态
  let playing = false;
  let startedAt = 0;               // AudioContext 时间基准
  let startOffsetMs = 0;           // 从时间轴的哪个 ms 开始
  // 播放代数：playSequence 里每个片段的 load() 都是异步的。
  // 冷缓存下 decode 要好几秒；这期间用户可能暂停 / 重新按播放 / 从头放，
  // 旧的一次 playSequence 醒来后若只看 playing 标志（又变回 true 了）就会把
  // 旧位置、旧时基的音源排进新的播放 —— 和拖动试听的迟到补播是同一个根因。
  // 每次 playSequence / stopSequence 都换一代，await 回来必须仍是自己这一代才排音。
  let playGen = 0;
  let scheduledNodes = [];
  // ---- 播放中的实时静音 / 独奏----
  // voices：每个**真实在发声**的音源记录（src + 包络 gain + 静音闸 muteGain）。
  //   静音改写的是 muteGain（只放 0 / 1），淡入淡出包络写在 gain 上，
  //   两者分开，解除静音时包络不会丢。
  // liveMutes：最新一次「片段是否该静音」的快照（clipId -> true/false）。
  //   排音是异步的（要等 decode），所以排音时必须以它为准确认这一刻还该不该出声。
  let voices = [];
  let liveMutes = new Map();
  let rafId = null;
  let onTick = null;               // 回调： (currentMs) => void
  let onEnd = null;

  // 预览播放单例：同一时刻只允许一个试听音在响
  let previewHandle = null;

  // 测试注入的上下文（离线渲染验证用）。生产路径永远是 ensureCtx() 自己创建的那个。
  let ctxExternal = false;

  // ---- 观测日志：最近排过的音源（QA 不看扬声器也能核对"从源内哪一点开始播、播多长"）----
  const DEBUG_LOG_MAX = 200;
  const debugLog = [];
  function logPlay(entry) {
    debugLog.push(Object.assign({ ctxTime: ctx ? Math.round(ctx.currentTime * 1000) / 1000 : null }, entry));
    if (debugLog.length > DEBUG_LOG_MAX) debugLog.splice(0, debugLog.length - DEBUG_LOG_MAX);
  }

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
    // 离线渲染上下文（测试注入）的 state 也是 'suspended'，但 resume() 只能由
    // startRendering() 推进 —— 对离线上下文调 resume() 会抛 InvalidStateError。
    if (!ctxExternal && ctx.state === 'suspended') ctx.resume();
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

  /**
   * 片段在「从 fromMs 起播」这一刻的播放计划 —— playSequence 与拖动试听**共用同一套**。
   *
   * 以前这里是「片段起点已经过去就整条跳过」：播放头停在片段中间再按播放，
   * 那条片段一声都不响（用户听到的就是「从中间放，声音不对/没声」）。
   * 现在改成：从条内已经走过的那一段接着播 —— 源内起播点往后推 elapsedMs × 倍速。
   *
   * 返回 null 表示这一刻不该出声：
   *   - 轨道静音 / 独奏外（调用方已写进 c.muted）
   *   - 片段还没开始（由 delayMs 表示，不返回 null）
   *   - 片段已经播完、素材已经用完、或条长被 0 钳住（remainAudibleMs <= 0）
   *
   * @param c       片段（需带 durationMs；事件片段另需 soundId）
   * @param resVol  事件变体自带音量（非事件 = 1）
   * @param resPitch 事件变体自带 pitch（非事件 = 1）
   * @param fromMs  从时间轴哪一刻起播（绝对 ms）
   */
  function planOfClip(c, resVol, resPitch, fromMs) {
    if (!c || c.muted) return null;
    const geom = geomOf(c);
    const clipRate = (c.pitch != null && Number(c.pitch) > 0) ? Number(c.pitch) : 1;
    const rate = clipRate * (resPitch > 0 ? resPitch : 1);
    if (!(rate > 0)) return null;

    const barMs = Math.max(0, c.durationMs || 0);
    const startMs = Math.max(0, c.startMs || 0);
    const from = Math.max(0, Number(fromMs) || 0);
    // 片段内已经走过的条时间（mid-clip 起播时 > 0）/ 片段还没开始时的等待时间
    const elapsedMs = Math.max(0, from - startMs);
    const delayMs = Math.max(0, startMs - from);
    // 从条头算起会响多久（条长 / 素材 / 倍速 三者钳制，与 timeline 的 audibleMs 同义）
    const audibleMs = Math.min(barMs, geom.contentMs / rate);
    // 从起播点算起还剩多久会响
    const remainAudibleMs = audibleMs - elapsedMs;
    if (!(remainAudibleMs > 0.5)) return null;

    // 源内起播点：条头对应 inMs，条时间每过 1ms 源时间前进 rate ms
    const offsetMs = geom.inMs + elapsedMs * rate;
    // 还能从源里取出多少素材（源时间 ms；实际墙钟时长 = 它 / rate）
    const playMs = Math.max(0, geom.contentMs - elapsedMs * rate);
    const vol = (c.volume != null ? Number(c.volume) : 1) * (resVol > 0 ? resVol : 1);

    return {
      clipId: c.id,
      label: c.label || '',
      delayMs,
      offsetMs,
      playMs,
      rate,
      vol,
      elapsedMs,
      audibleMs,
      remainAudibleMs,
      finMs: Math.max(0, Number(c.fadeInMs) || 0),
      foutMs: Math.max(0, Number(c.fadeOutMs) || 0),
    };
  }

  /**
   * 把片段的淡入 / 淡出包络写到 gain 上（t0 = 这个音源的起播时刻）。
   * mid-clip 起播时起播点可能已经落在淡入斜坡里 —— 那就从当时的音量补完斜坡，
   * 不能突然满音量（那一声正是用户说的"爆音"）。
   */
  function applyEnvelope(g, plan, t0) {
    const vol = plan.vol;
    const leftSec = plan.remainAudibleMs / 1000;
    const endAt = t0 + leftSec;
    const finSec = Math.min(plan.finMs / 1000, plan.audibleMs / 1000);
    const foutSec = Math.min(plan.foutMs / 1000, Math.max(0, plan.audibleMs / 1000 - finSec));
    const elSec = plan.elapsedMs / 1000;

    let rampEnd = 0;
    if (finSec > 0 && elSec < finSec) {
      const left = Math.min(finSec - elSec, leftSec);
      g.gain.setValueAtTime(vol * Math.max(0, elSec / finSec), t0);
      g.gain.linearRampToValueAtTime(vol, t0 + left);
      rampEnd = left;
    } else {
      g.gain.setValueAtTime(vol, t0);
    }
    if (foutSec > 0) {
      const tFade = Math.max(t0 + rampEnd, endAt - foutSec);
      if (tFade > t0 && endAt > tFade) {
        g.gain.setValueAtTime(vol, tFade);
        g.gain.linearRampToValueAtTime(0, endAt);
      }
    }
  }

  /** 加载音频到 buffer 缓存 */
  function load(filePath) {
    if (buffers.has(filePath)) return Promise.resolve(buffers.get(filePath));
    // 并发去重：拖动试听时同一文件会被连发调用，
    // 若不去重就会同时 fetch + decode 十几份同样的音频 —— 拖一下就卡、还堆内存。
    if (loadingBuffers.has(filePath)) return loadingBuffers.get(filePath);
    ensureCtx();
    const url = toUrl(filePath);
    const p = (async () => {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(arr);
      buffers.set(filePath, buf);
      return buf;
    })();
    loadingBuffers.set(filePath, p);
    p.catch(() => {}).then(() => loadingBuffers.delete(filePath));
    return p;
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
    // 试听永远是「播一次」：「循环播放」已在里整体移除
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
   * 排一个片段的音源 —— playSequence 与「播放中解除静音」共用同一套。
   *
   * @param c       片段（muted 已由调用方算好）
   * @param fromMs  这一代播放的时间轴起点（ms）
   * @param gen     播放代数：await 回来必须仍是自己这一代才允许排音
   * @param clockAt 这一代的音频时钟起点（ctx.currentTime）
   * @returns 音源记录；排不上（无文件 / 已过期 / 此刻不该响）返回 null
   */
  async function scheduleClip(c, fromMs, gen, clockAt) {
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
        return null;
      }
      filePath = r.absPath;
      resVol = r.volume != null ? r.volume : 1;
      resPitch = r.pitch != null ? r.pitch : 1;
    }
    if (!filePath) return null;

    let buf;
    try { buf = await load(filePath); } catch (e) { return null; }
    // 等 buffer 的这段时间里可能已经停了 / 又开了新的一次播放：
    // 只有「还在播 + 仍是自己这一代」才允许排音
    if (!playing || gen !== playGen) return null;

    // await 期间可能刚好播完 / 用户改了片段 / 又点了静音：排程前用真实变体参数再算一次
    const plan = planOfClip(c, resVol, resPitch, fromMs);
    if (!plan) return null;

    const t0 = clockAt + plan.delayMs / 1000;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    // 最终 pitch = 事件自身 pitch × 片段 pitch
    src.playbackRate.value = plan.rate;

    // 两条 gain 分工：
    //   g  = 片段音量 + 淡入淡出包络（排程时写死，不参与静音）
    //   mg = 静音闸，只放 0 / 1；播放中按 M/S 实时改写它，包络不会被破坏
    const g = ctx.createGain();
    g.gain.value = plan.vol;
    const mg = ctx.createGain();
    const startMuted = !!liveMutes.get(c.id);
    mg.gain.value = startMuted ? 0 : 1;

    src.connect(g);
    g.connect(mg);
    mg.connect(masterGain);

    // 包络按「从条头算起」的淡入淡出来排；mid-clip 起播时从斜坡中间接上
    applyEnvelope(g, plan, t0);

    try {
      // 第三个参数是「播多久」（源时间），再叠一发 stop 兜底：
      // 素材比条长时在条尾切断，比条短时自然结束（不会越过片段条继续响）。
      src.start(t0, plan.offsetMs / 1000, plan.playMs / 1000);
      const stopWhen = t0 + plan.remainAudibleMs / 1000;
      if (stopWhen > ctx.currentTime) src.stop(stopWhen);
    } catch (e) {
      // start 时间已过去，忽略
    }
    const voice = { src, gain: g, muteGain: mg, clipId: c.id, muted: startMuted, ended: false };
    src.onended = () => { voice.ended = true; };
    voices.push(voice);
    scheduledNodes.push(src);
    logPlay({
      kind: 'sequence',
      clipId: c.id,
      fromMs: Math.round(fromMs),
      delayMs: Math.round(plan.delayMs),
      offsetMs: Math.round(plan.offsetMs),
      playMs: Math.round(plan.playMs),
      audibleLeftMs: Math.round(plan.remainAudibleMs),
      rate: plan.rate,
      muted: startMuted,
    });
    return voice;
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

    // 本次播放的身份：stopSequence() 刚换过一代，这里再 +1 就是本次的代号
    const gen = ++playGen;
    playing = true;
    startOffsetMs = fromMs || 0;
    startedAt = ctx.currentTime;
    scheduledNodes = [];
    voices = [];
    liveMutes = new Map();
    onTick = o.onTick || null;
    onEnd = o.onEnd || null;

    const totalMs = o.totalMs || 60000;

    for (const c of clips) {
      // 静音 / 独奏外 / 这一刻肯定听不到的，先不排（省掉事件变体的随机解析）。
      // 播放中解除静音时由 applyClipMutes() 从现在这一刻补排。
      if (!planOfClip(c, 1, 1, startOffsetMs)) continue;
      scheduleClip(c, startOffsetMs, gen, startedAt);
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
    // 换代：停掉之后，任何还挂在 load() 上的旧排程醒来都不许再排音
    playGen++;
    if (playing) lastPos = currentMs();
    playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    for (const s of scheduledNodes) {
      try { s.stop(); } catch (e) { /* ignore */ }
    }
    scheduledNodes = [];
    voices = [];
    liveMutes = new Map();
    // 停止/暂停顺手收掉拖动试听：任何"传输控制说了停"的时刻都不许还留着拖动的声音
    stopScrub(0.02);
  }

  /**
   * 把最新的「片段该不该响」写进正在播放的音频链。
   *
   * 播放中按 M / S 必须**立刻**听得出来，而不是只换按钮状态：
   *   1) 已在发声的音源 → 改它自己的静音闸 muteGain（20ms 斜坡，不会"咔"），
   *      包络 gain 不动，所以解除静音后淡入淡出仍然按原样走；
   *      恢复时一律回到 1（不是把当前值乘回来），连点 M/S 不会叠加衰减。
   *   2) 播放前就静音、当初没排音的片段，解除静音时从「现在这一刻」补排，
   *      补排也走 scheduleClip 同一套几何（mid-clip 起播从源内对应位置接上）。
   *   3) 片段已经不在工程里（删轨 / 删片段 / 撤销）→ 淡出后掐掉，不留残响。
   *
   * @param clips 已算好 muted 的片段表（app.js 的 clipsForPlayback()，轨道静音/独奏已折算）
   * @returns 观测用摘要（QA/自测核对路由与增益真的变了）
   */
  function applyClipMutes(clips) {
    const list = clips || [];
    const state = new Map();
    for (const c of list) { if (c && c.id != null) state.set(c.id, !!c.muted); }
    liveMutes = state;
    const out = { playing, atMs: null, muted: [], unmuted: [], late: [], killed: [] };
    if (!playing || !ctx) return out;

    const now = ctx.currentTime;
    const fromMs = currentMs();
    out.atMs = Math.round(fromMs);

    // 1) 已在发声的音源：只动静音闸
    for (const v of voices) {
      if (v.ended) continue;
      if (!state.has(v.clipId)) {
        // 片段已不在工程里：淡出 20ms 后收掉
        try {
          const p = v.muteGain.gain;
          p.cancelScheduledValues(now);
          p.setValueAtTime(p.value, now);
          p.linearRampToValueAtTime(0, now + 0.02);
          v.src.stop(now + 0.03);
        } catch (e) { /* 已停 */ }
        v.ended = true;
        out.killed.push(v.clipId);
        continue;
      }
      const wantMuted = state.get(v.clipId);
      if (v.muted === wantMuted) continue;
      v.muted = wantMuted;
      try {
        const p = v.muteGain.gain;
        if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(now);
        else { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); }
        p.linearRampToValueAtTime(wantMuted ? 0 : 1, now + 0.02);
      } catch (e) { /* 上下文已关闭 */ }
      (wantMuted ? out.muted : out.unmuted).push(v.clipId);
    }
    voices = voices.filter((v) => !v.ended);

    // 2) 解除静音但当初没排过（播放前就静音的片段）：从现在这一刻补排
    for (const c of list) {
      if (!c || c.muted || c.id == null) continue;
      if (voices.some((v) => v.clipId === c.id)) continue;
      // 这一刻本来就听不到（还没开始 / 已经播完 / 素材用完）→ 不用排
      if (!planOfClip(c, 1, 1, fromMs)) continue;
      scheduleClip(c, fromMs, playGen, now);
      out.late.push(c.id);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 拖动试听（scrub）
  //
  // 需求：
  //   - 按住标尺拖播放头，往前 / 往后都停在手上那个点，并且**当时就能听到那个位置的声音**；
  //   - 松手立刻停（不是"点一下从头放"，也不是"松手后还余一段在响"）；
  //   - 拖得快 = 快速扫过（短颗粒一个接一个），拖得慢 = 几乎连续地听 —— 速度和方向
  //     自然决定你能听清多少细节；
  //   - 多轨叠加 / 静音独奏 / 裁剪 / 0.5x 变速 / 主音量 / 片段边界 / 无音频区 全部照常生效
  //     （几何一律走 planOfClip，和正常播放同一套，不另写一份）。
  //
  // 实现要点（为什么这么写）：
  //   1) 每次移动不无脑排一个新音源 —— 那样快速拖动会堆出几十个音源，声音糊成一片还爆音。
  //      scrubAt 先算"手上的位置"和"声音如果一直在播应该到哪儿"的差（drift）：
  //      差得少（<70ms）就什么都不做，让它自己连续播下去；差得多才重排。重排时旧颗粒
  //      8ms 淡出后 stop，所以最多只有一两个颗粒重叠，不会累积。
  //   2) 每个颗粒最多 SCRUB_GRAIN_MS，自带 4ms 淡入 / 12ms 淡出 —— 硬切会"咔"。
  //   3) 整个拖动会话挂在一条 scrub 总线上（scrumStop 时整条淡出再断开），
  //      松手后即使有音源还排着也一定归零 —— 不会"松手了还有声音"。
  //   4) 总线后面串一个只压 0dBFS 以上的限幅器：多轨同时拖也不会数字削波（爆音）。
  // -------------------------------------------------------------------------
  const SCRUB_GRAIN_MS = 220;        // 单个颗粒最长多少毫秒
  const SCRUB_MIN_DRIFT_MS = 70;     // 手和"声音应该到哪儿"差多少才值得重排
  const SCRUB_KILL_FADE_SEC = 0.008; // 重排时旧颗粒的淡出时长
  const SCRUB_FADE_IN_SEC = 0.004;   // 颗粒淡入（去"咔"）
  const SCRUB_FADE_OUT_SEC = 0.012;  // 颗粒淡出
  const SCRUB_MAX_VOICES = 64;       // 兜底上限：再多就先把最老的掐掉

  let scrub = null;                  // 当前拖动会话
  let scrubLimiter = null;           // 0dBFS 限幅器（只对拖动试听这条链）

  /** 把一颗粒淡出后掐掉（幂等） */
  function killVoice(v, t, fadeSec) {
    if (!v || v.killed) return;
    v.killed = true;
    const p = v.gain.gain;
    try {
      if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
      else { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); }
      if (fadeSec > 0) {
        p.linearRampToValueAtTime(0, t + fadeSec);
        v.src.stop(t + fadeSec);
      } else {
        p.setValueAtTime(0, t);
        v.src.stop(t);
      }
    } catch (e) { /* 已经停过 / 上下文已关闭 */ }
  }

  /** 拖动试听的总线尽头：限幅器 → 主音量。全部接在 masterGain 前面，主音量照样管用 */
  function ensureScrubLimiter() {
    ensureCtx();
    if (!scrubLimiter) {
      scrubLimiter = ctx.createDynamicsCompressor();
      // 阈值 0dBFS、几乎不拐弯、20:1：正常电平完全不动，只有叠加到削波时才压
      try {
        scrubLimiter.threshold.value = 0;
        scrubLimiter.knee.value = 0;
        scrubLimiter.ratio.value = 20;
        scrubLimiter.attack.value = 0.003;
        scrubLimiter.release.value = 0.25;
      } catch (e) { /* 老实现缺这些参数就退回默认 */ }
      scrubLimiter.connect(masterGain);
    }
    return scrubLimiter;
  }

  /** 开始一次拖动试听会话（按下标尺时调） */
  function scrubStart() {
    ensureCtx();
    // 每次按下都是一次**全新会话**：
    // 上一次若没正常收尾（松在窗口外、失焦没走到 endScrub），或者它的冷缓存 load
    // 还没回来，复用同一个会话对象会让旧请求误以为「会话还活着」，把旧位置的
    // 颗粒排进新的一次拖动（跨会话串音）。先按旧逻辑淡出收掉，再建新对象。
    if (scrub) stopScrub(0.008);
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(ensureScrubLimiter());
    const now = ctx.currentTime;
    scrub = {
      bus,
      anchorMs: 0, anchorAt: now,
      lastMs: 0, lastAt: now,
      voices: [],
      grains: 0,
      stopped: false,
      seq: 0,          // 本会话内的请求序号（每决定重排一次 +1）
    };
    return { ok: true };
  }

  /** 排一个颗粒：从 plan 的源内起播点取一小段，自带淡入淡出 */
  function scheduleGrain(bus, plan, buf, when, grainMs) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = plan.rate;
    const g = ctx.createGain();
    const sec = Math.max(0.01, grainMs / 1000);
    const vol = plan.vol;
    const fin = Math.min(SCRUB_FADE_IN_SEC, sec / 3);
    const fout = Math.min(SCRUB_FADE_OUT_SEC, sec / 3);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + fin);
    g.gain.setValueAtTime(vol, Math.max(when + fin, when + sec - fout));
    g.gain.linearRampToValueAtTime(0, when + sec);
    src.connect(g);
    g.connect(bus);
    const playMs = Math.min(plan.playMs, grainMs * plan.rate);
    try {
      src.start(when, plan.offsetMs / 1000, Math.max(0, playMs) / 1000);
      src.stop(when + sec + 0.002);
    } catch (e) {
      return null;
    }
    return { src, gain: g, endAt: when + sec + 0.002, killed: false, plan };
  }

  /**
   * 拖动中：把试听定位到 ms。
   * @returns Promise<{scheduled, reason?, atMs, grains:[{clipId, offsetMs, grainMs, rate}]}>
   */
  async function scrubAt(clips, ms, opts) {
    if (!scrub || scrub.stopped) return { scheduled: false, reason: 'no-session', grains: [] };
    ensureCtx();
    // 会话身份：冷缓存下 load() 可能要好几秒，拖动期间连发的
    // 多个 scrubAt 会一起挂在同一个 decode 上。下面所有 await 之后都必须先确认
    // 「还是这个会话、而且自己仍是这个会话里最新的一次请求」，否则丢弃、不排音。
    const session = scrub;
    const o = opts || {};
    const now = ctx.currentTime;
    const at = Math.max(0, Math.round(Number(ms) || 0));
    const grainMs = Math.max(60, Number(o.grainMs) || SCRUB_GRAIN_MS);

    // ---- 同步段：判定要不要重排（必须在任何 await 之前完成，否则连发的 mousemove 会都穿过去）----
    const live = session.voices.some((v) => !v.killed && v.endAt > now + 0.004);
    const predicted = session.anchorMs + (now - session.anchorAt) * 1000;
    const drift = at - predicted;
    const prevMs = session.lastMs;
    const dt = Math.max(1, (now - session.lastAt) * 1000);
    const dir = at > prevMs ? 1 : (at < prevMs ? -1 : 0);
    // 拖动速度（时间轴 ms / 实耗 ms）。≈1 = 手正好按播放速度走，>1 = 快速扫过
    const speed = Math.abs(at - prevMs) / dt;
    session.lastMs = at;
    session.lastAt = now;

    if (live && Math.abs(drift) < SCRUB_MIN_DRIFT_MS) {
      return { scheduled: false, reason: 'coalesced', atMs: at, dir, speed: Math.round(speed * 100) / 100, grains: [] };
    }

    // 本次是「一次新的重排决定」→ 序号 +1，并作废这个会话里还在 await 的旧请求
    const reqSeq = ++session.seq;

    session.anchorMs = at;
    session.anchorAt = now;
    // 旧颗粒 8ms 淡出后掐掉 —— 这是「不堆积」的关键：先停旧的，再排新的
    for (const v of session.voices) killVoice(v, now, SCRUB_KILL_FADE_SEC);
    session.voices = session.voices.filter((v) => !v.killed || v.endAt > now + SCRUB_KILL_FADE_SEC + 0.001);
    if (session.voices.length > SCRUB_MAX_VOICES) {
      for (const v of session.voices.slice(0, session.voices.length - SCRUB_MAX_VOICES)) killVoice(v, now, SCRUB_KILL_FADE_SEC);
      session.voices = session.voices.slice(-SCRUB_MAX_VOICES);
    }

    // ---- 解析这一刻在响的片段（与 playSequence 同一套：事件变体 / 轨道静音已由调用方写进 muted）----
    const jobs = [];
    for (const c of (clips || [])) {
      if (!c || c.muted) continue;
      let filePath = c.soundPath;
      let resVol = 1, resPitch = 1;
      if (c.kind === 'event' && c.soundId) {
        const EV = window.MCS_EVENTS;
        if (!EV) continue;
        const r = EV.resolveForPlayback(c);
        if (!r || !r.absPath) continue;
        filePath = r.absPath;
        resVol = r.volume != null ? r.volume : 1;
        resPitch = r.pitch != null ? r.pitch : 1;
      }
      if (!filePath) continue;
      const plan = planOfClip(c, resVol, resPitch, at);
      if (!plan) continue;                       // 这一刻不在任何片段里 = 无音频区，静音
      // 还没开始的片段不试听（拖动只听"此刻正在响的"；未来的片段留给正常播放去等）
      if (plan.delayMs > 0.5) continue;
      jobs.push({ plan, filePath });
    }

    // 这一刻没有可听片段（无音频区 / 静音 / 已播完）：立即记一笔就返回，不等解码。
    // 冷缓存下拖到无音频区时不会挂着一个 await，也不会在解码完成后补出旧位置的声音。
    if (!jobs.length) {
      // 照样记一笔（否则 QA 分不清"没声音"是应该的还是没有）
      logPlay({ kind: 'scrub', atMs: at, dir, speed: Math.round(speed * 100) / 100, seq: reqSeq, silent: true, grains: [] });
      return { scheduled: true, reason: 'silent', atMs: at, dir, speed: Math.round(speed * 100) / 100, grains: [] };
    }

    const buffers = await Promise.all(jobs.map((j) => load(j.filePath).catch(() => null)));

    // ---- await 之后：只认「当前会话 + 本会话最新请求」（的根因修复）----
    // 1) 松手 / 传输控制把会话停掉了，或期间又按下了新的一次拖动（scrub 已是别的对象）
    //    —— 旧 decode 醒来不许把声音排进新会话。
    if (!scrub || scrub !== session || session.stopped) {
      return { scheduled: false, reason: 'session-ended', atMs: at, grains: [] };
    }
    // 2) 会话还在，但之后又发生过一次重排决定（seq 已经更大）：本次代表的是旧位置，
    //    直接丢弃；否则就会出现「手已经拖到片段外/别处，解码一结束却在旧 offset 补播」。
    if (session.seq !== reqSeq) {
      logPlay({
        kind: 'scrub', atMs: at, dir, speed: Math.round(speed * 100) / 100, seq: reqSeq,
        stale: true, reason: 'superseded', currentSeq: session.seq, grains: [],
      });
      return { scheduled: false, reason: 'superseded', atMs: at, dir, speed: Math.round(speed * 100) / 100, grains: [] };
    }

    const when = Math.max(ctx.currentTime, now) + 0.012;   // 一点预约量：等 buffer 就绪也不迟到
    const grains = [];
    for (let i = 0; i < jobs.length; i++) {
      const buf = buffers[i];
      if (!buf) continue;
      const plan = jobs[i].plan;
      const gMs = Math.min(grainMs, plan.remainAudibleMs);
      const v = scheduleGrain(session.bus, plan, buf, when, gMs);
      if (!v) continue;
      session.voices.push(v);
      session.grains++;
      grains.push({
        clipId: plan.clipId,
        atMs: at,
        offsetMs: Math.round(plan.offsetMs),
        grainMs: Math.round(gMs),
        rate: plan.rate,
        vol: Math.round(plan.vol * 1000) / 1000,
      });
    }
    logPlay({ kind: 'scrub', atMs: at, dir, speed: Math.round(speed * 100) / 100, seq: reqSeq, grains });
    return { scheduled: true, atMs: at, dir, speed: Math.round(speed * 100) / 100, grains };
  }

  /**
   * 结束拖动试听：整条总线 30ms 淡出，颗粒全部掐掉，再断开总线。
   * 幂等；松手 / 窗口失焦 / 开始正常播放都会走到这里。
   */
  function stopScrub(fadeSec) {
    if (!scrub) return { stopped: false };
    const s = scrub;
    scrub = null;
    s.stopped = true;
    const fade = Math.max(0, fadeSec == null ? 0.03 : Number(fadeSec));
    const now = ctx ? ctx.currentTime : 0;
    for (const v of s.voices) killVoice(v, now, fade);
    s.voices = [];
    if (ctx && s.bus) {
      try {
        const b = s.bus;
        b.gain.setValueAtTime(b.gain.value, now);
        b.gain.linearRampToValueAtTime(0, now + fade);
        setTimeout(() => { try { b.disconnect(); } catch (e) { /* 已断开 */ } }, Math.ceil(fade * 1000) + 150);
      } catch (e) { /* 上下文已关闭 */ }
    }
    logPlay({ kind: 'scrub-stop', fadeSec: fade });
    return { stopped: true, voices: s.grains };
  }

  function isScrubbing() { return !!scrub; }

  /** 观测钩子：最近排过的音源 + 当前拖动会话状态（QA 不看扬声器也能核对） */
  function debugStats() {
    return {
      ctxTime: ctx ? Math.round(ctx.currentTime * 1000) / 1000 : null,
      playing,
      scrubbing: !!scrub,
      scrubVoices: scrub ? scrub.voices.filter((v) => !v.killed).length : 0,
      // 播放中的实时静音观测：每个在发声的源挂在哪个片段、静音闸现值
      voices: voices.filter((v) => !v.ended).map((v) => ({
        clipId: v.clipId,
        muted: !!v.muted,
        muteGain: v.muteGain ? Math.round(v.muteGain.gain.value * 1000) / 1000 : null,
        gain: v.gain ? Math.round(v.gain.gain.value * 1000) / 1000 : null,
      })),
      log: debugLog.slice(-80),
    };
  }

  /**
   * 测试专用：把引擎切到外部上下文（离线渲染用 OfflineAudioContext）。
   * 只换上下文，不改任何播放语义；生产代码永远不会调它。
   */
  function useContextForTest(c) {
    if (!c) return false;
    try { stopSequence(); } catch (e) { /* */ }
    ctx = c;
    ctxExternal = true;
    masterGain = ctx.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(ctx.destination);
    scrubLimiter = null;
    voices = [];
    liveMutes = new Map();
    debugLog.length = 0;
    return true;
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
    // 播放中实时静音 / 独奏
    applyClipMutes,
    currentMs,
    stopPosition: position,
    isPlaying,
    // 拖动试听
    scrubStart,
    scrubAt,
    stopScrub,
    isScrubbing,
    debugStats,
    // 测试钩子（离线渲染验证用；生产代码不调用）
    _useContextForTest: useContextForTest,
    _planOfClipForTest: planOfClip,
    _envelopeForTest: applyEnvelope,
    // 测试钩子：拿到主音量节点，用来挂 AnalyserNode 做真实电平测量（自测）
    _masterGainForTest: () => masterGain,
  };
})();

window.MCS_AUDIO = MCSAudioEngine;

})();  // end IIFE — 避免污染全局作用域
