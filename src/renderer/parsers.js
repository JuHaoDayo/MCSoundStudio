/**
 * parsers.js — .bbmodel 与 .animation.json 解析
 *
 * 目标（第一阶段）：
 *  1. 从 .bbmodel 提取：模型名、尺寸、骨骼（group）列表、贴图、几何体包围盒
 *  2. 从 .animation.json 提取：所有动画名、时长、骨骼名、关键帧时间点
 *  3. 两者的骨骼名做**一致性校对**，把问题暴露给用户
 *
 * 不做 3D 渲染（第二阶段），只做数据提取与校验。
 */

'use strict';

(function () {

// ---------------------------------------------------------------------------
// .animation.json 解析
// ---------------------------------------------------------------------------

/**
 * 解析基岩版动画文件。
 * 返回 { formatVersion, animations: [{name, lengthSec, lengthMs, loop, bones, keyTimesMs, interpolations}] }
 */
function parseAnimationJson(text) {
  const json = JSON.parse(text);
  const fv = json.format_version || null;
  const anims = json.animations || {};
  const out = [];

  for (const name of Object.keys(anims)) {
    const a = anims[name] || {};
    const lengthSec = a.animation_length != null ? Number(a.animation_length) : null;

    // 若没有 animation_length，从关键帧里推断最大值
    let maxTime = lengthSec != null ? lengthSec : 0;
    const boneNames = [];
    const keyTimes = new Set();
    const interps = new Set();

    const bones = a.bones || {};
    for (const bn of Object.keys(bones)) {
      boneNames.push(bn);
      const bone = bones[bn] || {};
      for (const ch of ['position', 'rotation', 'scale']) {
        const track = bone[ch];
        if (track == null) continue;
        if (Array.isArray(track)) continue;         // 常量值，无关键帧
        if (typeof track !== 'object') continue;
        for (const t of Object.keys(track)) {
          const num = Number(t);
          if (!isNaN(num)) {
            keyTimes.add(num);
            if (num > maxTime) maxTime = num;
          }
          const kf = track[t];
          if (kf && typeof kf === 'object' && !Array.isArray(kf)) {
            if (kf.lerp_mode) interps.add(kf.lerp_mode);
            if (kf.pre || kf.post) interps.add('pre/post');
          }
        }
      }
    }

    out.push({
      name,
      lengthSec,
      lengthMs: Math.round(maxTime * 1000),
      loop: a.loop === undefined ? null : a.loop,   // true / false / 'hold_on_last_frame'
      boneNames,
      keyTimesMs: Array.from(keyTimes).map((t) => Math.round(t * 1000)).sort((x, y) => x - y),
      interpolations: Array.from(interps),
      hasParticleEffects: !!a.particle_effects || hasEffectsAnimator(a),
    });
  }

  return { formatVersion: fv, animations: out };
}

function hasEffectsAnimator(anim) {
  const bones = anim.bones || {};
  for (const bn of Object.keys(bones)) {
    if (bn === 'effects') return true;
  }
  return false;
}

/**
 * 检测动画文件里的脏数据。
 * 已知坑：数值被写成带空白/换行的字符串，如 "180\n"
 */
function detectAnimationDirtyData(text) {
  const issues = [];
  const json = JSON.parse(text);
  const anims = json.animations || {};

  for (const name of Object.keys(anims)) {
    const a = anims[name] || {};
    const bones = a.bones || {};
    for (const bn of Object.keys(bones)) {
      const bone = bones[bn] || {};
      for (const ch of ['position', 'rotation', 'scale']) {
        const track = bone[ch];
        if (track == null || Array.isArray(track) || typeof track !== 'object') continue;
        for (const t of Object.keys(track)) {
          const kf = track[t];
          const vals = [];
          if (Array.isArray(kf)) vals.push(kf);
          else if (kf && typeof kf === 'object') {
            if (Array.isArray(kf.pre)) vals.push(kf.pre);
            if (Array.isArray(kf.post)) vals.push(kf.post);
          }
          for (const v of vals) {
            for (let i = 0; i < v.length; i++) {
              const raw = v[i];
              if (typeof raw === 'string' && raw !== raw.trim()) {
                issues.push({
                  anim: name, bone: bn, channel: ch, time: t, axis: 'xyz'[i],
                  raw: JSON.stringify(raw),
                  message: `动画「${name}」骨骼「${bn}」${ch}.${'xyz'[i]} 在 ${t}s 的值包含空白字符：${JSON.stringify(raw)}`,
                });
              }
            }
          }
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// .bbmodel 解析
// ---------------------------------------------------------------------------

function parseBBModel(text) {
  const m = JSON.parse(text);

  const meta = m.meta || {};
  const resolution = m.resolution || {};
  const elements = m.elements || [];
  const groups = m.groups || [];
  const textures = m.textures || [];
  const animations = m.animations || [];
  const outliner = m.outliner || [];

  // --- 几何包围盒 ---
  let bb = null;
  for (const el of elements) {
    if (el.from && el.to) {
      if (!bb) bb = { min: el.from.slice(), max: el.to.slice() };
      else {
        for (let i = 0; i < 3; i++) {
          bb.min[i] = Math.min(bb.min[i], el.from[i]);
          bb.max[i] = Math.max(bb.max[i], el.to[i]);
        }
      }
    }
  }

  // --- 骨骼（group）名称与 origin ---
  // ⚠️ Blockbench 4.x 存盘时**只把骨骼树写进 outliner**，`groups` 数组经常是空的
  //    （旧版/部分导出才有）。只读 groups 会导致「模型导入成功但一根骨骼都没有」，
  //    预览里也就没法按骨骼摆姿态 —— 所以要以 outliner 为准做并集。
  const groupByUuid = new Map();
  const pushGroup = (g) => {
    if (!g || !g.uuid) return;
    const norm = {
      uuid: g.uuid,
      name: g.name,
      origin: (g.origin || [0, 0, 0]).slice(),
      rotation: (g.rotation || [0, 0, 0]).slice(),
      export: g.export !== false,
      children: Array.isArray(g.children) ? g.children : [],
    };
    const old = groupByUuid.get(g.uuid);
    // 已经在 groups 数组里有记录的，用 groups 里的（它带完整属性），只补 outliner 独有的
    if (!old) groupByUuid.set(g.uuid, norm);
    else if (old.name == null && norm.name != null) groupByUuid.set(g.uuid, norm);
  };
  for (const g of groups) pushGroup(g);
  (function collectFromOutliner(nodes) {
    for (const n of (nodes || [])) {
      if (!n || typeof n !== 'object') continue;
      // outliner 里的对象节点 = 骨骼；字符串 = 立方体 uuid 引用
      if (n.uuid && n.name != null && !Array.isArray(n)) pushGroup(n);
      if (Array.isArray(n.children)) collectFromOutliner(n.children);
    }
  })(outliner);
  const groupList = Array.from(groupByUuid.values());

  // --- 从 outliner 推导父子关系（用于 3D 渲染阶段） ---
  const parentOf = {};
  function walk(node, parentUuid) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, parentUuid);
      return;
    }
    if (typeof node === 'string') {
      parentOf[node] = parentUuid;
      return;
    }
    if (node.uuid) {
      parentOf[node.uuid] = parentUuid;
      if (Array.isArray(node.children)) {
        for (const ch of node.children) walk(ch, node.uuid);
      }
    }
  }
  walk(outliner, null);

  // --- 贴图 ---
  const texList = textures.map((t) => ({
    name: t.name,
    id: t.id,
    folder: t.folder || '',
    namespace: t.namespace || '',
    width: t.width,
    height: t.height,
    // 三种来源：内嵌 base64 / 相对路径 / 绝对路径
    isEmbedded: !!(t.source && t.source.startsWith('data:')),
    source: t.source || null,
    relativePath: t.relative_path || null,
    path: t.path || null,
    uuid: t.uuid,
  }));

  // --- 模型内的动画（Blockbench 自带动画） ---
  const animList = animations.map((a) => ({
    uuid: a.uuid,
    name: a.name,
    loop: a.loop,                 // 'once' | 'loop' | 'hold'
    length: a.length,             // 秒
    lengthMs: Math.round((a.length || 0) * 1000),
    groupName: a.group_name || '',
    animators: Object.keys(a.animators || {}).map((k) => ({
      uuid: k,
      name: (a.animators[k] || {}).name,
      type: (a.animators[k] || {}).type,
      keyframeCount: ((a.animators[k] || {}).keyframes || []).length,
    })),
  }));

  // --- 元素（立方体）---
  // 预览渲染（model-view.js）要用真实的 from/to/origin/rotation/faces，
  // 只给 elementCount 是画不出东西的；这里补一份归一化后的清单。
  const elementList = elements.map((el) => ({
    uuid: el.uuid,
    name: el.name,
    from: Array.isArray(el.from) ? el.from.map(Number) : null,
    to: Array.isArray(el.to) ? el.to.map(Number) : null,
    origin: Array.isArray(el.origin) ? el.origin.map(Number) : [0, 0, 0],
    rotation: Array.isArray(el.rotation) ? el.rotation.map(Number) : [0, 0, 0],
    inflate: Number(el.inflate) || 0,
    uv: Array.isArray(el.uv) ? el.uv.map(Number) : null,
    faces: el.faces && typeof el.faces === 'object' ? el.faces : null,
    groupUuid: parentOf[el.uuid] || null,
  }));

  // --- 稀疏元素属性检查（Blockbench "cube" 名重复等） ---
  const nameCount = {};
  for (const el of elements) nameCount[el.name] = (nameCount[el.name] || 0) + 1;
  const dupNames = Object.keys(nameCount).filter((n) => nameCount[n] > 1 && n && !/^cube$/.test(n));

  return {
    meta,
    modelFormat: meta.model_format || null,
    formatVersion: meta.format_version || null,
    name: m.name || '',
    modelIdentifier: m.model_identifier || '',
    resolution,
    visibleBox: m.visible_box || null,
    elementCount: elements.length,
    groupCount: groupList.length,
    boundingBox: bb,
    groups: groupList,
    parentOf,
    // 原始几何（预览渲染用；数量统计仍看 elementCount）
    elements: elementList,
    textures: texList,
    animations: animList,
    duplicateElementNames: dupNames,
  };
}

// ---------------------------------------------------------------------------
// 交叉校验：动画里的骨骼名 vs 模型里的 group 名
// ---------------------------------------------------------------------------

/**
 * 返回 { missingInModel: [], unusedInAnim: [], matched: [] }
 */
function crossCheckBones(bbInfo, animInfos) {
  const modelNames = new Set(
    bbInfo.groups.filter((g) => g.export).map((g) => g.name)
  );
  const animNames = new Set();
  for (const a of animInfos) {
    for (const b of a.boneNames || []) animNames.add(b);
  }

  const missingInModel = [];
  const matched = [];
  for (const n of animNames) {
    if (modelNames.has(n)) matched.push(n);
    else missingInModel.push(n);
  }
  const unusedInAnim = [];
  for (const n of modelNames) {
    if (!animNames.has(n)) unusedInAnim.push(n);
  }
  return {
    missingInModel: missingInModel.sort(),
    unusedInAnim: unusedInAnim.sort(),
    matched: matched.sort(),
  };
}

/**
 * 贴图完整性检查：绝对路径 + 非常规目录（如 QQ 缓存）预警
 */
function checkTextures(texList) {
  const issues = [];
  for (const t of texList) {
    if (t.isEmbedded) {
      issues.push({ level: 'ok', name: t.name, message: `内嵌 base64（${t.width}×${t.height}），安全` });
      continue;
    }
    const p = t.relativePath || t.path || '';
    if (!p) {
      issues.push({ level: 'error', name: t.name, message: '贴图无来源路径' });
      continue;
    }
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');
    if (isAbsolute) {
      const suspicious = /Tencent|QQ|Temp|Cache|tmp/i.test(p);
      issues.push({
        level: suspicious ? 'error' : 'warn',
        name: t.name,
        message: suspicious
          ? `贴图指向临时/缓存目录，随时可能被清理：${p}`
          : `贴图使用绝对路径，迁移到其他机器会失效：${p}`,
      });
    } else {
      issues.push({ level: 'ok', name: t.name, message: `相对路径：${p}` });
    }
  }
  return issues;
}

/** Molang 表达式的粗略识别（本期不求值，只用来「如实标注哪一处不会动」） */
function looksLikeMolang(s) {
  return typeof s === 'string' && /(^|[^A-Za-z0-9_])(query|variable|math|temp|context|this)\s*\./.test(s);
}

/** 把「读不出数值的东西」变成一句人能看得懂的原文 */
function rawText(v) {
  if (v === undefined) return '（缺省）';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

/**
 * 读一个关键帧 / 常量通道的三轴值。
 *
 * **禁止静默删帧**（卡 t_96cd9241）：以前只要有一个轴读不出数字（典型就是 Molang
 * 表达式 `"query.anim_time * 90"`），整个关键帧就被 `continue` 丢掉，界面上却照报
 * 「关键帧时间点（3 个）」。现在这一帧照样进轨道 —— 该轴按「保持前一帧的数值」处理
 * （前面没有数值帧就用 0），同时把这处**原样**记进 expressions 清单，
 * 界面拿它逐处如实标注「未求值」。本期不做表达式求值。
 *
 * @param raw  原始值：数组 [x,y,z] / 单值（scale 的 uniform 写法）/ 表达式字符串
 * @param prev 同通道上一个关键帧的数值三元组（没有则 null）
 * @param ctx  { bone, channel, t, kind }
 * @param expressions 清单（就地 push）
 * @returns [x, y, z] 数值三元组
 */
function readKeyTriple(raw, prev, ctx, expressions) {
  const base = Array.isArray(prev) ? prev : null;
  const out = base ? [numOrDef(base[0]), numOrDef(base[1]), numOrDef(base[2])] : [0, 0, 0];
  const bad = [];

  if (Array.isArray(raw)) {
    for (let i = 0; i < 3; i++) {
      const n = numOrNull(raw[i]);
      if (n != null) out[i] = n;
      else bad.push({ axis: 'xyz'[i], raw: rawText(raw[i]) });
    }
  } else {
    const n = numOrNull(raw);
    if (n != null) { out[0] = out[1] = out[2] = n; }        // 单值 → 三轴同值
    else bad.push({ axis: 'xyz', raw: rawText(raw), whole: true });   // 整帧一个值：三轴都算它
  }

  if (bad.length) {
    expressions.push({
      bone: ctx.bone,
      channel: ctx.channel,
      t: ctx.t == null ? null : ctx.t,
      // 非数组写法（整帧就是表达式 / 单值）三轴一起受影响 → 只说通道名；
      // 数组里只有个别轴坏掉时才写 channel.轴，免得文案噪音
      axes: (bad.length === 1 && bad[0].whole) ? ['x', 'y', 'z'] : bad.map((b) => b.axis),
      raw: bad.length === 1 ? bad[0].raw : bad.map((b) => `${b.axis}=${b.raw}`).join(' / '),
      kept: out.slice(),
      hadPrev: !!base,
      isExpr: bad.some((b) => looksLikeMolang(b.raw)),
      kind: ctx.kind || 'frame',
    });
  }
  return out;
}

/** 一处降级的人话说明（界面直接用它，不另写一套文案） */
function expressionNote(e) {
  const what = e.isExpr ? '表达式' : '读不出的写法';
  const kept = e.kept ? e.kept.map((n) => Math.round(n * 100) / 100).join(',') : '';
  const label = (e.axes && e.axes.length && e.axes.length < 3) ? e.channel + '.' + e.axes.join('') : e.channel;
  const at = e.t == null ? '@常量' : '@' + (Math.round(e.t * 1000) / 1000) + 's';
  let how;
  if (e.t == null) {
    how = e.kind === 'whole' ? '整条通道都是它，未求值，画布上按 0,0,0 常量处理' : '未求值，画布上按 0,0,0 处理';
  } else if (e.hadPrev) {
    how = `未求值，已按前一帧 ${kept} 保持`;
  } else {
    how = '未求值，前面没有数值帧，按 0,0,0 处理';
  }
  return `${e.bone}.${label} ${at} → ${what}："${e.raw}"（${how}）`;
}

/**
 * 动画里的关键帧 / 时间点 / 表达式统计。
 * 界面列表、Molang 档的支持范围说明都读这一份，避免两处各数一遍数出不一样的数。
 */
function animationStats(anim) {
  const times = new Set();
  let keyCount = 0;
  let constantChannels = 0;
  for (const bn of Object.keys(anim.bones || {})) {
    const chans = anim.bones[bn] || {};
    for (const ch of Object.keys(chans)) {
      const c = chans[ch];
      if (c.constant) { constantChannels++; continue; }
      for (const k of (c.keys || [])) { keyCount++; times.add(k.t); }
    }
  }
  const list = anim.expressions || [];
  return {
    keyCount,
    timeCount: times.size,
    keyTimes: Array.from(times).sort((a, b) => a - b),
    boneCount: Object.keys(anim.bones || {}).length,
    constantChannels,
    exprCount: list.filter((e) => e.isExpr).length,
    otherCount: list.filter((e) => !e.isExpr).length,
    expressionCount: list.length,
  };
}

/**
 * 抠出「可以采样」的动画轨道（预览要用，parseAnimationJson 只给时间点不够）。
 *
 * 返回 { formatVersion, animations: [ { name, source, lengthMs, loop, bones, expressions, stats } ] }
 *   bones: { <骨骼名>: { rotation:[{t,v}], position:[…], scale:[…] } }
 *   expressions: [{bone, channel, t, axes, raw, kept, hadPrev, isExpr, kind}]
 * 关键帧值统一成数字数组；插值模式原样保留（预览按 linear/step 近似）。
 * 表达式帧**不丢**（见 readKeyTriple）：按前一帧保持 + 原样记进 expressions。
 */
function extractAnimationTracks(text) {
  const json = JSON.parse(text);
  const anims = json.animations || {};
  const out = [];

  for (const name of Object.keys(anims)) {
    const a = anims[name] || {};
    const bones = {};
    const expressions = [];
    let maxTime = Number(a.animation_length) || 0;

    for (const bn of Object.keys(a.bones || {})) {
      const bone = a.bones[bn] || {};
      const chans = {};
      for (const ch of ['rotation', 'position', 'scale']) {
        const track = bone[ch];
        if (track == null) continue;

        // 写法 0：整条通道就是一个表达式字符串 —— 如 "rotation": "query.anim_time * 90"
        if (typeof track === 'string') {
          chans[ch] = { constant: readKeyTriple(track, null, { bone: bn, channel: ch, t: null, kind: 'whole' }, expressions) };
          continue;
        }

        // 写法 1：常量（没有关键帧）—— 如 "rotation": [0, 90, 0]
        if (Array.isArray(track)) {
          chans[ch] = { constant: readKeyTriple(track, null, { bone: bn, channel: ch, t: null, kind: 'constant' }, expressions) };
          continue;
        }
        if (typeof track !== 'object') continue;

        // 写法 2：{ "0.0": [x,y,z] | {post:[…]} , "1.0": … }
        const keys = [];
        let prev = null;
        for (const t of Object.keys(track)) {
          const tv = Number(t);
          if (isNaN(tv)) continue;
          const kf = track[t];
          let raw = null;
          let lerp = null;
          if (Array.isArray(kf)) raw = kf;
          else if (typeof kf === 'string') raw = kf;      // 整帧就是一个 Molang 表达式（本期不求值，如实标注）
          else if (typeof kf === 'number') raw = kf;      // 裸数字（uniform 写法）
          else if (kf && typeof kf === 'object') {
            if (Array.isArray(kf.post)) raw = kf.post;
            else if (Array.isArray(kf.pre)) raw = kf.pre;
            else if (typeof kf.post === 'string') raw = kf.post;   // { "post": "表达式" }
            else if (typeof kf.pre === 'string') raw = kf.pre;
            else raw = kf;                 // 读不出数值的写法：照样记进清单，不静默丢
            if (kf.lerp_mode) lerp = kf.lerp_mode;
          }
          if (tv > maxTime) maxTime = tv;
          if (raw == null) {
            // 连原文都给不出（null / true / 空对象之类）：这一帧照样进轨道，按「保持前一帧」处理，
            // 并把原文记进清单 —— 以前这里在第一帧上会直接 continue，把帧**静默丢掉**，
            // 界面还照报「时间点 N 个」（卡 t_96cd9241 明令禁止）。
            expressions.push({
              bone: bn, channel: ch, t: tv, axes: ['xyz'], raw: rawText(kf),
              kept: prev ? prev.slice() : [0, 0, 0], hadPrev: !!prev, isExpr: false, kind: 'frame',
            });
            const v0 = prev ? prev.slice() : [0, 0, 0];
            keys.push({ t: tv, v: v0, lerp });
            prev = v0;
            continue;
          }
          const v = readKeyTriple(raw, prev, { bone: bn, channel: ch, t: tv }, expressions);
          keys.push({ t: tv, v, lerp });
          prev = v;
        }
        if (keys.length) {
          keys.sort((x, y) => x.t - y.t);
          chans[ch] = { keys };
        }
      }
      if (Object.keys(chans).length) bones[bn] = chans;
    }

    // 动画级效果（不挂骨骼）：particle_effects / sound_effects 里也可能写表达式
    for (const key of ['particle_effects', 'sound_effects']) {
      const eff = a[key];
      if (!eff || typeof eff !== 'object' || Array.isArray(eff)) continue;
      for (const t of Object.keys(eff)) {
        const tv = Number(t);
        const text = typeof eff[t] === 'string' ? eff[t] : JSON.stringify(eff[t]);
        expressions.push({
          bone: '(动画级)', channel: key, t: isFinite(tv) ? tv : null, axes: [],
          raw: text, kept: null, hadPrev: false, isExpr: looksLikeMolang(text), kind: 'effect',
        });
      }
    }

    const anim = {
      name,
      source: 'file',
      lengthMs: Math.round(maxTime * 1000),
      loop: a.loop === undefined ? null : a.loop,
      bones,
      expressions,
    };
    anim.stats = animationStats(anim);
    out.push(anim);
  }
  return { formatVersion: json.format_version || null, animations: out };
}

/**
 * 模型 `.bbmodel` 自带的 animations → 可采样轨道（卡 t_96cd9241 第 2 条）。
 *
 * 为什么要有它：以前模型自带动画只在弹窗里报一句「模型内动画（1 条）：grab …」，
 * 画布上根本用不了（卡 t_9fd9ce60 现状盘点 §1.4）。结构对齐 extractAnimationTracks()，
 * 两档列表因此可以共用一套渲染与采样路径。
 *
 * Blockbench 的写法：每个 animator（type='bone'，name = 骨骼名）挂一串关键帧
 *   { channel:'rotation'|'position'|'scale', time:秒, data_points:[{x,y,z}], interpolation }
 * x/y/z 是字符串（本身可能就是表达式），照样走 readKeyTriple —— 不丢帧、如实标注。
 */
function extractBBModelAnimationTracks(text) {
  const json = JSON.parse(text);
  const anims = Array.isArray(json.animations) ? json.animations : [];
  const out = [];

  for (const a of anims) {
    const bones = {};
    const expressions = [];
    let maxTime = Number(a.length) || 0;
    let skippedAnimators = 0;

    for (const key of Object.keys(a.animators || {})) {
      const an = a.animators[key] || {};
      if (an.type && an.type !== 'bone') { skippedAnimators++; continue; }   // 非骨骼 animator 本期不进姿态
      const bn = an.name;
      if (!bn) continue;
      const per = { rotation: [], position: [], scale: [] };
      for (const kf of (an.keyframes || [])) {
        const ch = kf && kf.channel;
        if (!ch || !per[ch]) continue;
        const tv = Number(kf.time);
        if (!isFinite(tv)) continue;
        const dp = (kf.data_points && kf.data_points[0]) || {};
        const raw = [dp.x, dp.y, dp.z];
        // uniform 缩放只填了 x 时按三轴同值读
        if (kf.uniform && raw[1] === undefined && raw[2] === undefined) raw[1] = raw[2] = raw[0];
        per[ch].push({ t: tv, raw, lerp: kf.interpolation === 'step' ? 'step' : null });
        if (tv > maxTime) maxTime = tv;
      }
      const chans = {};
      for (const ch of ['rotation', 'position', 'scale']) {
        const list = per[ch];
        if (!list.length) continue;
        list.sort((x, y) => x.t - y.t);
        const keys = [];
        let prev = null;
        for (const k of list) {
          const v = readKeyTriple(k.raw, prev, { bone: bn, channel: ch, t: k.t }, expressions);
          keys.push({ t: k.t, v, lerp: k.lerp });
          prev = v;
        }
        chans[ch] = { keys };
      }
      // 一个关键帧都没有的 animator（Blockbench 里常见）不进骨骼表：
      // 「骨骼 N 根」要数真的会动的骨骼，不然列表上的数字对不上画布上的动作
      if (Object.keys(chans).length) bones[bn] = chans;
    }

    const anim = {
      name: a.name || '(无名动画)',
      source: 'model',
      sourceId: a.uuid || null,
      lengthMs: Math.round(maxTime * 1000),
      loop: a.loop === undefined ? null : a.loop,
      bones,
      expressions,
      skippedAnimators,
    };
    anim.stats = animationStats(anim);
    out.push(anim);
  }
  return { formatVersion: (json.meta && json.meta.format_version) || null, animations: out };
}

function numOrDef(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

function numOrNull(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // 纯空白 / 空串不算「0」：它是读不出数值，不是数值 0（卡 t_96cd9241）
    if (!v.trim()) return null;
    const n = Number(v.trim());
    return isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 在某个时刻采一条通道的值（三轴）。
 *
 * 插值策略：linear / catmullrom / hold 一律按线性近似 ——
 * 预览只用来「看动作对不对」，不值得为贝塞尔实现一套完整求值；
 * step（lerp_mode='step'）按「保持前一帧」处理，因为那是它的语义。
 * 常量通道直接返回常量值。
 */
function sampleChannel(chan, tSec) {
  if (!chan) return null;
  if (chan.constant) return chan.constant.slice();
  const keys = chan.keys;
  if (!keys || !keys.length) return null;
  if (tSec <= keys[0].t) return keys[0].v.slice();
  const last = keys[keys.length - 1];
  if (tSec >= last.t) return last.v.slice();

  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (tSec > b.t) continue;
    const a = keys[i - 1];
    const span = b.t - a.t;
    const u = span > 0 ? (tSec - a.t) / span : 0;
    const step = a.lerp === 'step';
    const w = step ? 0 : u;
    return [0, 1, 2].map((k) => {
      const av = a.v[k] == null ? 0 : a.v[k];
      const bv = b.v[k] == null ? av : b.v[k];
      return av + (bv - av) * w;
    });
  }
  return last.v.slice();
}

/**
 * 采样一整条动画在某个时刻的骨骼姿态。
 * 返回 { <骨骼名>: { rotation:[x,y,z]|null, position:[…], scale:[…] } }
 * 只包含**该时刻有值**的通道；没关键帧的骨骼不出现（渲染时用模型静止姿态）。
 */
function sampleAnimationPose(animTracks, ms) {
  const pose = {};
  if (!animTracks) return pose;
  const t = Math.max(0, Number(ms) || 0) / 1000;
  for (const bn of Object.keys(animTracks.bones || {})) {
    const chans = animTracks.bones[bn];
    const one = {};
    for (const ch of ['rotation', 'position', 'scale']) {
      const v = sampleChannel(chans[ch], t);
      if (v) one[ch] = v;
    }
    if (Object.keys(one).length) pose[bn] = one;
  }
  return pose;
}

// ---------------------------------------------------------------------------
// 导入失败诊断
//
// 目标（卡 t_fa17801d）：导入失败不许只丢 `String(e.stack)`。
// 每条诊断都要回答三件事：① 文件哪里不对 ② 是不是导错了按钮 ③ 怎么修。
// ---------------------------------------------------------------------------

/**
 * 出错位置：V8 的报错形式有好几种，这里逐个兜住。
 *   1) `… at position 1234 (line 359 column 1)`
 *   2) `Unexpected token '，', …` —— 新版 V8 不给位置，只给那个字符，
 *      所以退回「在原文里找这个字符第一次出现的位置」（中文逗号/BOM 都靠这条）
 */
function locateJsonError(text, msg) {
  const s = String(text || '');
  let m = msg.match(/at position (\d+)/i);
  if (m) return Number(m[1]);

  m = msg.match(/line (\d+) column (\d+)/i);
  if (m) {
    const line = Number(m[1]);
    const col = Number(m[2]);
    const lines = s.split('\n');
    let idx = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) idx += lines[i].length + 1;
    return idx + Math.max(0, col - 1);
  }

  m = msg.match(/Unexpected token '(.+?)'/);
  if (m && m[1]) {
    const i = s.indexOf(m[1], 1);        // 从 1 开始：开头那个字符不算（BOM 除外）
    if (i >= 0) return i;
    const j = s.indexOf(m[1]);
    if (j >= 0) return j;
  }
  return -1;
}

/** JSON 解析错误 → 能看懂的位置与常见原因 */
function explainJsonError(text, err) {
  const msg = String((err && err.message) || err || '');
  const pos = locateJsonError(text, msg);
  let where = '';
  if (pos >= 0 && pos <= text.length) {
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    const snippet = text.slice(Math.max(0, pos - 40), pos + 40).replace(/\s+/g, ' ');
    where = `第 ${line} 行第 ${col} 列附近：… ${snippet} …`;
  }

  const trimmed = text.trim();
  const reasons = [];
  if (!trimmed.length) {
    reasons.push('文件内容是空的 —— 导出/传输过程中断，或者拷错了空文件。');
  } else if (/^\uFEFF/.test(text)) {
    reasons.push('文件开头有 UTF-8 BOM（记事本另存为 UTF-8 时会加）。请用 Blockbench 重新导出，或另存为「UTF-8 无 BOM」。');
  } else if (!/[{[]/.test(trimmed.slice(0, 40))) {
    reasons.push('开头不是 { 或 [ —— 这不是 JSON 文件（可能选到了图片/音频/压缩包）。');
  } else if (!/[}\]]\s*$/.test(trimmed)) {
    reasons.push('文件结尾不完整 —— 典型的「导出/拷贝到一半被打断」或磁盘写满。重新导出一次通常就好。');
  } else if (/，|；|：|“|”/.test(text) && /Unexpected token/.test(msg)) {
    reasons.push('数值/结构里混进了中文全角标点（，；：“”）—— JSON 只认半角英文标点。');
  } else {
    reasons.push('JSON 语法错误（常见：多/少了一个引号或逗号，或数值被写成 "180\\n" 这种带空白的形式）。');
  }
  return { where, reasons, rawMessage: msg, position: pos };
}

/** 通用：文件根本没读出来 */
function diagnoseReadFailure(filePath, error) {
  return {
    level: 'error',
    title: '读不到这个文件',
    lines: [
      `文件：${filePath}`,
      `原因：${error}`,
      '',
      '怎么办：',
      '  · 确认文件没有被别的程序独占（比如正在被 Blockbench 保存中）；',
      '  · 确认路径还存在（文件被移动/删除过？）；',
      '  · 换一条更短的路径再试（超长路径在 Windows 上会失败）。',
    ],
  };
}

/**
 * 模型（.bbmodel）导入失败诊断。
 * @param {string} text 文件原文；读取失败时传 null
 * @param {Error|null} error 解析过程中抛出的错误（可能是 JSON.parse 的，
 *        也可能是**我们自己的解析器**抛的 —— 两者要给完全不同的建议）
 */
function diagnoseModelFile(text, error, filePath) {
  if (text == null || typeof text !== 'string') {
    return diagnoseReadFailure(filePath || '(未知路径)', String(error || '未知错误'));
  }
  const name = String(filePath || '').split(/[\\/]/).pop() || '(无名)';
  const lines = [`文件：${filePath || name}`];

  // ① JSON 本身能不能解析？能 → 说明 error 是我们的解析器抛的，走结构诊断
  let doc = null;
  let jsonErr = null;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    jsonErr = e;
  }
  if (jsonErr) {
    const j = explainJsonError(text, jsonErr);
    lines.push(`解析失败：${j.rawMessage}`);
    if (j.where) lines.push(`位置：${j.where}`);
    lines.push('', '可能的原因：');
    for (const r of j.reasons) lines.push('  · ' + r);
    lines.push('', '怎么办：');
    lines.push('  · 用 Blockbench 打开这个模型 → 另存为 .bbmodel 再导入；');
    lines.push('  · 如果文件其实是 .animation.json（动画），请点顶栏「导入动画」。');
    return { level: 'error', title: '这个文件不是合法的 .bbmodel（JSON 解析失败）', lines };
  }

  const hasElements = !!(doc && Array.isArray(doc.elements) && doc.elements.length);
  const hasGroups = !!(doc && Array.isArray(doc.groups) && doc.groups.length);
  const hasOutliner = !!(doc && Array.isArray(doc.outliner) && doc.outliner.length);
  const hasMeta = !!(doc && doc.meta);
  const fmt = (doc && doc.meta && doc.meta.model_format) || '';
  // Blockbench 模型里也会带一个 animations 数组（模型内动画），
  // 那**不是**基岩版动画文件 —— 用来区分「导错按钮」而不是「没有 animations」
  const animsField = doc && doc.animations;
  const animsIsMap = !!animsField && typeof animsField === 'object' && !Array.isArray(animsField);

  // ② 明显是动画文件
  if (doc && animsIsMap && !hasElements && !hasGroups && !hasOutliner && !hasMeta) {
    lines.push('这个 JSON 里只有 animations 字段，看起来是**动画文件**（.animation.json）。');
    lines.push('');
    lines.push('怎么办：点顶栏的「导入动画」导入它；模型请用「导入模型」（.bbmodel）。');
    return { level: 'error', title: '导错了按钮：这是动画文件，不是模型', lines, wrongButton: 'animation' };
  }

  // ③ 贴图/skin 工程：Blockbench 里能存出来，但没有几何体
  if (doc && hasMeta && !hasElements && !hasGroups) {
    lines.push(`meta.model_format = ${fmt || '(空)'}`);
    lines.push('这个工程里没有任何元素（elements）和骨骼（groups）。');
    lines.push('');
    lines.push('可能的原因：');
    lines.push(`  · 它是 Blockbench 的${fmt === 'image' || fmt === 'skin' ? '贴图 / 皮肤工程' : '非模型工程'}，本来就不含几何体；`);
    lines.push('  · 或者导出时没勾选模型内容。');
    lines.push('');
    lines.push('怎么办：换成带立方体的模型文件（.bbmodel 里能看到 Cube）；');
    lines.push('       导入后右侧「校验」页也会留一条同样的提示。');
    return { level: 'error', title: '这个 .bbmodel 里没有模型（无元素、无骨骼）', lines, emptyModel: true };
  }

  // ④ 结构不像 bbmodel
  if (!hasElements && !hasGroups && !hasOutliner && !hasMeta) {
    const keys = doc && typeof doc === 'object' ? Object.keys(doc).slice(0, 8) : [];
    lines.push(`顶层字段：${keys.length ? keys.join(', ') : '（不是对象）'}`);
    lines.push('');
    lines.push('这个 JSON 里找不到 Blockbench 模型该有的 elements / groups / outliner / meta。');
    lines.push('常见情况：选到了 sound_definitions.json、timeline.json、材质表之类的 JSON。');
    lines.push('');
    lines.push('怎么办：用「导入模型」选真正的 .bbmodel 文件。');
    return { level: 'error', title: '这个 JSON 不是 Blockbench 模型', lines };
  }

  // ⑤ 结构看着像模型，但我们的解析器抛错了 → 如实说是解析器的锅，别装成"文件格式错误"
  if (error) {
    lines.push(`解析失败：${(error && error.message) || error}`);
    lines.push('');
    lines.push('这个文件的 JSON 是合法的，结构也像 Blockbench 模型，所以问题出在解析器读不懂它的某一处写法。');
    lines.push('');
    lines.push('怎么办：');
    lines.push('  · 在 Blockbench 里把这个模型**另存为**一次再导入（会写成标准写法）；');
    lines.push('  · 如果仍失败，请把文件和上面这行报错一起反馈给开发者。');
    return { level: 'error', title: '这个模型解析器读不懂（不是 JSON 语法问题）', lines, parserBug: true };
  }

  return null;   // 结构看起来是模型，交给正常流程
}

/** 动画（.animation.json）导入失败诊断 */
function diagnoseAnimationFile(text, error, filePath) {
  if (text == null || typeof text !== 'string') {
    return diagnoseReadFailure(filePath || '(未知路径)', String(error || '未知错误'));
  }
  const name = String(filePath || '').split(/[\\/]/).pop() || '(无名)';
  const lines = [`文件：${filePath || name}`];

  // ① JSON 是否合法？（合法 = error 出自我们的解析器，走结构诊断）
  let doc = null;
  let jsonErr = null;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    jsonErr = e;
  }
  if (jsonErr) {
    const j = explainJsonError(text, jsonErr);
    lines.push(`解析失败：${j.rawMessage}`);
    if (j.where) lines.push(`位置：${j.where}`);
    lines.push('', '可能的原因：');
    for (const r of j.reasons) lines.push('  · ' + r);
    lines.push('', '怎么办：');
    lines.push('  · 回 Blockbench 重新导出动画（导出前先保存工程）；');
    lines.push('  · 如果文件其实是 .bbmodel（模型），请点顶栏「导入模型」。');
    return { level: 'error', title: '这个文件不是合法的动画 JSON（JSON 解析失败）', lines };
  }

  const animsField = doc && doc.animations;
  // 基岩版动画文件里 animations 是「名字 → 定义」的对象；
  // Blockbench 的 .bbmodel 里 animations 是数组（模型内动画列表）—— 两者不能混
  const animsIsMap = !!animsField && typeof animsField === 'object' && !Array.isArray(animsField);
  const looksLikeModel = !!(doc && (Array.isArray(doc.elements) || Array.isArray(doc.outliner) || doc.meta));

  if (looksLikeModel && !animsIsMap) {
    lines.push('这个 JSON 里有 elements / outliner / meta，看起来是**模型文件**（.bbmodel）。');
    if (Array.isArray(animsField) && animsField.length) {
      lines.push(`（它里面确实有 ${animsField.length} 条「模型内动画」，但那是 Blockbench 工程的一部分，`);
      lines.push('  不是可以单独导入的 .animation.json。）');
    }
    lines.push('');
    lines.push('怎么办：点顶栏的「导入模型」导入它；动画请用「导入动画」。');
    return { level: 'error', title: '导错了按钮：这是模型文件，不是动画', lines, wrongButton: 'model' };
  }
  if (animsIsMap && !Object.keys(animsField).length) {
    lines.push('animations 字段是空的 —— 这个文件里没有任何动画。');
    lines.push('');
    lines.push('怎么办：在 Blockbench 里对骨骼打关键帧后，再用「导出 → 动画」重新导出。');
    return { level: 'error', title: '动画文件里没有动画', lines };
  }
  if (!animsIsMap) {
    const keys = doc && typeof doc === 'object' ? Object.keys(doc).slice(0, 8) : [];
    lines.push(`顶层字段：${keys.length ? keys.join(', ') : '（不是对象）'}`);
    lines.push('');
    lines.push('找不到 animations 字段 —— 基岩版动画文件必须是一个带 animations 的对象。');
    lines.push('（如果你从 Blockbench 导出的是 .bbmodel，请改用「导入模型」；');
    lines.push('  如果是中国版的 netease_animation / actor 动画，需要先转成基岩版格式。）');
    return { level: 'error', title: '这个 JSON 不是基岩版动画文件', lines };
  }

  // ② 结构没问题、但解析器抛错了：如实说，别甩锅给文件格式
  if (error) {
    lines.push(`解析失败：${(error && error.message) || error}`);
    lines.push('');
    lines.push('这个文件的 JSON 合法、也有 animations 对象，问题出在解析器读不懂里面某一处写法。');
    lines.push('');
    lines.push('怎么办：在 Blockbench 里重新导出一次动画；仍失败请把文件和这行报错反馈给开发者。');
    return { level: 'error', title: '这个动画解析器读不懂（不是 JSON 语法问题）', lines, parserBug: true };
  }

  return null;   // 结构看起来是动画，交给正常流程
}

// ---------------------------------------------------------------------------

window.MCS_PARSERS = {
  parseAnimationJson,
  detectAnimationDirtyData,
  parseBBModel,
  crossCheckBones,
  checkTextures,
  // 预览用：可采样的关键帧轨道 + 某一时刻的姿态（卡 t_fa17801d）
  extractAnimationTracks,
  // 动画两档（关键帧 / Molang，卡 t_96cd9241）：
  //   模型 .bbmodel 自带动画 → 同一套轨道；表达式帧如实上报，不静默丢
  extractBBModelAnimationTracks,
  animationStats,
  expressionNote,
  looksLikeMolang,
  sampleChannel,
  sampleAnimationPose,
  // 导入失败诊断（给人看的错误）
  explainJsonError,
  diagnoseReadFailure,
  diagnoseModelFile,
  diagnoseAnimationFile,
};

})();  // end IIFE — 避免污染全局作用域
