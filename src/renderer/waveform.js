// ---------------------------------------------------------------------------
// 波形预览：把解码后的音频缩成一串峰值，画进片段里
//
// 为什么要在轨道里画波形：
//   只靠「色块 + 名字」用户看不出音效长短、哪一段有声音。
//   有了波形就能一眼看出「这个音效是短促一击还是长尾余音」，
//   对齐画面时不用反复试听。
//
// 做法：把 buffer 按目标像素分辨率分桶，每桶取 min/max 峰值，
//   缓存起来（key = 路径 + 分辨率），重绘时直接用，不重复解码。
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  // key: `${filePath}@${buckets}` -> Float32Array pairs [min,max,min,max,...]
  const peakCache = new Map();

  /**
   * 计算峰值
   * @returns {Float32Array|null} 长度 buckets*2，交替存 min / max（-1..1）
   */
  function computePeaks(buffer, buckets) {
    if (!buffer || !buffer.length || buckets <= 0) return null;
    const chCount = buffer.numberOfChannels;
    const len = buffer.length;
    const out = new Float32Array(buckets * 2);

    // 先取第一个声道做主体；多声道时与其它声道取包络最大值，
    // 否则立体声里只在右声道的声音会看不见
    const chans = [];
    for (let c = 0; c < Math.min(chCount, 2); c++) chans.push(buffer.getChannelData(c));

    const per = len / buckets;
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor(b * per);
      const end = Math.min(len, Math.floor((b + 1) * per));
      let mn = 0;
      let mx = 0;
      for (const data of chans) {
        for (let i = start; i < end; i++) {
          const v = data[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      out[b * 2] = mn;
      out[b * 2 + 1] = mx;
    }
    return out;
  }

  /**
   * 取（带缓存的）峰值。AudioEngine.load 是异步解码，这里也异步。
   * 失败返回 null —— 调用方应该画一个「无波形」的占位，不要报错。
   */
  async function getPeaks(filePath, buckets) {
    if (!filePath) return null;
    const key = filePath + '@' + buckets;
    if (peakCache.has(key)) return peakCache.get(key);

    try {
      const buf = await window.MCS_AUDIO.load(filePath);
      const peaks = computePeaks(buf, buckets);
      peakCache.set(key, peaks);
      return peaks;
    } catch (e) {
      peakCache.set(key, null);
      return null;
    }
  }

  /** 同步取缓存（已算过才拿得到，用于重绘时避免闪烁） */
  function getCachedPeaks(filePath, buckets) {
    if (!filePath) return null;
    return peakCache.get(filePath + '@' + buckets) || null;
  }

  /**
   * 把波形画到 canvas 上。
   * 用 canvas 而不是 CSS，因为几千个 div 会拖慢渲染；
   * 一次 drawImage 画完整条更划算。
   */
  function drawWaveform(canvas, peaks, opts) {
    const o = opts || {};
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.round(o.width || canvas.clientWidth || 1));
    const cssH = Math.max(1, Math.round(o.height || canvas.clientHeight || 1));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const mid = cssH / 2;
    // 波形颜色：默认用高对比度的近白色。
    // 之前用 rgba(255,255,255,.55)，在窄片段（<200px）上糊成一片看不清，
    // 用户会以为「这个音效没有波形」。
    const color = o.color || 'rgba(255,255,255,.85)';

    // 中轴线（没有波形数据时也能看出片段范围）
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath();
    ctx.moveTo(0, mid + .5);
    ctx.lineTo(cssW, mid + .5);
    ctx.stroke();

    if (!peaks || !peaks.length) return;

    const n = peaks.length / 2;
    // 像素宽度可能和峰值桶数不等，按比例采样
    const step = n / cssW;
    ctx.fillStyle = color;
    for (let x = 0; x < cssW; x++) {
      const b0 = Math.floor(x * step);
      let mn = 0;
      let mx = 0;
      const b1 = Math.max(b0 + 1, Math.floor((x + 1) * step));
      for (let b = b0; b < b1 && b < n; b++) {
        if (peaks[b * 2] < mn) mn = peaks[b * 2];
        if (peaks[b * 2 + 1] > mx) mx = peaks[b * 2 + 1];
      }
      const yTop = mid - mx * mid * 0.92;
      const yBot = mid - mn * mid * 0.92;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }

    // 片段很窄时上面的逐列采样几乎看不出形状（1~2 像素画不出包络）。
    // 这时改画一条「整体音量轮廓」的实心带，至少能看出有声音、以及起伏趋势。
    if (cssW < 24) {
      const h = peaks.length / 2;
      let gmn = 0;
      let gmx = 0;
      for (let b = 0; b < h; b++) {
        if (peaks[b * 2] < gmn) gmn = peaks[b * 2];
        if (peaks[b * 2 + 1] > gmx) gmx = peaks[b * 2 + 1];
      }
      // 留一点最小可见高度，避免非常安静的音效变成一条线看不见
      const amp = Math.max(Math.abs(gmx), Math.abs(gmn), 0.12);
      const yT = mid - amp * mid * 0.92;
      const yB = mid + amp * mid * 0.92;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, yT, cssW, Math.max(2, yB - yT));
      ctx.globalAlpha = 1;
    }
  }

  window.MCS_WAVE = {
    getPeaks,
    getCachedPeaks,
    drawWaveform,
    computePeaks,
    _cache: peakCache,
  };
})();
