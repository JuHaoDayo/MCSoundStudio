/**
 * gif.js — 真正的 GIF 解析器 + 逐帧播放控制
 *
 * 为什么不用 <img>：浏览器对 GIF 没有 API 能暂停 / seek。
 * 为什么不全文件扫字节找 0x21F904：那些字节会出现在 LZW 压缩数据里，
 *   被误判成帧头 —— 实测在一个 170 帧的 GIF 上会数出假的帧和
 *   295620ms 这种离谱的延迟，直接让播放逻辑崩掉。
 *   必须严格按 GIF 块结构遍历，并真正 LZW 解码像素，才能做到 seek。
 *
 * 能力：
 *   - 解析帧延迟 → 精确 seek（往回拉也能倒退）
 *   - 暂停时停在当前帧
 *   - 报告真实总时长 / 帧数
 *
 * 支持 GIF87a / GIF89a 的交错与非交错、局部调色板、透明色、处置方式。
 * 不支持的扩展块（注释、应用扩展、纯文本）会被正确跳过而不是误读。
 */
(function () {
  'use strict';

  const MAX_LZW_CODE = 4096;

  // -------------------------------------------------------------------------
  // LZW 解码（GIF 变体：码长可变，clear / end 码）
  // -------------------------------------------------------------------------
  function lzwDecode(minCodeSize, data, pixelCount) {
    const out = new Uint8Array(pixelCount);
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;

    let codeSize = minCodeSize + 1;
    let codeMask = (1 << codeSize) - 1;
    let nextCode = endCode + 1;

    // 字典：前缀码 + 尾字节 + 首字节（用于 KwKwK）
    const prefix = new Int32Array(MAX_LZW_CODE);
    const suffix = new Uint8Array(MAX_LZW_CODE);
    const firstByte = new Uint8Array(MAX_LZW_CODE);
    const pixelStack = new Uint8Array(MAX_LZW_CODE + 1);

    for (let i = 0; i < clearCode; i++) {
      prefix[i] = -1;
      suffix[i] = i;
      firstByte[i] = i;
    }

    let datum = 0, bits = 0, pos = 0, outPos = 0;
    let top = 0;
    let lastCode = -1;

    while (outPos < pixelCount) {
      if (bits < codeSize) {
        if (pos >= data.length) {
          while (outPos < pixelCount) out[outPos++] = 0;   // 容错补齐
          break;
        }
        datum |= data[pos++] << bits;
        bits += 8;
        continue;
      }

      const code = datum & codeMask;
      datum >>= codeSize;
      bits -= codeSize;

      if (code === clearCode) {
        codeSize = minCodeSize + 1;
        codeMask = (1 << codeSize) - 1;
        nextCode = endCode + 1;
        lastCode = -1;
        continue;
      }
      if (code === endCode) break;

      let curCode = code;
      if (lastCode === -1) {
        out[outPos++] = suffix[curCode];
        lastCode = curCode;
        continue;
      }

      if (curCode >= nextCode) {
        // KwKwK 情形
        pixelStack[top++] = firstByte[lastCode];
        curCode = lastCode;
      }

      let guard = 0;
      while (curCode >= clearCode && guard++ < MAX_LZW_CODE) {
        pixelStack[top++] = suffix[curCode];
        curCode = prefix[curCode];
        if (curCode < 0) break;
      }
      if (curCode < 0) break;
      pixelStack[top++] = suffix[curCode];
      const fb = suffix[curCode];

      if (nextCode < MAX_LZW_CODE) {
        prefix[nextCode] = lastCode;
        suffix[nextCode] = fb;
        firstByte[nextCode] = firstByte[lastCode];
        nextCode++;
        if (nextCode > codeMask && codeSize < 12) {
          codeSize++;
          codeMask = (1 << codeSize) - 1;
        }
      }

      while (top > 0 && outPos < pixelCount) out[outPos++] = pixelStack[--top];
      top = 0;
      lastCode = code;
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // 主解析器
  // -------------------------------------------------------------------------
  function parseGif(buffer) {
    const bytes = new Uint8Array(buffer);
    let p = 0;

    const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
    if (sig !== 'GIF89a' && sig !== 'GIF87a') {
      throw new Error('不是 GIF 文件（标识：' + sig + '）');
    }
    p = 6;

    const width = bytes[p] | (bytes[p + 1] << 8); p += 2;
    const height = bytes[p] | (bytes[p + 1] << 8); p += 2;
    const packed = bytes[p++];
    const bgIndex = bytes[p++];
    const globalAspect = bytes[p++];

    const gctFlag = (packed & 0x80) !== 0;
    const gctSize = 1 << ((packed & 0x07) + 1);
    let globalPalette = null;
    if (gctFlag) {
      globalPalette = bytes.subarray(p, p + gctSize * 3);
      p += gctSize * 3;
    }

    function readSubBlocks() {
      const chunks = [];
      let total = 0;
      for (;;) {
        if (p >= bytes.length) break;
        const len = bytes[p++];
        if (len === 0) break;
        chunks.push(bytes.subarray(p, p + len));
        total += len;
        p += len;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    }

    const frames = [];
    let pendingGce = null;

    for (;;) {
      if (p >= bytes.length) break;
      const block = bytes[p++];

      if (block === 0x3B) break;              // Trailer

      if (block === 0x21) {                    // Extension
        if (p >= bytes.length) break;
        const label = bytes[p++];

        if (label === 0xF9) {                  // Graphic Control Extension
          const size = bytes[p++];
          if (size === 4) {
            const flags = bytes[p];
            const delay = bytes[p + 1] | (bytes[p + 2] << 8);
            const transparentIndex = bytes[p + 3];
            p += 4;
            pendingGce = {
              disposal: (flags >> 2) & 0x07,
              transparent: (flags & 0x01) !== 0,
              transparentIndex,
              delay,
            };
          } else {
            p += size;
          }
          while (p < bytes.length && bytes[p] !== 0) p++;   // 终止子块
          p++;
        } else {
          // 注释 / 应用扩展 / 纯文本：按子块结构跳过
          readSubBlocks();
        }
        continue;
      }

      if (block === 0x2C) {                    // Image Descriptor
        const left = bytes[p] | (bytes[p + 1] << 8); p += 2;
        const top = bytes[p] | (bytes[p + 1] << 8); p += 2;
        const fw = bytes[p] | (bytes[p + 1] << 8); p += 2;
        const fh = bytes[p] | (bytes[p + 1] << 8); p += 2;
        const fpacked = bytes[p++];

        const lctFlag = (fpacked & 0x80) !== 0;
        const interlaced = (fpacked & 0x40) !== 0;
        const lctSize = 1 << ((fpacked & 0x07) + 1);

        let palette = globalPalette;
        if (lctFlag) {
          palette = bytes.subarray(p, p + lctSize * 3);
          p += lctSize * 3;
        }
        if (!palette) throw new Error('第 ' + (frames.length + 1) + ' 帧缺少调色板');
        if (fw === 0 || fh === 0) { readSubBlocks(); continue; }

        const minCodeSize = bytes[p++];
        if (minCodeSize > 11) { readSubBlocks(); continue; }
        const lzwData = readSubBlocks();
        const pixels = lzwDecode(minCodeSize, lzwData, fw * fh);

        const gce = pendingGce || { disposal: 0, transparent: false, transparentIndex: -1, delay: 0 };
        pendingGce = null;

        frames.push({
          left, top, width: fw, height: fh,
          interlaced,
          palette: palette.slice(),
          pixels,
          delay: gce.delay,
          disposal: gce.disposal,
          transparent: gce.transparent,
          transparentIndex: gce.transparentIndex,
        });
        continue;
      }

      // 未知块：无法安全推断长度，停止解析（避免读飞）
      break;
    }

    // 延迟规范化：
    //  - delay 为 0（很多导出器写 0）按规范视为"尽快"，浏览器实际用 100ms
    //  - 浏览器会把 <20ms 的延迟钳制为 100ms，这里保持一致
    const normalized = frames.map((f) => {
      let d = f.delay * 10;          // 1/100 秒 → ms
      if (d < 20) d = 100;
      return Object.assign({}, f, { delayMs: d });
    });

    let t = 0;
    const starts = normalized.map((f) => { const s = t; t += f.delayMs; return s; });

    return {
      width, height,
      frames: normalized,
      frameCount: normalized.length,
      totalMs: t,
      bgIndex,
      globalAspect,
      starts,
    };
  }

  // -------------------------------------------------------------------------
  // 渲染：把某一帧画到 canvas（正确处理 disposal，支持任意顺序 seek）
  // -------------------------------------------------------------------------
  function makeRenderer(canvas, gif) {
    const ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = gif.width;
    canvas.height = gif.height;

    const buf = document.createElement('canvas');
    buf.width = gif.width;
    buf.height = gif.height;
    const bctx = buf.getContext('2d', { alpha: false });

    // 背景色取全局调色板里的 bgIndex
    const bg = [0, 0, 0];
    if (gif.bgIndex >= 0 && gif.frames[0]) {
      const p0 = gif.frames[0].palette;
      bg[0] = p0[gif.bgIndex * 3] || 0;
      bg[1] = p0[gif.bgIndex * 3 + 1] || 0;
      bg[2] = p0[gif.bgIndex * 3 + 2] || 0;
    }
    const bgStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;

    // 每帧的 ImageData 预先算好（大 GIF 很值得，避免 seek 时反复解码）
    const cache = new Array(gif.frames.length).fill(null);

    function imageDataFor(i) {
      if (cache[i]) return cache[i];
      const f = gif.frames[i];
      const img = new ImageData(f.width, f.height);
      const d = img.data;
      const pal = f.palette;

      for (let y = 0; y < f.height; y++) {
        let row = y;
        if (f.interlaced) {
          const h = f.height;
          const p1 = Math.ceil(h / 8);
          const p2 = Math.ceil((h - 4) / 8);
          const p3 = Math.ceil((h - 2) / 4);
          const p4 = Math.ceil((h - 1) / 4);
          if (y % 8 === 0) row = (y >> 3);
          else if (y % 8 === 4) row = p1 + ((y - 4) >> 3);
          else if (y % 8 === 2) row = p1 + p2 + ((y - 2) >> 2);
          else if (y % 8 === 6) row = p1 + p2 + p3 + ((y - 6) >> 2);
          else row = p1 + p2 + p3 + p4 + ((y - 1) >> 1);
          if (row >= f.height) row = f.height - 1;
        }
        for (let x = 0; x < f.width; x++) {
          const ci = f.pixels[row * f.width + x];
          const di = (y * f.width + x) * 4;
          if (f.transparent && ci === f.transparentIndex) {
            d[di + 3] = 0;
          } else {
            d[di] = pal[ci * 3];
            d[di + 1] = pal[ci * 3 + 1];
            d[di + 2] = pal[ci * 3 + 2];
            d[di + 3] = 255;
          }
        }
      }
      cache[i] = img;
      return img;
    }

    // 小画布暂存，避免每帧 createElement
    const tmp = document.createElement('canvas');
    const tctx = tmp.getContext('2d');
    let tmpW = 0, tmpH = 0;

    function paintFrame(i) {
      const f = gif.frames[i];
      if (tmpW < f.width || tmpH < f.height) {
        tmpW = Math.max(tmpW, f.width);
        tmpH = Math.max(tmpH, f.height);
        tmp.width = tmpW;
        tmp.height = tmpH;
      }
      tctx.clearRect(0, 0, f.width, f.height);
      tctx.putImageData(imageDataFor(i), 0, 0);
      bctx.drawImage(tmp, 0, 0, f.width, f.height, f.left, f.top, f.width, f.height);
    }

    let painted = -1;

    function resetBuffer() {
      bctx.fillStyle = bgStyle;
      bctx.fillRect(0, 0, buf.width, buf.height);
      painted = -1;
    }

    // -----------------------------------------------------------------
    // disposal 语义（这是 seek 正确与否的关键）
    //
    // disposal=0/1: 保留本帧，下一帧叠在上面
    // disposal=2   : 本帧显示完，其区域恢复为背景 —— 但"恢复"发生在
    //                下一帧绘制【之前】，而不是本帧绘制之后。
    //                之前写成"画完立刻擦"会让画面永久变空，
    //                这就是往回拉时 GIF 不动/变黑的根因。
    // disposal=3   : 恢复到上一帧状态（少见，这里按保留处理）
    //
    // 关键帧 = 首帧，或前一帧 disposal=2 的帧。从最近的关键帧开始
    // 重放，就能保证倒退 seek 也得到正确画面。
    // -----------------------------------------------------------------
    function isKeyFrame(k) {
      if (k === 0) return true;
      return gif.frames[k - 1].disposal === 2;
    }

    /** 从关键帧 k 开始，把透明像素露出的底用背景填充 */
    function prepBeforeDraw(k) {
      if (k === 0) {
        resetBuffer();
        return;
      }
      const prev = gif.frames[k - 1];
      if (prev.disposal === 2) {
        bctx.fillStyle = bgStyle;
        bctx.fillRect(prev.left, prev.top, prev.width, prev.height);
      }
    }

    /**
     * 画第 i 帧。
     * 倒退时必须从最近的关键帧重放（disposal 有状态），
     * 而不是只画目标帧或直接从第一帧开始（后者对 167 帧会很慢）。
     */
    function renderTo(i) {
      if (i < 0 || i >= gif.frames.length) return;

      if (i === painted) { ctx.drawImage(buf, 0, 0); return; }

      if (i > painted && painted >= 0) {
        // 顺序前进：直接续画
        for (let k = painted + 1; k <= i; k++) {
          prepBeforeDraw(k);
          paintFrame(k);
          painted = k;
        }
      } else {
        // 倒退或首次：找最近关键帧，从那里重放
        let k0 = i;
        while (k0 > 0 && !isKeyFrame(k0)) k0--;
        resetBuffer();
        for (let k = k0; k <= i; k++) {
          if (k === k0) {
            bctx.fillStyle = bgStyle;
            bctx.fillRect(0, 0, buf.width, buf.height);
          }
          paintFrame(k);
          painted = k;
        }
      }
      ctx.drawImage(buf, 0, 0);
    }

    resetBuffer();
    if (gif.frames.length) renderTo(0);

    return { renderTo, reset: resetBuffer, canvas };
  }

  // -------------------------------------------------------------------------
  // 播放控制器：可暂停 / seek / 按真实帧延迟推进
  // -------------------------------------------------------------------------
  function createPlayer(gif, renderFn) {
    let rafId = null;
    let playing = false;
    let startWall = 0;
    let startMs = 0;
    let curMs = 0;
    let onFrame = null;
    let lastDrawn = -1;

    function frameAt(ms) {
      const st = gif.starts;
      if (!st.length) return 0;
      let lo = 0, hi = st.length - 1, best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (st[mid] <= ms) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best;
    }

    function drawAt(ms) {
      const i = frameAt(ms);
      if (i !== lastDrawn) {
        renderFn(i);
        lastDrawn = i;
      }
    }

    function tick() {
      const now = performance.now();
      curMs = startMs + (now - startWall);
      if (gif.totalMs > 0 && curMs >= gif.totalMs) {
        curMs = curMs % gif.totalMs;
        startMs = curMs;
        startWall = now;
        lastDrawn = -1;                  // 循环后强制重画
      }
      drawAt(curMs);
      if (onFrame) onFrame(curMs, gif.totalMs);
      if (playing) rafId = requestAnimationFrame(tick);
    }

    return {
      play() {
        if (playing || !gif.totalMs) return;
        playing = true;
        startWall = performance.now();
        startMs = curMs;
        rafId = requestAnimationFrame(tick);
      },
      pause() {
        playing = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        lastDrawn = -1;
        drawAt(curMs);                    // 停在当前帧
        if (onFrame) onFrame(curMs, gif.totalMs);
      },
      /** 跳到指定时间点；往回拉也能倒退 */
      seek(ms) {
        curMs = Math.max(0, Math.min(ms, Math.max(0, gif.totalMs - 1)));
        if (playing) {
          startWall = performance.now();
          startMs = curMs;
        }
        lastDrawn = -1;                   // 强制重绘（含倒退）
        drawAt(curMs);
        if (onFrame) onFrame(curMs, gif.totalMs);
      },
      getTime: () => curMs,
      getTotal: () => gif.totalMs,
      isPlaying: () => playing,
      setFrameCallback: (fn) => { onFrame = fn; },
      frameCount: () => gif.frameCount,
      gif,
    };
  }

  window.MCS_GIF = { parseGif, makeRenderer, createPlayer };
})();
