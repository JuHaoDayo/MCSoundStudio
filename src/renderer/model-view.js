/**
 * model-view.js — .bbmodel 模型 + 动画在**预览画布**上的显示（卡 t_fa17801d）
 *
 * 背景：此前「导入模型」只是解析成功 + 弹一张报告，「导入动画」只是解析出时长
 * 与骨骼名 —— 预览区里什么都不显示，用户看到的是「导入成功，但画布还是空的」。
 * 本文件负责把模型真的画出来，并且按播放头时刻套用动画姿态。
 *
 * 分工（重要，决定了能不能脱离窗口测试）：
 *   · buildScene / poseAffines / projectScene —— **纯数学**，只吃数据、返回数字，
 *     不碰 DOM。scripts/model-pose-test.js 直接在 node 里跑它们，
 *     断言「某个时刻某个立方体投到哪」这种可复算的结论。
 *   · renderToCanvas / loadTextures —— 用 canvas / Image，只在窗口里跑。
 *
 * 渲染方式：正投影 + 画家算法（远→近）+ 背面剔除 + 方向光着色。
 *   正投影下，3D 里的矩形面投到屏幕一定是**平行四边形**，所以面贴图可以用
 *   一次仿射变换（setTransform + drawImage + clip）精确贴上去 —— 不需要透视校正。
 *   这也意味着渲染结果是确定性的：同一份模型 + 同一时刻 → 同样的像素。
 */
'use strict';

(function () {

// ---------------------------------------------------------------------------
// 3x3 矩阵 / 仿射变换（rotation + translation，不涉及投影矩阵）
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

function mat3Identity() { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; }

function mat3Mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

function mat3Apply(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
  ];
}

/** 欧拉角（度，Blockbench/基岩版写法）→ 3x3。顺序 Rz·Ry·Rx（先 X 后 Y 后 Z） */
function mat3FromEulerDeg(rx, ry, rz) {
  const x = (Number(rx) || 0) * DEG;
  const y = (Number(ry) || 0) * DEG;
  const z = (Number(rz) || 0) * DEG;
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  // Rx
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  // Ry
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  // Rz
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mat3Mul(Rz, mat3Mul(Ry, Rx));
}

function mat3Scale(sx, sy, sz) { return [sx, 0, 0, 0, sy, 0, 0, 0, sz]; }

/** 仿射：{m:[9], t:[3]}，作用为 p → m·p + t */
function affineIdentity() { return { m: mat3Identity(), t: [0, 0, 0] }; }

/** 组合：先 b 后 a（a∘b） */
function affineCompose(a, b) {
  return { m: mat3Mul(a.m, b.m), t: mat3Apply(a.m, b.t).map((v, i) => v + a.t[i]) };
}

function affineApply(a, p) {
  const q = mat3Apply(a.m, p);
  return [q[0] + a.t[0], q[1] + a.t[1], q[2] + a.t[2]];
}

/** 绕 pivot 的「旋转 + 缩放」：T(pivot)·R·S·T(-pivot) */
function affineAboutPivot(pivot, rotDeg, scale) {
  const m = mat3Mul(mat3FromEulerDeg(rotDeg[0], rotDeg[1], rotDeg[2]),
                    mat3Scale(scale ? scale[0] : 1, scale ? scale[1] : 1, scale ? scale[2] : 1));
  const t = [
    pivot[0] - (m[0] * pivot[0] + m[1] * pivot[1] + m[2] * pivot[2]),
    pivot[1] - (m[3] * pivot[0] + m[4] * pivot[1] + m[5] * pivot[2]),
    pivot[2] - (m[6] * pivot[0] + m[7] * pivot[1] + m[8] * pivot[2]),
  ];
  return { m, t };
}

// ---------------------------------------------------------------------------
// 面定义
//
// 每个面给出 4 个角在**模型静止姿态**下的取法，顺序 = 贴图 UV 的
//   [u1,v1]→[u2,v1]→[u2,v2]→[u1,v2]（左上→右上→右下→左下）。
// 约定：u 增大的方向 = (视线方向 forward= -normal) × up，v 增大 = 屏幕向下。
// 这样从外面看每个面时贴图不会镜像（与游戏的 box UV 习惯一致）。
// axis/sign 用来算世界法线：0=x,1=y,2=z；sign 是面的外法线方向。
// ---------------------------------------------------------------------------
const FACES = [
  {
    name: 'north', axis: 2, sign: -1, normal: [0, 0, -1],
    corners: (f, t) => [[t[0], t[1], f[2]], [f[0], t[1], f[2]], [f[0], f[1], f[2]], [t[0], f[1], f[2]]],
  },
  {
    name: 'south', axis: 2, sign: 1, normal: [0, 0, 1],
    corners: (f, t) => [[f[0], t[1], t[2]], [t[0], t[1], t[2]], [t[0], f[1], t[2]], [f[0], f[1], t[2]]],
  },
  {
    name: 'east', axis: 0, sign: 1, normal: [1, 0, 0],
    corners: (f, t) => [[t[0], t[1], t[2]], [t[0], t[1], f[2]], [t[0], f[1], f[2]], [t[0], f[1], t[2]]],
  },
  {
    name: 'west', axis: 0, sign: -1, normal: [-1, 0, 0],
    corners: (f, t) => [[f[0], t[1], f[2]], [f[0], t[1], t[2]], [f[0], f[1], t[2]], [f[0], f[1], f[2]]],
  },
  {
    name: 'up', axis: 1, sign: 1, normal: [0, 1, 0],
    corners: (f, t) => [[f[0], t[1], f[2]], [t[0], t[1], f[2]], [t[0], t[1], t[2]], [f[0], t[1], t[2]]],
  },
  {
    name: 'down', axis: 1, sign: -1, normal: [0, -1, 0],
    corners: (f, t) => [[f[0], f[1], f[2]], [t[0], f[1], f[2]], [t[0], f[1], t[2]], [f[0], f[1], t[2]]],
  },
];

const FACE_BY_NAME = {};
for (const f of FACES) FACE_BY_NAME[f.name] = f;

/**
 * box UV：立方体只给了一个 uv 原点（Blockbench 的 "uv": [u,v]），
 * 六个面的 uv 按 Minecraft 展开图推导（dx/dy/dz 是立方体尺寸）。
 */
function boxUvFor(uv, from, to) {
  const u = Number(uv[0]) || 0;
  const v = Number(uv[1]) || 0;
  const dx = Math.abs(to[0] - from[0]);
  const dy = Math.abs(to[1] - from[1]);
  const dz = Math.abs(to[2] - from[2]);
  return {
    north: [u + dz, v + dz, u + dz + dx, v + dz + dy],
    east: [u, v + dz, u + dz, v + dz + dy],
    south: [u + dz + dx + dz, v + dz, u + dz + dx + dz + dx, v + dz + dy],
    west: [u + dz + dx, v + dz, u + dz + dx + dz, v + dz + dy],
    up: [u + dz, v, u + dz + dx, v + dz],
    down: [u + dz + dx, v, u + dz + dx + dx, v + dz],
  };
}

/** 面 uv 的 90/270 度旋转（Blockbench 允许单面转 uv） */
function rotateUv(uv, deg) {
  const d = ((Number(deg) || 0) % 360 + 360) % 360;
  const [u1, v1, u2, v2] = uv;
  if (d === 90) return [u1, v1, u1 + (v2 - v1), v1 + (u2 - u1)];
  if (d === 180) return [u1, v1, u1 + (u2 - u1), v1 + (v2 - v1)];   // 保持矩形范围
  if (d === 270) return [u1, v1, u1 + (v2 - v1), v1 + (u2 - u1)];
  return uv;
}

// ---------------------------------------------------------------------------
// 场景：模型 → 可计算的数据结构
// ---------------------------------------------------------------------------

/**
 * @param bbInfo parsers.parseBBModel() 的结果
 * @returns {{
 *   name, resolution, bones:[{uuid,name,parentUuid,origin,rotation,exported,index}],
 *   cubes:[{uuid,name,boneName,boneUuid,from,to,origin,rotation,faces:[{name,uv,texture,normal}]}],
 *   textureRefs:[{index,name,source,embedded}],
 *   bounds:{min,max}, center, size, stats:{cubeCount,boneCount,faceCount,texturedFaces}
 * }}
 */
function buildScene(bbInfo) {
  if (!bbInfo) throw new Error('buildScene 需要 parseBBModel 的结果');
  const groups = bbInfo.groups || [];
  const parentOf = bbInfo.parentOf || {};
  const nameByUuid = {};
  for (const g of groups) nameByUuid[g.uuid] = g.name;

  const bones = groups.map((g, i) => ({
    uuid: g.uuid,
    name: g.name,
    // 父骨骼可能是另一个 group；指向元素（cube）的 uuid 不算父骨骼
    parentUuid: parentOf[g.uuid] && nameByUuid[parentOf[g.uuid]] ? parentOf[g.uuid] : null,
    origin: (g.origin || [0, 0, 0]).slice(),
    rotation: (g.rotation || [0, 0, 0]).slice(),
    exported: g.export !== false,
    index: i,
  }));

  const cubeRaw = bbInfo.elements || [];
  const cubes = [];
  for (const el of cubeRaw) {
    if (!el || !el.from || !el.to) continue;
    const inflate = Number(el.inflate) || 0;
    const from = [0, 1, 2].map((k) => Math.min(el.from[k], el.to[k]) - inflate);
    const to = [0, 1, 2].map((k) => Math.max(el.from[k], el.to[k]) + inflate);
    const parentUuid = parentOf[el.uuid] || null;
    const boneUuid = parentUuid && nameByUuid[parentUuid] ? parentUuid : null;

    const faces = [];
    const rawFaces = el.faces || {};
    const boxUvs = el.uv && !rawFaces.north ? boxUvFor(el.uv, from, to) : null;
    for (const fdef of FACES) {
      const raw = rawFaces[fdef.name];
      let uv = null;
      let texture = null;
      if (raw && Array.isArray(raw.uv)) {
        uv = rotateUv(raw.uv.map(Number), raw.rotation);
        texture = raw.texture == null ? null : Number(raw.texture);
      } else if (boxUvs && boxUvs[fdef.name]) {
        uv = boxUvs[fdef.name];
      }
      if (!uv || uv.some((x) => !isFinite(x))) continue;
      if (uv[0] === uv[2] || uv[1] === uv[3]) continue;    // 零面积面（Blockbench 用它表示「不画」）
      faces.push({ name: fdef.name, uv, texture, normal: fdef.normal.slice(), corners: fdef.corners(from, to) });
    }
    cubes.push({
      uuid: el.uuid,
      name: el.name || 'cube',
      boneUuid,
      boneName: boneUuid ? nameByUuid[boneUuid] : null,
      from, to,
      origin: (el.origin || [0, 0, 0]).slice(),
      rotation: (el.rotation || [0, 0, 0]).slice(),
      faces,
    });
  }

  // 包围盒：按模型静止姿态的顶点算（用于自适应缩放）
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const c of cubes) {
    for (const p of cornersOf(c.from, c.to)) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
  }
  if (!cubes.length) { min = [0, 0, 0]; max = [0, 0, 0]; }
  const center = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  const size = [0, 1, 2].map((k) => Math.max(1e-3, max[k] - min[k]));

  const textureRefs = (bbInfo.textures || []).map((t, i) => ({
    index: i,
    name: t.name || ('texture' + i),
    source: t.source || t.relativePath || t.path || null,
    embedded: !!t.isEmbedded,
    width: t.width,
    height: t.height,
  }));

  let faceCount = 0;
  let texturedFaces = 0;
  for (const c of cubes) {
    faceCount += c.faces.length;
    for (const f of c.faces) if (f.texture != null && textureRefs[f.texture]) texturedFaces++;
  }

  return {
    name: bbInfo.name || '',
    resolution: bbInfo.resolution || { width: 64, height: 64 },
    bones,
    cubes,
    textureRefs,
    bounds: { min, max },
    center,
    size,
    stats: { cubeCount: cubes.length, boneCount: bones.length, faceCount, texturedFaces },
  };
}

function cornersOf(from, to) {
  const out = [];
  for (const x of [from[0], to[0]]) {
    for (const y of [from[1], to[1]]) {
      for (const z of [from[2], to[2]]) out.push([x, y, z]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 姿态：把动画时刻采样出的骨骼值变成「每个骨骼的世界变换」
// ---------------------------------------------------------------------------

/**
 * @param scene buildScene 的结果
 * @param pose  { 骨骼名: { rotation:[x,y,z], position:[…], scale:[…] } }（可空 = 静止姿态）
 * @returns { byName:{}, byUuid:{}, posedBones:[名字], cubeAffine:[每个立方体的世界变换] }
 */
function poseAffines(scene, pose) {
  const p = pose || {};
  const byUuid = {};
  const byName = {};
  const posedBones = [];
  const local = {};

  for (const b of scene.bones) {
    const pz = p[b.name] || null;
    // 动画里的骨骼旋转是「绝对旋转」（Blockbench / 基岩版都是这个语义），
    // 没被动画驱动的骨骼保持模型里的静止旋转。
    const rot = pz && pz.rotation ? pz.rotation : b.rotation;
    const scale = pz && pz.scale ? pz.scale : [1, 1, 1];
    const moved = pz && pz.position ? pz.position : null;
    const a = affineAboutPivot(b.origin, rot, scale);
    if (moved) a.t = [a.t[0] + moved[0], a.t[1] + moved[1], a.t[2] + moved[2]];
    local[b.uuid] = a;
    if (pz) posedBones.push(b.name);
  }

  // 自顶向下累积（父可能排在子之后，所以用「按需递归 + 缓存」）
  const memo = {};
  function worldOf(uuid) {
    if (memo[uuid]) return memo[uuid];
    const b = scene.bones.find((x) => x.uuid === uuid);
    if (!b) return affineIdentity();
    const own = local[uuid] || affineIdentity();
    const w = b.parentUuid ? affineCompose(worldOf(b.parentUuid), own) : own;
    memo[uuid] = w;
    byUuid[uuid] = w;
    byName[b.name] = w;
    return w;
  }
  for (const b of scene.bones) worldOf(b.uuid);

  // 每个立方体的世界变换 = 所在骨骼（没有父骨骼就是单位阵）∘ 立方体自身 origin/rotation
  const cubeAffine = scene.cubes.map((c) => {
    const parent = c.boneUuid ? (memo[c.boneUuid] || affineIdentity()) : affineIdentity();
    const own = affineAboutPivot(c.origin, c.rotation, [1, 1, 1]);
    return affineCompose(parent, own);
  });

  return { byUuid, byName, posedBones, cubeAffine };
}

// ---------------------------------------------------------------------------
// 投影：把姿态后的立方体面投到屏幕（纯函数，可复算）
// ---------------------------------------------------------------------------

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// 默认视角：偏右前方、**从上往下看**（俯视）。
// pitch 的符号很关键：相机在 -Z 侧朝 +Z 看，绕 X 转负角才会把模型的顶面
// 转到朝向相机的一侧；给正角会变成「从下往上看」，顶面被背面剔除掉
// —— 实测就是这么发现「所有面都是侧面贴图、顶面一个像素都没有」的。
const DEFAULT_VIEW = { yaw: -32, pitch: -20, margin: 0.12 };
const LIGHT = normalize([-0.45, 0.75, -0.55]);   // 相机空间光方向

/**
 * 静止姿态在相机空间里的包围盒（相机矩阵入参，可缓存）。
 * 自适应缩放用它，动画播放期间比例与位置保持稳定。
 */
function restFitBounds(scene, cam) {
  const key = cam.map((v) => v.toFixed(6)).join(',');
  if (scene._fitCache && scene._fitCache.key === key) return scene._fitCache.bounds;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const cube of scene.cubes) {
    const own = affineAboutPivot(cube.origin, cube.rotation, [1, 1, 1]);
    for (const p of cornersOf(cube.from, cube.to)) {
      const q = mat3Apply(cam, affineApply(own, p));
      if (q[0] < minX) minX = q[0];
      if (q[0] > maxX) maxX = q[0];
      if (q[1] < minY) minY = q[1];
      if (q[1] > maxY) maxY = q[1];
    }
  }
  const bounds = { minX, maxX, minY, maxY };
  try { scene._fitCache = { key, bounds }; } catch (e) { /* 忽略 */ }
  return bounds;
}

/**
 * @param opts {viewWidth, viewHeight, yaw, pitch, roll, zoom, pan, margin, cull, fitTo:'rest'|'pose'}
 *   roll  画面内滚转（度，逆时针为正）
 *   zoom  在「自适应铺满」的基准上再乘的倍数（1 = 现在的观感）
 *   pan   {x,y} 画面内位移（像素）
 * @returns {{polys:[…], scale, offset:[x,y], restFit, visibleFaces, culledFaces, error}}
 */
function projectScene(scene, pose, opts) {
  const o = opts || {};
  const W = Math.max(1, Number(o.viewWidth) || 320);
  const H = Math.max(1, Number(o.viewHeight) || 200);
  const yaw = o.yaw == null ? DEFAULT_VIEW.yaw : o.yaw;
  const pitch = o.pitch == null ? DEFAULT_VIEW.pitch : o.pitch;
  const margin = o.margin == null ? DEFAULT_VIEW.margin : o.margin;
  const cull = o.cull !== false;

  const cam = mat3Mul(mat3FromEulerDeg(pitch, 0, 0), mat3FromEulerDeg(0, yaw, 0));
  const aff = poseAffines(scene, pose);

  // 一次遍历：算面、算包围、剔除背面
  const polys = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let culledFaces = 0;

  for (let ci = 0; ci < scene.cubes.length; ci++) {
    const cube = scene.cubes[ci];
    const world = aff.cubeAffine[ci];
    // 世界（相机空间）法线：立方体变换的旋转部分作用于本地法线
    const rot = [world.m[0], world.m[1], world.m[2], world.m[3], world.m[4], world.m[5], world.m[6], world.m[7], world.m[8]];
    const cubeScale = [
      Math.hypot(rot[0], rot[3], rot[6]) || 1,
      Math.hypot(rot[1], rot[4], rot[7]) || 1,
      Math.hypot(rot[2], rot[5], rot[8]) || 1,
    ];
    const norm = [
      [rot[0] / cubeScale[0], rot[3] / cubeScale[0], rot[6] / cubeScale[0]],
      [rot[1] / cubeScale[1], rot[4] / cubeScale[1], rot[7] / cubeScale[1]],
      [rot[2] / cubeScale[2], rot[5] / cubeScale[2], rot[8] / cubeScale[2]],
    ];
    const normMul = (v) => [
      norm[0][0] * v[0] + norm[1][0] * v[1] + norm[2][0] * v[2],
      norm[0][1] * v[0] + norm[1][1] * v[1] + norm[2][1] * v[2],
      norm[0][2] * v[0] + norm[1][2] * v[1] + norm[2][2] * v[2],
    ];

    for (let fi = 0; fi < cube.faces.length; fi++) {
      const face = cube.faces[fi];
      const worldNormal = mat3Apply(cam, normMul(face.normal));
      const facing = worldNormal[2] < -0.02;      // 相机在 -Z 侧朝 +Z 看：法线指向 -Z 才看得见
      if (cull && !facing) { culledFaces++; continue; }

      const pts = [];
      for (const corner of face.corners) {
        const q = mat3Apply(cam, affineApply(world, corner));
        pts.push(q);
      }
      let depth = 0;
      for (const q of pts) {
        depth += q[2];
        if (q[0] < minX) minX = q[0];
        if (q[0] > maxX) maxX = q[0];
        if (q[1] < minY) minY = q[1];
        if (q[1] > maxY) maxY = q[1];
      }
      depth /= pts.length;

      const lit = Math.max(0, worldNormal[0] * LIGHT[0] + worldNormal[1] * LIGHT[1] + worldNormal[2] * LIGHT[2]);
      polys.push({
        cubeIndex: ci,
        faceIndex: fi,
        cubeName: cube.name,
        faceName: face.name,
        // 相机空间 3D 点（测试要用，也是投影的输入）
        camPoints: pts.map((q) => q.slice()),
        depth,
        normal: worldNormal,
        shade: 0.55 + 0.45 * lit,
        uv: face.uv.slice(),
        texture: face.texture,
      });
    }
  }

  if (!polys.length) {
    return {
      polys: [], scale: 1, offset: [W / 2, H / 2], viewWidth: W, viewHeight: H,
      yaw, pitch, culledFaces, visibleFaces: 0, error: scene.cubes.length ? '所有面都被剔除（模型可能没有正面）' : '模型里没有可绘制的面',
    };
  }

  // ---- 自适应缩放：**按静止姿态**算，动画播放期间不会因为肢体摆动而整体缩放/漂移 ----
  //      （按当前姿态算会让「没被动画驱动的底座」也跟着动 —— 拖播放头时整块画面抖）
  const fit = restFitBounds(scene, cam);
  const fminX = o.fitBounds ? o.fitBounds.minX : fit.minX;
  const fmaxX = o.fitBounds ? o.fitBounds.maxX : fit.maxX;
  const fminY = o.fitBounds ? o.fitBounds.minY : fit.minY;
  const fmaxY = o.fitBounds ? o.fitBounds.maxY : fit.maxY;

  const spanX = Math.max(1e-3, fmaxX - fminX);
  const spanY = Math.max(1e-3, fmaxY - fminY);
  const scale = Math.min((W * (1 - margin * 2)) / spanX, (H * (1 - margin * 2)) / spanY);
  const cx = (fminX + fmaxX) / 2;
  const cy = (fminY + fmaxY) / 2;
  const offset = [W / 2, H / 2];

  const toScreen = (q) => [
    offset[0] + (q[0] - cx) * scale,
    offset[1] - (q[1] - cy) * scale,
  ];
  for (const poly of polys) {
    poly.points = poly.camPoints.map(toScreen);
  }
  // ---- 视角后处理：滚转（Z）/ 缩放 / 位移（卡 t_c54d031b 的「调整页」）----
  // 正投影下「屏幕内绕中心转 + 缩放 + 平移」与「相机绕视线滚转 + 拉近 + 平移」完全等价，
  // 所以放在这里做一次 2D 变换即可：既不碰相机矩阵，也不碰上面的**静止姿态**自适应缩放
  // （restFitBounds 仍按静止姿态算 —— 改成按当前姿态算，播放动画时整块画面会抖）。
  // 三个参数都是默认值（roll=0 / zoom=1 / pan=0,0）时这段一行都不执行 —— 老工程逐像素不变。
  const roll = Number.isFinite(o.roll) ? o.roll : 0;
  const zoom = (Number.isFinite(o.zoom) && o.zoom > 0) ? o.zoom : 1;
  const panX = (o.pan && Number.isFinite(o.pan.x)) ? o.pan.x : 0;
  const panY = (o.pan && Number.isFinite(o.pan.y)) ? o.pan.y : 0;
  if (roll || zoom !== 1 || panX || panY) {
    const rad = roll * DEG;
    const cs = Math.cos(rad), sn = Math.sin(rad);
    const ox = W / 2, oy = H / 2;
    for (const poly of polys) {
      poly.points = poly.points.map((p) => {
        const dx = (p[0] - ox) * zoom;
        const dy = (p[1] - oy) * zoom;
        // 屏幕坐标 y 向下：逆时针（roll 为正）＝ [cos, sin; -sin, cos]
        return [ox + dx * cs + dy * sn + panX, oy + (-dx * sn + dy * cs) + panY];
      });
    }
  }
  // 画家算法：远的先画（相机在 -Z，z 越大越远）
  polys.sort((a, b) => b.depth - a.depth);

  return {
    polys,
    scale,
    offset,
    yaw,
    pitch,
    roll,
    zoom,
    pan: { x: panX, y: panY },
    culledFaces,
    visibleFaces: polys.length,
    bounds: { minX, maxX, minY, maxY },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// 贴图：把 scene.textureRefs 变成 Image（只在窗口里跑）
// ---------------------------------------------------------------------------

/**
 * 解析贴图来源 → dataUrl。相对路径按「模型文件所在目录」拼。
 * @param readBinaryFile (path) => Promise<{ok, dataUrl, error}>
 */
async function resolveTextureDataUrls(scene, modelDir, readBinaryFile) {
  const out = [];
  for (const ref of scene.textureRefs) {
    let src = ref.source;
    if (!src) { out.push({ index: ref.index, dataUrl: null, error: '贴图没有来源（未内嵌、也没有路径）' }); continue; }
    if (/^data:/.test(src)) { out.push({ index: ref.index, dataUrl: src, error: null }); continue; }
    const norm = String(src).replace(/\\/g, '/');
    const isAbs = /^[A-Za-z]:\//.test(norm) || norm.startsWith('/');
    const full = isAbs ? src : joinPath(modelDir, src);
    const r = await readBinaryFile(full);
    out.push({ index: ref.index, dataUrl: r && r.ok ? r.dataUrl : null, path: full, error: r && r.ok ? null : ((r && r.error) || '读取失败') });
  }
  return out;
}

function joinPath(dir, rel) {
  const d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return d ? d + '/' + r : r;
}

/** dataUrl → HTMLImageElement（失败不抛，返回 null） */
function loadImage(dataUrl) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || !dataUrl) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

function hashHue(s) {
  let h = 0;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) & 0xffff;
  return h % 360;
}

/**
 * 把 projectScene 的结果画到 canvas。
 * @param opts {width, height, dpr, background, textures:{index:Image}, drawEdges, emptyHint,
 *             yaw, pitch, roll, zoom, pan:{x,y}, margin, cull}
 */
function renderToCanvas(canvas, scene, pose, opts) {
  const o = opts || {};
  const dpr = Math.max(1, Math.min(3, o.dpr || 1));
  const cssW = Math.max(1, Math.round(o.width || canvas.clientWidth || 320));
  const cssH = Math.max(1, Math.round(o.height || canvas.clientHeight || 200));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = o.background || '#101216';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const proj = projectScene(scene, pose, {
    viewWidth: cssW,
    viewHeight: cssH,
    yaw: o.yaw,
    pitch: o.pitch,
    roll: o.roll,
    zoom: o.zoom,
    pan: o.pan,
    margin: o.margin,
    cull: o.cull,
  });

  const textures = o.textures || {};

  for (const poly of proj.polys) {
    const img = poly.texture != null ? textures[poly.texture] : null;
    const p = poly.points;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.closePath();

    if (img) {
      // 正投影下矩形 → 平行四边形，一次仿射就能精确贴合
      ctx.clip();
      const [u1, v1, u2, v2] = poly.uv;
      const sw = u2 - u1;
      const sh = v2 - v1;
      const a = (p[1][0] - p[0][0]) / sw;
      const b = (p[1][1] - p[0][1]) / sw;
      const c = (p[3][0] - p[0][0]) / sh;
      const d = (p[3][1] - p[0][1]) / sh;
      ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * p[0][0], dpr * p[0][1]);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, u1, v1, sw, sh, 0, 0, sw, sh);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 方向光：压暗背光面，让立方体看得出立体
      if (poly.shade < 1) {
        ctx.fillStyle = 'rgba(0,0,0,' + (1 - poly.shade).toFixed(3) + ')';
        ctx.fill();
      }
    } else {
      // 没有贴图（或贴图读不到）：用立方体名生成稳定的色调 + 方向光
      const hue = hashHue(poly.cubeName || poly.faceName);
      const l = Math.round(28 + 40 * poly.shade);
      ctx.fillStyle = 'hsl(' + hue + ',42%,' + l + '%)';
      ctx.fill();
    }

    if (o.drawEdges) {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  return proj;
}

/** 画布「画了多少东西」的指纹（证据/回归都靠它，不靠人眼） */
function canvasStats(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return { width: 0, height: 0, painted: 0, coverage: 0, hash: 0, colors: 0 };
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (e) {
    return { width: w, height: h, error: String(e && e.message || e) };
  }
  const bg = [data[0], data[1], data[2]];
  let painted = 0;
  let hash = 2166136261;
  const palette = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const dr = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (dr > 12) {
      painted++;
      hash = (hash ^ (data[i] + data[i + 1] * 3 + data[i + 2] * 7)) >>> 0;
      hash = (hash * 16777619) >>> 0;
      if (palette.size < 64) palette.add((data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4));
    }
  }
  const total = w * h;
  return {
    width: w, height: h,
    painted,
    coverage: Math.round((painted / total) * 10000) / 10000,
    hash,
    colors: palette.size,
  };
}

window.MCS_MODELVIEW = {
  // 纯函数（node 里可直接跑）
  mat3Identity, mat3Mul, mat3Apply, mat3FromEulerDeg, mat3Scale,
  affineIdentity, affineCompose, affineApply, affineAboutPivot,
  buildScene, poseAffines, projectScene, boxUvFor, FACE_BY_NAME, DEFAULT_VIEW,
  // 需要 DOM
  resolveTextureDataUrls, loadImage, renderToCanvas, canvasStats,
};

})();
