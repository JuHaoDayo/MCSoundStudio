/**
 * library-groups.js — 音效库的「子类」分组规则（卡 t_3623451f）
 *
 * 库里一千多个原版事件按一级分类（方块 / 友好生物 / …）分完之后，方块、玩家这两类**大部分
 * 没有二级分组**，用户只能一行行翻（P0 审计卡 t_494d72c9 实测：方块桶里有两百多条
 * `themeOf()` 返回 null）。各分类的条数以 sounds/vanilla/vanilla-audit.json 为准（会随库
 * 重建变动，卡 t_706f52cd 不再在这里写死条数）。这里补的就是这层，规则全部取自
 * **事件自身的 ID**，不手写事件清单：
 *
 *   1) 物品使用族（P0 卡的 `categoryAudit.plan.itemUse`）—— 官方 sound_definitions
 *      里的真实使用语义：烟花 / 弓箭 / 弩 / 三叉戟 / 重锤 / 盾牌 / 望远镜 / 刷子 /
 *      收纳袋 / 骨粉 / 火焰弹 / 书 / 桶 / 瓶子 / 食用饮品。
 *      写成「事件 ID 前缀」而不是逐个列事件名：库重建后新增的同族事件自动归类，
 *      也不会因为漏改一处就串组。
 *   2) 其余按「玩法域」= 事件 ID 的第一段（place / hit / break / random / …）。
 *      这正是 P0 卡 `plan.blockBucket.byDomain` 的那份数据（方块 74/56/43/38/…）。
 *   3) 生物类（友好 / 敌对）仍走 event-audio.js 的 `themeOf()`（按 mob key 聚合），
 *      这里只做转发，不重复实现。
 *
 * 显示的组名是 UI 译名（DOMAIN_LABEL / FAMILY_LABEL），**分组依据**始终是事件 ID；
 * 没进译表的域名原样显示，不会静默丢条目。
 */

'use strict';

(function () {

/** 「物品使用」这一层：族挂在它下面（方块/玩家/环境/界面 里都可能有） */
const USE_GROUP = { key: 'use', label: '物品使用' };

/**
 * 物品使用族 → 事件 ID 前缀规则。
 * 依据 P0 卡 `qa-review-t_494d72c9/vanilla-audit.json` 的 `categoryAudit.plan.itemUse`
 * （每族的 inLibrary 事件都落在这条前缀规则里，scripts/verify-library-groups.js 会核对）。
 */
const ITEM_USE_RULES = [
  { family: 'firework', match: /^firework\./ },
  { family: 'bow', match: /^(random\.bow|random\.bowhit|block\.bowhit)$/ },
  { family: 'crossbow', match: /^crossbow\./ },
  { family: 'trident', match: /^item\.trident\./ },
  { family: 'mace', match: /^mace\./ },
  { family: 'shield', match: /^item\.shield\./ },
  { family: 'spyglass', match: /^item\.spyglass\./ },
  { family: 'brush', match: /^(brush|brush_completed)\./ },
  { family: 'bundle', match: /^bundle\./ },
  { family: 'bone_meal', match: /^item\.bone_meal\./ },
  { family: 'firecharge', match: /^item\.firecharge\./ },
  { family: 'book', match: /^item\.book\./ },
  // P0 卡的 bucket 族就是「桶」：炼药锅那 4 条（inLibrary）+ 官方 defs 里的
  // bucket.fill_* / bucket.empty_* 8 条（那 8 条在卡 t_41c27a7a 重建库后已经接上音频，
  // 所以这里前缀一起收，免得同一族被拆成两处）
  { family: 'bucket', match: /^(cauldron\.(fill|take)|bucket\.(fill|empty))/ },
  { family: 'bottle', match: /^bottle\./ },
  // 食用饮品：P0 卡第 3 节的建议族名；事件本身就是吃喝那几条
  { family: 'food', match: /^random\.(eat|drink|burp)$/ },
];

const FAMILY_LABEL = {
  firework: '烟花',
  bow: '弓箭',
  crossbow: '弩',
  trident: '三叉戟',
  mace: '重锤',
  shield: '盾牌',
  spyglass: '望远镜',
  brush: '刷子',
  bundle: '收纳袋',
  bone_meal: '骨粉',
  firecharge: '火焰弹',
  book: '书',
  bucket: '桶',
  bottle: '瓶子',
  food: '食用饮品',
};

/** 玩法域（事件 ID 第一段）→ 中文组名 */
const DOMAIN_LABEL = {
  block: '方块音效',
  place: '放置',
  hit: '击打',
  break: '破坏',
  dig: '挖掘',
  step: '脚步',
  fall: '摔落',
  jump: '跳跃',
  land: '落地',
  random: '随机',
  use: '使用',
  item: '物品',
  liquid: '流体',
  fire: '火焰',
  power: '红石信号',
  tile: '机械方块',
  vault: '宝库',
  cauldron: '炼药锅',
  cauldron_drip: '炼药锅滴水',
  drip: '滴水',
  copper: '铜',
  close: '关闭',
  open: '开启',
  close_door: '铜门关闭',
  open_door: '铜门开启',
  open_trapdoor: '铜活板门开启',
  click_on: '按钮按下',
  click_off: '按钮弹起',
  conduit: '潮涌核心',
  beacon: '信标',
  respawn_anchor: '重生锚',
  trial_spawner: '试炼刷怪笼',
  ominous_item_spawner: '不祥物品生成器',
  ominous_bottle: '不祥之瓶',
  crafter: '合成器',
  cake: '蛋糕',
  charge: '充能',
  chime: '紫水晶共鸣',
  resonate: '共鸣',
  shatter: '破碎',
  shriek: '尖啸',
  sponge: '海绵',
  spread: '蔓延',
  scrape: '刮削',
  extinguish: '熄灭',
  insert: '放入',
  insert_enchanted: '放入附魔书',
  pickup: '取出',
  pickup_enchanted: '取出附魔书',
  portal: '传送门',
  pumpkin: '南瓜',
  tilt_up: '垂滴叶上倾',
  tilt_down: '垂滴叶下倾',
  ambient: '环境氛围',
  entity: '实体',
  game: '游戏事件',
  damage: '伤害',
  apply_effect: '状态效果',
  minecart: '矿车',
  sign: '告示牌',
  mob: '生物',
  raid: '袭击 / 劫掠',
  // 下面这些域名在卡 t_41c27a7a 重建库（+33 条音频）之后才出现：
  // 有族的（firework/bucket/crossbow…）平时会被「物品使用」挪走，这里留着是为了
  // 「万一有同域但不属于任何族的事件」也能有中文组名，不会冒出英文头
  ui: '界面交互',
  armor: '盔甲',
  elytra: '鞘翅',
  breeze_wind_charge: '风弹',
  imitate: '引信',
  bottle: '瓶子',
  bucket: '桶',
  crossbow: '弩',
  firework: '烟花',
  brush: '刷子',
  brush_completed: '刷子（完成）',
  bundle: '收纳袋',
  mace: '重锤',
};

const MOB_CATEGORIES = ['friendly', 'hostile', 'neutral'];

/** 旧版事件 ID 里的生物段：entity.<生物>.<动作>（如 entity.wither_skeleton.ambient） */
const LEGACY_ENTITY_MOB = /^entity\.([a-z_]+)\./;

/** 事件 ID 的第一段（= 玩法域） */
function domainOf(event) {
  const s = String(event || '');
  const i = s.indexOf('.');
  return i < 0 ? s : s.slice(0, i);
}

/** 物品使用族 key（不属于任何族 = null） */
function familyOf(event) {
  const s = String(event || '');
  for (const r of ITEM_USE_RULES) if (r.match.test(s)) return r.family;
  return null;
}

/**
 * 一个事件在库里的子类路径。
 * @param {string} event 事件名（如 'place.stone'）
 * @param {string} category 一级分类 key（fixedCategory 的结果）
 * @returns {Array<{key:string,label:string}>} 空数组 = 该分类下不再分组（平铺）
 *
 * 优先级：物品使用族 > 生物主题 > 玩法域。
 * 物品使用放最前：`cauldron.fillwater` 从「方块 → 炼药锅」挪到「方块 → 物品使用 → 桶」，
 * 语义以 P0 卡的 itemUse 为准（那份清单本来就是按「物品」组织的）。
 */
function pathOf(event, category) {
  const fam = familyOf(event);
  if (fam) {
    return [USE_GROUP, { key: 'use:' + fam, label: FAMILY_LABEL[fam] || fam }];
  }

  if (MOB_CATEGORIES.indexOf(category) >= 0) {
    const EV = window.MCS_EVENTS;
    if (EV && EV.themeOf) {
      const t = EV.themeOf(event, category);
      if (t) return [{ key: t, label: (EV.themeLabelOf && EV.themeLabelOf(t)) || t }];

      // themeOf 认不出来时以前的写法就是 return []（条目平铺在分类根下）。
      // 卡 t_4e96920b 补两条兜底，让「生物」桶里也不再有没有子类的条目：
      //   1) 基岩版旧事件 ID entity.<生物>.<动作>（entity.wither_skeleton.ambient /
      //      entity.fox.teleport / entity.zombie.converted_to_drowned）——
      //      生物段就是 mob.<生物>.* 的那个生物，用同一套词典翻译、同一个 key，
      //      在分类里和 mob.<生物>.* 合成一组。词典查不到（label 还是原文）就跳过，
      //      免得又冒出一个英文组名。
      //   2) 剩下既不是某个生物、也不是 mob.* 的（breeze_wind_charge.burst「风弹」、
      //      imitate.fuse「引信」）—— 退回玩法域分组，和方块/玩家桶同一套标签。
      //      只有 DOMAIN_LABEL 里有中文组名的域名才这么做。
      const lm = LEGACY_ENTITY_MOB.exec(event);
      if (lm && EV.themeLabelOf) {
        const key = 'mob:' + lm[1];
        const label = EV.themeLabelOf(key);
        if (label && label !== lm[1]) return [{ key, label }];
      }
      const d = domainOf(event);
      if (d && DOMAIN_LABEL[d]) return [{ key: 'dom:' + d, label: DOMAIN_LABEL[d] }];
    }
    return [];
  }

  const d = domainOf(event);
  if (!d) return [];
  return [{ key: 'dom:' + d, label: DOMAIN_LABEL[d] || d }];
}

window.MCS_LIBGROUPS = {
  USE_GROUP,
  ITEM_USE_RULES,
  FAMILY_LABEL,
  DOMAIN_LABEL,
  domainOf,
  familyOf,
  pathOf,
};

})();   // end IIFE
