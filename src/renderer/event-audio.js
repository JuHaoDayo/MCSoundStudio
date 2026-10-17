/**
 * event-audio.js — 事件 → 音频文件解析
 *
 * 原版事件（如 dig.stone）本身没有文件路径，需要查 library.json 才知道
 * 它对应哪些 ogg。这个模块是唯一的查询入口。
 *
 * 提供：
 *   setLibrary(lib)              载入 library.json
 *   getVariants(event)           取某事件的所有变体 [{file, absPath, volume, pitch}]
 *   pickVariant(event, index)    取指定变体（试听 / 预览用）
 *   resolveForPlayback(clip)     给片段解析出实际播放路径 + 时长
 */

'use strict';

(function () {

let LIB = null;                 // library.json 的完整对象
const BY_EVENT = new Map();     // event -> event 对象

function setLibrary(lib) {
  LIB = lib || null;
  BY_EVENT.clear();
  if (LIB && Array.isArray(LIB.events)) {
    for (const e of LIB.events) BY_EVENT.set(e.event, e);
  }
}

function hasLibrary() { return !!LIB; }

function getEvent(event) { return BY_EVENT.get(event) || null; }

function getVariants(event) {
  const e = BY_EVENT.get(event);
  return e ? e.variants : [];
}

/**
 * 取指定变体；index 省略时随机（模拟游戏内的随机变体行为）。
 */
function pickVariant(event, index) {
  const vs = getVariants(event);
  if (!vs.length) return null;
  if (index == null || index < 0 || index >= vs.length) {
    return vs[Math.floor(Math.random() * vs.length)];
  }
  return vs[index];
}

/**
 * 变体模式归一（卡 t_3623451f）。
 *
 * 只有两种模式，全流程（试听 / 时间轴播放 / 保存 / 导出）必须用同一个判据：
 *   'locked' = 指定变体（固定播某一个）    'auto' = 随机变体（游戏内随机）
 *
 * 为什么单独抽成一个函数：属性面板的旧代码里有一处写成 `variantMode === 'fixed'`，
 * 而界面写进文档的值是 'locked' —— 于是「锁定变体」在试听这条路上一辈子没生效过
 * （试听随机、时间轴也随机，用户以为锁上了）。这里把 'fixed' 当历史别名一起收进来。
 */
function variantModeOf(clip) {
  if (!clip) return 'auto';
  return (clip.variantMode === 'locked' || clip.variantMode === 'fixed') ? 'locked' : 'auto';
}

/**
 * 取「指定变体」的下标。越界（换过库 / 变体变少 / 存的是文件路径）一律夹回合法范围 ——
 * 指定变体是**确定性**语义，宁可夹到最近的合法项，也不能悄悄退回随机：
 * 那会让「我以为锁了」和「实际播的」再次分叉。
 */
function lockedVariantIndex(clip, total) {
  const n = total || 0;
  if (!n) return -1;
  let i = clip && clip.lockedVariant != null ? Number(clip.lockedVariant) : NaN;
  if (!isFinite(i) || i < 0) i = 0;
  if (i > n - 1) i = n - 1;
  return i;
}

/** 指定变体的下标（未指定 / 单变体 / 非事件片段 = -1） */
function pinnedIndex(clip) {
  if (!clip || clip.kind !== 'event' || !clip.soundId) return -1;
  if (variantModeOf(clip) !== 'locked') return -1;
  const vs = getVariants(clip.soundId);
  return vs.length > 1 ? lockedVariantIndex(clip, vs.length) : -1;
}

/**
 * 导出用：指定变体在 sound_definitions 里注册的**独立事件名**。
 *
 * 为什么需要它：原版 `dig.stone` 这个 key 底下挂着 4 个变体，引擎每次都随机挑，
 * 所以「导出时只写事件名」= 播放时随机 —— 和界面上的「指定变体」对不上。
 * 要让引擎固定播某一个，只能另外注册一个 key，其 sounds 数组里只有那一个文件。
 * 命名规则：<事件名>__v<序号，从 1 开始>。返回 null = 该片段不需要钉变体。
 */
function pinNameOf(clip) {
  const i = pinnedIndex(clip);
  return i < 0 ? null : `${clip.soundId}__v${i + 1}`;
}

/**
 * 导出用：把「指定变体」写成一个可注册的 sound_definitions 条目。
 * @returns { name, event, index, total, file, volume, pitch } | null
 */
function pinnedEntry(clip) {
  const i = pinnedIndex(clip);
  if (i < 0) return null;
  const vs = getVariants(clip.soundId);
  const v = vs[i];
  if (!v) return null;
  return {
    name: pinNameOf(clip),
    event: clip.soundId,
    index: i,
    total: vs.length,
    file: v.file,
    absPath: v.absPath,
    volume: v.volume != null ? v.volume : 1,
    pitch: v.pitch != null ? v.pitch : 1,
  };
}

/**
 * 给一个片段解析出「实际该播哪个文件」。
 * - kind === 'event'：查库拿变体（locked = 指定，auto = 随机）
 * - kind === 'file' ：直接用 soundPath
 *
 * @returns { absPath, durationMs, volume, pitch, variantIndex, variantTotal, variantFile, source } | null
 */
function resolveForPlayback(clip) {
  if (!clip) return null;

  if (clip.kind === 'event' && clip.soundId) {
    const vs = getVariants(clip.soundId);
    if (!vs.length) return null;
    let idx = 0;
    if (variantModeOf(clip) === 'locked') {
      idx = lockedVariantIndex(clip, vs.length);      // 指定变体：固定那一个
    } else {
      idx = Math.floor(Math.random() * vs.length);   // 模拟游戏随机
    }
    const v = vs[idx];
    return {
      absPath: v.absPath,
      durationMs: null,
      volume: v.volume != null ? v.volume : 1,
      pitch: v.pitch != null ? v.pitch : 1,
      variantIndex: idx,
      variantTotal: vs.length,
      variantFile: v.file,
      source: 'event',
    };
  }

  if (clip.soundPath) {
    return {
      absPath: clip.soundPath,
      durationMs: clip.durationMs || null,
      volume: 1,
      pitch: 1,
      variantIndex: 0,
      variantTotal: 1,
      variantFile: null,
      source: 'file',
    };
  }

  return null;
}

/**
 * 分类的中文名
 *
 * bottle 是官方 sound_definitions 里真实存在的 category（v1.26.50.4 里只有
 * bottle.dragonbreath / bottle.empty / bottle.fill 三条，都属于「用瓶子装/倒」）。
 * 卡 t_41c27a7a 把这 3 条接回库之后，界面会多出一个分类桶，所以这里必须有中文名，
 * 否则界面会直接显示英文「bottle」。
 */
const CATEGORY_LABEL = {
  block: '方块',
  friendly: '友好生物',
  hostile: '敌对生物',
  neutral: '友好生物',      // 兼容旧数据
  player: '玩家',
  ambient: '环境',
  ui: '界面',
  weather: '天气',
  sound: '其他',
  bottle: '瓶子',           // 瓶子装填/倒空（官方 category=bottle）
  music: '音乐',
  record: '唱片',
};

/**
 * 生物/主题分组（二级）。
 *
 * 关键：生物分组直接从 mob.<name> 里取 key，再用 Wiki 中文名词典
 * 翻译（window.MCS_WIKI.MOB）。这样：
 *   - 不会因为正则漏写而把某个生物分错（原实现靠手写正则，漏了就会串组）
 *   - 新版本加了生物也自动有中文名（只要词典补一条）
 *   - 中文名与 Wiki 一致（奶牛/牛、羊驼/行商羊驼 等）
 *
 * 非 mob.* 的事件（方块、玩家、环境）按域前缀归到玩法主题。
 */
const FALLBACK_GROUPS = [
  { key: 'raid', label: '袭击 / 劫掠', match: (ev) => /raid|ominous|_omen|horn/i.test(ev) },
  { key: 'piston', label: '活塞 / 机械', match: (ev) => /piston/i.test(ev) },
  { key: 'anvil', label: '铁砧', match: (ev) => /anvil/i.test(ev) },
  { key: 'door', label: '门 / 活板门', match: (ev) => /door|trapdoor|fence_gate/i.test(ev) },
  { key: 'chest', label: '箱子 / 容器', match: (ev) => /chest|barrel|shulker|hopper|dispenser|dropper/i.test(ev) },
  { key: 'copper', label: '铜', match: (ev) => /copper/i.test(ev) },
  { key: 'beacon', label: '信标 / 导管', match: (ev) => /beacon|conduit/i.test(ev) },
  { key: 'explosion', label: '爆炸 / 破坏', match: (ev) => /explode|explosion/i.test(ev) },
  { key: 'dig', label: '挖掘', match: (ev) => /^dig\./i.test(ev) },
  { key: 'step', label: '脚步', match: (ev) => /^step\./i.test(ev) },
  { key: 'place', label: '放置', match: (ev) => /^place\./i.test(ev) },
  { key: 'break', label: '破坏', match: (ev) => /^break\./i.test(ev) },
  { key: 'ui', label: '界面交互', match: (ev) => /^ui\.|button/i.test(ev) },
];

/** 兼容旧引用 */
const THEME_GROUPS = FALLBACK_GROUPS;

/**
 * 生物 key 归一：把「同一生物的多种写法」收敛到一个 key，
 * 这样小熊猫不会和熊猫分成两组、旧版 enderdragon 不会和 ender_dragon 裂开。
 */
const MOB_ALIAS = {
  endermen: 'enderman',
  enderdragon: 'ender_dragon',
  // 卡 t_4e96920b：mob.elderguardian.* 是基岩版旧事件 ID，和 mob.elder_guardian
  // 是同一个生物 —— 不归一的话「敌对生物」下会多出一个英文组名（词典也缺条目）
  elderguardian: 'elder_guardian',
  wanderingtrader: 'wandering_trader',
  polarbear: 'polar_bear',
  snowgolem: 'snow_golem',
  magmacube: 'magma_cube',
  evocation_illager: 'evoker',
  illusion_illager: 'illusioner',
  zombie_pigman: 'zombified_piglin',
  panda_baby: 'panda',
  polarbear_baby: 'polar_bear',
  wolf_baby: 'wolf',
  villager_v2: 'villager',
  zombie_villager_v2: 'zombie_villager',
  trader_llama: 'trader_llama',
  irongolem_crackiness_high: 'irongolem',
  irongolem_crackiness_medium: 'irongolem',
  irongolem_crackiness_low: 'irongolem',
  fish: 'fish',
};

/** 把 mob key 规范成词典里的主 key */
function normalizeMobKey(k) {
  if (!k) return k;
  return MOB_ALIAS[k] || k;
}

/** 从 wiki 词典取生物中文名 */
function mobLabelOf(key) {
  const W = window.MCS_WIKI;
  const k = normalizeMobKey(key);
  if (W && W.MOB && W.MOB[k]) return W.MOB[k];
  if (W && W.MOB && W.MOB[key]) return W.MOB[key];
  return key;
}

/**
 * 给事件算出一个主题分组 key（用于二级分组）。
 * mob.<name>.* 一律按生物聚合；其余走玩法主题。
 */
function themeOf(event, category) {
  const key = mobKeyOf(event);
  if (key) return 'mob:' + normalizeMobKey(key);

  // mob.imitate.X 单段式（没有动作段）
  const im = /^mob\.imitate\.([a-z_]+)$/.exec(event);
  if (im) return 'mob:' + normalizeMobKey(im[1]);

  for (const g of FALLBACK_GROUPS) {
    if (g.match(event)) return g.key;
  }
  return null;
}

/** 主题 key → 显示名 */
function themeLabelOf(themeKey) {
  if (!themeKey) return null;
  if (themeKey.startsWith('mob:')) return mobLabelOf(themeKey.slice(4));
  const g = FALLBACK_GROUPS.find((x) => x.key === themeKey);
  return g ? g.label : themeKey;
}

/**
 * 一级分组：修正原版 category 的错分类。
 *
 * 权威依据是中文 Minecraft Wiki「生物」条目的「友好生物 / 敌对生物」章节，
 * 该表已抄录到 wiki-names.js（FRIENDLY / HOSTILE）。
 * 原版 sound_definitions 的 category 字段本身错得离谱 —— 铁傀儡、熊猫、
 * 北极熊、狼被标成 hostile，copper.wax_on 这类方块音被标成 neutral，
 * 所以不能信它，必须以 Wiki 名单为准。
 */
const NON_MOB = [
  /^block\./i, /^step\./i, /^dig\./i, /^place\./i, /^break\./i, /^hit\./i,
  /^fall\./i, /^random\./i, /^tile\./i, /^item\./i, /^note\./i,
  /^apply_effect\./i, /^crossbow/i, /^firework/i, /^liquid\./i,
  /^copper\./i, /^beacon\./i, /^conduit\./i, /^bell\./i,
  /^trial_spawner/i, /^vault\./i, /^crafter/i, /^respawn_anchor/i,
  /^component\./i, /^armor\./i, /^damage\./i, /^enchant/i, /^smithing_table/i,
  /^lectern/i, /^furnace/i, /^blastfurnace/i, /^smoker/i, /^grindstone/i,
  /^stonecutter/i, /^loom/i, /^cartography/i, /^composter/i, /^brewing/i,
  /^enchanting_table/i, /^cauldron/i, /^bundle/i, /^brush/i, /^mace/i,
  /^spyglass/i, /^lead\./i, /^map\./i, /^bottle/i, /^chime/i,
  // 鞘翅是装备（物品）音，不是生物；card t_41c27a7a 接回 elytra.loop 时补上
  /^elytra\./i,
  /\bstep$/i, /\.fall$/i, /\.break$/i, /\.place$/i, /\.hit$/i,
];

/** 从事件名里提取生物 key（mob.<name>.<action> 的 <name>） */
function mobKeyOf(event) {
  const m = /^mob\.([a-z_]+)\./.exec(event);
  if (!m) return null;
  let k = m[1];
  if (k === 'imitate') {
    // mob.imitate.endermen → 末影人
    const m2 = /^mob\.imitate\.([a-z_]+)$/.exec(event);
    return m2 ? m2[1] : 'enderman';
  }
  return k;
}

/**
 * 审计修正：把「根本不是生物、却被塞进生物分类」的事件挪到正确的桶。
 *
 * 依据 qa-wiki-audit.md §3.7（与 scripts/wiki-audit-fixes.json 的 categoryFix 同源）。
 * 这些事件 ID 里没有 mob.* 段，原版 sound_definitions 又给它们标了
 * neutral / hostile，于是被 fixedCategory() 当生物处理：
 *   charge.sculk / spread.sculk / scrape  → 方块音（subtitles.block.sculk.* / item.axe.scrape）
 *   imitate.fuse                          → 苦力怕嘶嘶声（存疑，见下）
 *   minecart.base / minecart.inside       → 矿车不是生物，归「其他」
 *   raid.horn                             → 袭击是事件类音效，归「其他」
 *
 * imitate.fuse 存疑说明（卡 t_494d72c9）：它没有 mob. 前缀，官方字幕 key 是
 * subtitles.entity.creeper.primed（苦力怕拉起引信），与 sounds/random/fuse 同文件；
 * 同一族里 30 条 mob.imitate.* 已确认是鹦鹉模仿，但 imitate.fuse 是否也是鹦鹉配音
 * 官方没有直接写明（zh_CN.lang 里 subtitles.entity.parrot.imitate.creeper 没有任何
 * 事件在用），所以**暂不改动**，保留「敌对生物」并在审计报告里列为存疑项。
 * 注意：这里只改「显示分类」，library.json 里的原始 category 一律不动。
 */
const CATEGORY_FIX = {
  'charge.sculk': 'block',
  'scrape': 'block',
  'spread.sculk': 'block',
  'imitate.fuse': 'hostile',
  'minecart.base': 'sound',
  'minecart.inside': 'sound',
  'raid.horn': 'sound',
};

function fixedCategory(event, category) {
  if (Object.prototype.hasOwnProperty.call(CATEGORY_FIX, event)) return CATEGORY_FIX[event];

  const key = mobKeyOf(event);

  // 非生物事件不该出现在生物分类里
  for (const re of NON_MOB) {
    if (re.test(event)) {
      if (!key) {
        if (category === 'neutral' || category === 'hostile' || category === 'friendly') return 'block';
        return category || 'sound';
      }
    }
  }

  // 这几个虽然是 mob.* 但不是真正的生物，不该占生物分类
  //   mob.agent.spawn   —— 教育版智能体，不是生物
  //   mob.fish.death    —— 所有鱼的通用死亡音，属于「通用」而不是某个生物
  if (key === 'agent' || key === 'fish') return 'sound';

  if (key) {
    const W = window.MCS_WIKI;

    // mob.imitate.X 是「鹦鹉模仿 X 的叫声」—— 发出声音的实体是**鹦鹉**（友好生物），
    // 不是被模仿的 X。依据：官方 bedrock-samples v1.26.50.4 里这一族的字幕 key 是
    // subtitles.entity.parrot.imitate.<生物>（zh_CN.lang：「鹦鹉喘气」等），
    // 中文 Wiki「鹦鹉」条目也写明鹦鹉是友好生物、会模仿敌对生物的音效
    // （https://minecraft.wiki/w/Parrot/Sounds 的 Imitations 表 = Bedrock 的 mob.imitate.<生物>）。
    //
    // 这条必须放在按 key 查 Wiki 阵营**之前**：key 取的是被模仿者
    // （mob.imitate.blaze → blaze → 敌对），先查名单就会把鹦鹉的声音归进敌对生物。
    // 修正前就是这个顺序，导致 29 条落在敌对生物、mob.imitate.wolf 掉在友好生物，
    // 同一族分裂成两个桶（卡 t_494d72c9）。
    if (/^mob\.imitate\./.test(event)) return 'friendly';

    if (W && W.FRIENDLY && W.FRIENDLY.includes(key)) return 'friendly';
    if (W && W.HOSTILE && W.HOSTILE.includes(key)) return 'hostile';

    // Wiki 名单没覆盖（版本新增生物 / 旧拼写 key）：退回原版 category，但把 neutral 归一
    if (category === 'neutral') return 'friendly';
    if (category) return category;
  }

  if (category === 'neutral') return 'friendly';
  return category || 'sound';
}

window.MCS_EVENTS = {
  setLibrary,
  hasLibrary,
  getEvent,
  getVariants,
  pickVariant,
  resolveForPlayback,
  // 变体语义（卡 t_3623451f）：模式判据 / 指定变体下标 / 导出用的钉变体名
  variantModeOf,
  lockedVariantIndex,
  pinnedIndex,
  pinNameOf,
  pinnedEntry,
  themeOf,
  fixedCategory,
  CATEGORY_FIX,
  mobKeyOf,
  themeLabelOf,
  CATEGORY_LABEL,
  THEME_GROUPS,
  get library() { return LIB; },
};

})();  // end IIFE
