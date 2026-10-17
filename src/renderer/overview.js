/**
 * overview.js — 「工程总览」浮层（卡 t_fa17801d）
 *
 * 目标（像剪辑软件的工程浏览器/开始页）：
 *   · 列出已保存的工程（工程库目录 + 最近打开过的），卡片上能一眼看清
 *     名称 / 总长 / 片段数 / 轨道数 / BPM / 视觉参考 / 修改时间 / 大小；
 *   · 每张卡片带一张**按真实片段画出来的缩略条**（不是占位图）；
 *   · 点卡片 = 导入（打开）这个工程；也支持从磁盘挑工程文件、把当前工程存进工程库；
 *   · 最近记录里的文件被删/移走时，卡片灰着并写明原因，而不是无声消失。
 *
 * 与 app.js 的分工：本文件只管「列出来 + 画出来」，真正的打开/保存由 app.js
 * 通过 open(api) 传进来的回调实现（避免这里再复制一份状态管理）。
 */
'use strict';

(function () {

const $ = (id) => document.getElementById(id);

let API = null;
let current = null;      // 最近一次 list-projects 的结果
let openState = false;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMs(ms) {
  const t = Math.max(0, Math.round(Number(ms) || 0));
  if (t < 1000) return t + 'ms';
  return (t / 1000).toFixed(2) + 's';
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const VISUAL_LABEL = {
  gif: 'GIF', video: '视频', image: '图片', anim: '动画', model: '模型', none: '无',
};

// ---------------------------------------------------------------------------
// 缩略条：按工程里的真实片段画（每行一条轨道）
// ---------------------------------------------------------------------------
function drawThumb(canvas, meta) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const W = canvas.clientWidth || 236;
  const H = canvas.clientHeight || 56;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#15171c';
  ctx.fillRect(0, 0, W, H);

  const bars = (meta && meta.bars) || [];
  // 时间轴跨度：优先用工程总长；总长比内容短时按内容末端取（越界片段也能画出来）
  const span = Math.max(1, Math.max(Number(meta && meta.totalMs) || 0, Number(meta && meta.contentEndMs) || 0));

  // 网格参考线（总长的 4 等分）
  ctx.strokeStyle = '#22252c';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = Math.round((W * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  // 总长位置（内容末端之后的区域标灰，和编辑器里的语义一致）
  const totalX = Math.min(W, ((Number(meta && meta.totalMs) || 0) / span) * W);

  if (!bars.length) {
    ctx.fillStyle = '#5a6070';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('（空工程：还没有放任何音效）', 8, H / 2 + 4);
    return { bars: 0, span };
  }

  // 轨道行：按出现顺序，最多 4 行
  const trackNames = [];
  for (const b of bars) if (!trackNames.includes(b.track)) trackNames.push(b.track);
  const rows = Math.min(4, trackNames.length);
  const rowH = Math.max(6, Math.floor((H - 8) / rows));
  const top = 4;

  for (const b of bars) {
    const idx = Math.min(rows - 1, trackNames.indexOf(b.track));
    const x = Math.max(0, Math.min(W - 1, (b.startMs / span) * W));
    const w = Math.max(1.5, Math.min(W - x, (Math.max(0, b.durationMs) / span) * W));
    const y = top + idx * rowH;
    ctx.fillStyle = b.kind === 'event' ? '#4c8dff' : '#48b06a';
    ctx.fillRect(x, y, w, Math.max(3, rowH - 3));
  }

  // 「超出总长」的那段：淡红斜纹提示（缩略图上也要看得出来）
  if (totalX < W - 1) {
    ctx.fillStyle = 'rgba(255,120,120,0.08)';
    ctx.fillRect(totalX, 0, W - totalX, H);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.moveTo(totalX + 0.5, 0);
  ctx.lineTo(totalX + 0.5, H);
  ctx.stroke();
  return { bars: bars.length, span, rows };
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------
function cardHtml(e, idx) {
  const m = e.meta || {};
  const missing = !!e.missing;
  const visual = VISUAL_LABEL[m.visualKind] || m.visualKind || '—';
  const trackTxt = m.trackCount
    ? `${m.usedTrackCount || 0}/${m.trackCount} 条`
    : '—';
  const badges = [
    e.inLibrary ? '<span class="ov-tag lib">工程库</span>' : '',
    e.inRecents ? '<span class="ov-tag recent">最近</span>' : '',
    missing ? '<span class="ov-tag miss">文件已不在</span>' : '',
  ].join('');

  return `
  <div class="ov-card${missing ? ' missing' : ''}" data-idx="${idx}" tabindex="0"
       title="${missing ? '这个工程文件已经不在磁盘上了' : '点击打开这个工程'}">
    <div class="ov-card-head">
      <span class="ov-name">${esc(missing ? (e.recentName || e.fileName) : (m.name || e.fileName))}</span>
      ${badges}
    </div>
    <canvas class="ov-thumb"></canvas>
    ${missing
      ? `<div class="ov-err">找不到文件：${esc(e.path)}<br>${esc(e.error || '')}</div>`
      : `<div class="ov-meta">
           <span>总长 <b>${fmtMs(m.totalMs)}</b></span>
           <span>片段 <b>${m.clipCount}</b></span>
           <span>轨道 <b>${trackTxt}</b></span>
           ${m.bpm ? `<span>BPM <b>${m.bpm}</b></span>` : ''}
           <span>视觉 <b>${esc(visual)}${m.animName ? ' · ' + esc(m.animName) : ''}</b></span>
         </div>
         <div class="ov-meta dim">
           <span>${esc(e.fileName)}</span>
           <span>${fmtBytes(e.sizeBytes)}</span>
           <span>${fmtTime(e.mtimeMs || e.recentAt)}</span>
         </div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// 工程库里读不了的文件（卡 t_5a1c18be 第二条）
// ---------------------------------------------------------------------------
// 背景：以前提示只写「N 个文件不是工程，已跳过」——用户看到数字却不知道是哪个文件、
// 也无从处理，只能自己去翻工程库目录。主进程 list-projects 早就把
// skipped:[{file,error}] 算好返回了，这里把它用起来：提示里点名 + 展开看原因。
const MAX_SKIP_NAMES = 6;      // 提示里最多点名几个（多了会让提示行变成一堵墙）

/** 提示里点名的坏文件名（文件名本身 + 「等 N 个」） */
function skippedNamesHtml(skipped) {
  const names = skipped.map((s) => esc(s.file));
  const head = names.slice(0, MAX_SKIP_NAMES)
    .map((n) => `<code class="ov-skip-name">${n}</code>`)
    .join('、');
  return head + (names.length > MAX_SKIP_NAMES ? ` 等 ${names.length} 个文件` : '');
}

/** 坏文件明细块：文件名 + 具体原因（读不到的东西一并列出来，用户才知道去修哪个） */
function renderSkipped(skipped) {
  const box = $('ovSkipped');
  if (!box) return;
  const sum = $('ovSkippedSummary');
  const list = $('ovSkippedList');
  if (!skipped.length) {
    box.style.display = 'none';
    box.open = false;
    if (list) list.innerHTML = '';
    return;
  }
  box.style.display = '';
  box.open = true;                      // 默认展开：这是「该去修哪个文件」的唯一线索
  if (sum) sum.textContent = `${skipped.length} 个文件不是工程（已跳过）—— 具体原因：`;
  if (list) {
    list.innerHTML = skipped.map((s) => '<li><code>' + esc(s.file) + '</code>'
      + `<span class="ov-skip-why">${esc(s.error || '读不了（没有给出原因）')}</span></li>`).join('');
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function render() {
  const grid = $('ovGrid');
  const hint = $('ovHint');
  if (!grid) return;

  if (!current || !current.ok) {
    grid.innerHTML = `<div class="ov-empty"><div class="ov-empty-title">工程列表暂时读不到</div><div>${esc((current && current.error) || '请检查工程库目录是否还能访问，然后点“刷新”重试。')}</div></div>`;
    hint.innerHTML = `⚠ 读不到工程库目录：${esc((current && current.projectsDir) || '')}`;
    $('ovFoot').textContent = '';
    renderSkipped([]);              // 列表都读不到，坏文件块也不留着
    return;
  }

  const entries = current.entries || [];
  // 「目录还不存在」不是故障，是全新用户的正常初始状态：用户数据目录下的 projects\
  // 还没建过（第一次保存到工程库时会自动建）。所以这种情况必须走「工程库还是空的」那条文案 ——
  // 以前这里只判 dirExists（missing-dir 也是 false），于是首屏出现两处自相矛盾的话：
  // 中间大字说「读不到 / 访问不了」，同一屏的小字却说「还没有创建，会自动建」，
  // 用户第一眼就被通知「有东西坏了」（卡 t_e4a641d4 D1）。
  // 只有目录真的存在却读不出来（reason=unreadable-dir，或主进程没给出原因的读失败）
  // 才是故障，才说「读不到 / 访问不了」并让用户点「刷新」重试。
  const dirMissing = current.scanReason === 'missing-dir';
  if (!entries.length && !current.dirExists && !dirMissing) {
    // 目录读不到 ≠ 工程库是空的：前者要给出错误原因和重试入口，不能只说「还是空的」
    grid.innerHTML = `
      <div class="ov-empty">
        <div class="ov-empty-title">工程列表暂时读不到</div>
        <div>${esc(current.error || '工程库目录现在访问不了，点右上角“刷新”再试一次。')}</div>
      </div>`;
  } else if (!entries.length) {
    grid.innerHTML = `
      <div class="ov-empty">
        <div class="ov-empty-title">工程库还是空的</div>
        <div>点上边“新建工程”建第一个；或“打开工程文件…”打开别人给你的 timeline.json。</div>
      </div>`;
  } else {
    grid.innerHTML = entries.map((e, i) => cardHtml(e, i)).join('');
    // 卡片画完后按真实片段画缩略条
    const cards = grid.querySelectorAll('.ov-card');
    cards.forEach((card) => {
      const e = entries[Number(card.dataset.idx)];
      const cv = card.querySelector('.ov-thumb');
      if (cv && e && e.meta) drawThumb(cv, e.meta);
      else if (cv) { cv.width = cv.clientWidth || 236; cv.height = cv.clientHeight || 56; }
    });
  }

  const missing = entries.filter((e) => e.missing).length;
  const skipped = current.skipped || [];
  hint.innerHTML =
    `工程库目录：<code>${esc(current.projectsDir || '')}</code>` +
    (current.dirExists ? '' : (current.scanReason === 'missing-dir'
      ? '（还没有创建，第一次保存到工程库时会自动建）'
      : `（暂时读不到：${esc(current.error || '请检查目录权限')}）`)) +
    `　共 ${entries.length} 个工程` +
    (missing ? `，其中 ${missing} 个文件已不在磁盘上（灰显）` : '') +
    (skipped.length
      ? `，${skipped.length} 个文件不是工程，已跳过：${skippedNamesHtml(skipped)}`
        + `（下面列了每个文件的原因）`
      : '');
  renderSkipped(skipped);
  $('ovFoot').textContent = '提示：卡片上的蓝色块是原版音效事件、绿色块是自定义音频文件；细竖线是工程总长。';
}

async function refresh() {
  if (!API) return;
  const grid = $('ovGrid');
  if (grid && !current) grid.innerHTML = '<div class="ov-empty">正在读取工程库…</div>';
  current = await API.listProjects();
  render();
}

/**
 * 起始页与编辑器是同一窗口里的两个视图：起始页是铺满窗口的不透明层，压在工作页上面。
 * 这里故意不动 #layout / #topbar 的 display —— 一旦藏起来，整仓 20 多个「量工作页元素
 * 尺寸/可见性」的回归探针会在冷启动时全部读到 0×0（假红），而用户看到的画面完全一样
 * （不透明层挡住了底下）。用户能不能点到工作页由「谁在最上面」决定，不由 display 决定。
 */
function enterWorkspace() {
  const el = $('overview');
  if (el) el.style.display = 'none';
  openState = false;
}

async function open(api) {
  API = api || API;
  openState = true;
  current = null;
  const el = $('overview');
  if (!el) return;
  el.style.display = 'flex';
  if (typeof API.onOpen === 'function') API.onOpen();
  await refresh();
}

/**
 * 关掉起始页浮层，回到编辑器视图。
 *
 * 以前这里多写了一行 `setWorkspaceVisible(true);`——全仓库没有这个函数，于是
 * close() 每次都抛 ReferenceError（卡 t_244c13a2）。它抛在「隐藏浮层」之后，
 * 所以画面看不出问题，坏掉的是自动化钩子 window.__MCS_CLOSE_OVERVIEW__
 * （executeJavaScript 会因为渲染进程抛错直接 reject）。
 *
 * 现在 close() 与 enterWorkspace() 走同一条路（同一个函数体，不再各写一份）：
 * 只隐藏 #overview 浮层、不碰 #layout / #topbar 的 display —— 原因见 enterWorkspace()
 * 上面的注释（那些 display 是爬 20 多个回归探针的锚点，藏起来会让它们读到 0×0 假红）。
 */
function close() {
  enterWorkspace();
}

function isOpen() { return openState && $('overview') && $('overview').style.display !== 'none'; }

/** 状态快照（自动化验收用：条目 / 卡片数 / 工程库目录 / 卡片缩略图指纹） */
function dump() {
  const cards = Array.from(document.querySelectorAll('#ovGrid .ov-card'));
  return {
    open: isOpen(),
    ok: !!(current && current.ok),
    projectsDir: (current && current.projectsDir) || null,
    dirExists: !!(current && current.dirExists),
    error: (current && current.error) || null,
    entryCount: ((current && current.entries) || []).length,
    entries: ((current && current.entries) || []).map((e, i) => ({
      idx: i,
      name: (e.meta && e.meta.name) || e.recentName || e.fileName,
      fileName: e.fileName,
      path: e.path,
      missing: !!e.missing,
      inLibrary: !!e.inLibrary,
      inRecents: !!e.inRecents,
      totalMs: e.meta ? e.meta.totalMs : null,
      clipCount: e.meta ? e.meta.clipCount : null,
      trackCount: e.meta ? e.meta.trackCount : null,
      bpm: e.meta ? e.meta.bpm : null,
      bars: e.meta ? e.meta.bars.length : 0,
      cardText: cards[i] ? cards[i].textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
      thumb: cards[i] && cards[i].querySelector('.ov-thumb')
        ? (function (cv) {
          const ctx = cv.getContext('2d');
          let painted = 0;
          try {
            const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
            for (let k = 0; k < d.length; k += 4) {
              if (d[k] + d[k + 1] + d[k + 2] > 90) painted++;
            }
          } catch (e) { /* 忽略 */ }
          return { w: cv.width, h: cv.height, painted };
        })(cards[i].querySelector('.ov-thumb'))
        : null,
    })),
    cardCount: cards.length,
    skipped: (current && current.skipped) || [],
    // 坏文件点名（卡 t_5a1c18be 第二条）：文件名 + 原因，验收脚本不用去解析提示文本
    skippedFiles: ((current && current.skipped) || []).map((s) => s.file),
    skippedDetail: ((current && current.skipped) || []).map((s) => ({ file: s.file, error: s.error || '' })),
  };
}

// ---------------------------------------------------------------------------
// 事件绑定（只绑一次）
// ---------------------------------------------------------------------------
function bind() {
  const el = $('overview');
  if (!el || el.dataset.bound === '1') return;
  el.dataset.bound = '1';

  $('ovBtnRefresh').addEventListener('click', refresh);

  $('ovBtnOpenFile').addEventListener('click', async () => {
    if (!API) return;
    const r = await API.openProjectFile();
    if (r && r.ok) enterWorkspace();
  });

  $('ovBtnNew').addEventListener('click', async () => {
    if (!API) return;
    const r = await API.newProject();
    if (r && r.ok) enterWorkspace();
  });

  $('ovBtnOpenFolder').addEventListener('click', () => {
    if (API) API.openProjectsFolder();
  });
  $('ovBtnHelp').addEventListener('click', () => { if (API) API.openHelp(); });
  $('ovBtnAuthor').addEventListener('click', () => { if (API) API.openAuthor(); });
  // 导出系统信息（卡 t_20c2e144）：真正干活的是 app.js 的 exportSystemInfo()，
  // 这里只负责接线（库规模与首次加载耗时只有渲染进程知道，由它一起打包给主进程）。
  $('ovBtnSysInfo').addEventListener('click', () => { if (API) API.exportSystemInfo(); });

  // 卡片：点击 / 回车打开
  $('ovGrid').addEventListener('click', async (ev) => {
    const card = ev.target.closest ? ev.target.closest('.ov-card') : null;
    if (!card || !API) return;
    const e = (current && current.entries || [])[Number(card.dataset.idx)];
    if (!e) return;
    if (e.missing) {
      API.notify(`这个工程的文件已经不在磁盘上了：${e.path}`, true);
      return;
    }
    const r = await API.openPath(e.path);
    if (r && r.ok) enterWorkspace();
  });
  $('ovGrid').addEventListener('keydown', async (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const card = ev.target.closest ? ev.target.closest('.ov-card') : null;
    if (!card) return;
    ev.preventDefault();
    card.click();
  });
}

window.MCS_OVERVIEW = {
  open, close, refresh, isOpen, render, dump, enterWorkspace,
  _setCurrent: (c) => { current = c; render(); },     // 自测/回归注入用
  _drawThumb: drawThumb,
  _bind: bind,
};

document.addEventListener('DOMContentLoaded', bind);

})();
