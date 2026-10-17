/**
 * wiki-names.js — Wiki 权威中文名称映射
 *
 * 数据来源（已核对）：
 *   - 方块名：中文 Minecraft Wiki「方块」条目方块列表
 *     旧基准 scripts/wiki-blocks.json（1151 条）**已废弃**，不再作为判定依据；
 *     现行依据是 qa-wiki-audit.md（§三 P1 / §四 P2）与逐条修正表
 *     scripts/wiki-audit-fixes.json。
 *   - 生物名与阵营：中文 Minecraft Wiki「生物」条目
 *     Wiki 明确将生物分为「友好生物 / 敌对生物」，
 *     并说明该分类依据 Java 版中生物对攻击目标的选择方式。
 *     见 scripts/wiki-mobs.json
 *
 * 为什么需要这层映射：
 *   基岩版 sound_definitions.json 的事件 ID 是英文缩写，且经常复用
 *   （如 hit.anvil 实际引用石头脚步）。直接把 ID 展示给用户没法翻阅，
 *   必须给出中文名。ID 与中文名不是简单规则可推的关系
 *   （mangrove_roots=红树根、packed_mud=泥坯、honey=蜂巢），所以用显式映射表。
 */

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 方块 / 材质名（对应事件 ID 里的中段）
  // -------------------------------------------------------------------------
  const BLOCK = {
    // 石质
    stone: '石头', cobblestone: '圆石', deepslate: '深板岩', deepslate_bricks: '深板岩砖',
    deepslate_tiles: '深板岩瓦', cobbled_deepslate: '深板岩圆石', polished_deepslate: '磨制深板岩',
    chiseled_deepslate: '雕纹深板岩', andesite: '安山岩', diorite: '闪长岩', granite: '花岗岩',
    polished_andesite: '磨制安山岩', polished_diorite: '磨制闪长岩', polished_granite: '磨制花岗岩',
    tuff: '凝灰岩', calcite: '方解石', dripstone: '滴水石块', pointed_dripstone: '滴水石锥',
    blackstone: '黑石', basalt: '玄武岩', smooth_basalt: '平滑玄武岩', netherrack: '下界岩',
    nylium: '菌岩', soul_sand: '灵魂沙', soul_soil: '灵魂土', magma: '岩浆块',
    obsidian: '黑曜石', crying_obsidian: '哭泣的黑曜石', bedrock: '基岩',
    end_stone: '末地石', purpur: '紫珀块',

    // 砖与瓦
    // §五：官方名为「红砖块 / 下界砖块 / 红色下界砖块」，旧值少了「块」，
    // 且 bricks=砖块 会污染 tuff_bricks 的拼接（见 §3.6）
    bricks: '红砖块', mud_bricks: '泥砖', nether_bricks: '下界砖块', red_nether_bricks: '红色下界砖块',
    quartz: '石英', nether_quartz_ore: '下界石英矿石', sandstone: '砂岩', red_sandstone: '红砂岩',
    prismarine: '海晶石', dark_prismarine: '暗海晶石', prismarine_bricks: '海晶石砖',
    purpur_block: '紫珀块', resin_bricks: '树脂砖块', end_stone_bricks: '末地石砖',
    stone_bricks: '石砖', mossy_stone_bricks: '苔石砖', polished_blackstone: '磨制黑石',
    polished_blackstone_bricks: '磨制黑石砖', copper_bricks: '铜砖', copper_grate: '铜格栅',
    // §3.6：Wiki 方块名是「凝灰岩砖」，不是「凝灰岩砖块」
    tuff_bricks: '凝灰岩砖',

    // 土与沙
    grass: '草方块', grass_block: '草方块', dirt: '泥土', coarse_dirt: '砂土',
    rooted_dirt: '缠根泥土', podzol: '灰化土', mycelium: '菌丝体', gravel: '沙砾',
    sand: '沙子', red_sand: '红沙', clay: '黏土', muddy_mangrove_roots: '沾泥的红树根',
    mangrove_roots: '红树根', packed_mud: '泥坯', mud: '泥巴', farmland: '耕地',
    soul: '灵魂沙', mud_brick: '泥砖',
    // §4.2：官方方块名带「的」——「可疑的沙砾 / 可疑的沙子」
    suspicious_gravel: '可疑的沙砾', suspicious_sand: '可疑的沙子',

    // 木
    // §4.2：Wiki 方块列表里的竹类是「竹门 / 竹按钮 / 竹压力板 / 竹活板门 /
    // 竹栅栏门 / 悬挂式竹告示牌」，没有「竹块」这个方块名；
    // 下界木同理，官方字幕用「下界木质」（§4.2）。
    wood: '木头', log: '原木', planks: '木板', wood_step: '木台阶',
    cherry_wood: '樱花木', cherry_planks: '樱花木板', mangrove_wood: '红树木',
    bamboo: '竹子', bamboo_sapling: '竹笋', bamboo_wood: '竹质方块', bamboo_planks: '竹板',
    bamboo_wood_door: '竹门', bamboo_wood_trapdoor: '竹活板门',
    bamboo_wood_fence_gate: '竹栅栏门', bamboo_wood_button: '竹按钮',
    bamboo_wood_pressure_plate: '竹压力板', bamboo_wood_hanging_sign: '悬挂式竹告示牌',
    scaffolding: '脚手架', ladder: '梯子',

    // 植物
    leaves: '树叶', azalea_leaves: '杜鹃树叶', cherry_leaves: '樱花树叶',
    poplar_leaves: '杨树树叶', vine: '藤蔓', cave_vines: '洞穴藤蔓',
    // §4.2：官方方块名是「杜鹃花丛」（英文 Wiki Azalea）
    azalea: '杜鹃花丛',
    weeping_vines: '垂泪藤', twisting_vines: '缠怨藤', moss: '苔藓',
    moss_carpet: '覆地苔藓', lily_pad: '睡莲', nether_sprouts: '下界苗',
    nether_wart: '下界疣', wheat: '小麦', sweet_berry_bush: '甜浆果丛',
    cactus: '仙人掌', melon: '西瓜', pumpkin: '南瓜', hay: '干草捆',
    roots: '根', hanging_roots: '垂根', spore_blossom: '孢子花',
    big_dripleaf: '大型垂滴叶', small_dripleaf: '小型垂滴叶', glow_lichen: '发光地衣',
    vine_plant: '藤蔓',

    // 冰与雪
    snow: '雪块', powder_snow: '细雪', ice: '冰', packed_ice: '浮冰', blue_ice: '蓝冰',
    frosted_ice: '霜冰', snow_layer: '雪',

    // 矿物
    copper: '铜', copper_ore: '铜矿石', deepslate_copper_ore: '深层铜矿石',
    iron: '铁', iron_ore: '铁矿石', gold: '金', gold_ore: '金矿石',
    diamond: '钻石', emerald: '绿宝石', lapis: '青金石', coal: '煤',
    redstone: '红石', ancient_debris: '远古残骸', quartz_ore: '下界石英矿石',
    nether_gold_ore: '下界金矿石', amethyst: '紫水晶', amethyst_block: '紫水晶块',
    amethyst_cluster: '紫水晶簇', budding_amethyst: '紫水晶母岩', cinnabar: '朱砂',
    sulfur: '硫黄', copper_bulb: '铜灯',

    // 金属/功能方块
    anvil: '铁砧', chain: '锁链', lantern: '灯笼', soul_lantern: '灵魂灯笼',
    copper_lantern: '铜灯笼', bell: '钟', beacon: '信标', conduit: '潮涌核心',
    cauldron: '炼药锅', hopper: '漏斗', piston: '活塞', dispenser: '发射器',
    dropper: '投掷器', observer: '侦测器', trapdoor: '活板门', door: '门',
    iron_door: '铁门', iron_trapdoor: '铁活板门', button: '按钮',
    stone_button: '石头按钮', stone_pressure_plate: '石头压力板',
    metal_pressure_plate: '测重压力板', wooden_pressure_plate: '木压力板',
    light_weighted_pressure_plate: '轻质测重压力板',
    heavy_weighted_pressure_plate: '重质测重压力板',
    chest: '箱子', enderchest: '末影箱', barrel: '木桶', shulker_box: '潜影盒',
    furnace: '熔炉', blastfurnace: '高炉', smoker: '烟熏炉', campfire: '营火',
    soul_campfire: '灵魂营火', grindstone: '砂轮', loom: '织布机',
    stonecutter: '切石机', cartography_table: '制图台', smithing_table: '锻造台',
    composter: '堆肥桶', lectern: '讲台', brewing_stand: '酿造台',
    enchanting_table: '附魔台', end_portal: '末地传送门', end_portal_frame: '末地传送门框架',
    end_gateway: '末地折跃门', respawn_anchor: '重生锚', bed: '床', sign: '告示牌',
    decorated_pot: '饰纹陶罐', flower_pot: '花盆', item_frame: '物品展示框',
    painting: '画', crafter: '合成器', trial_spawner: '试炼刷怪笼',
    vault: '宝库', beehive: '蜂箱', bee_nest: '蜂巢', candle: '蜡烛',
    cake: '蛋糕', note: '音符盒', jukebox: '唱片机', scaffolding_climb: '脚手架攀爬',
    bamboo_wood_hit: '竹块撞击',

    // 珊瑚 / 海洋
    coral: '珊瑚', coral_block: '珊瑚块', coral_fan: '珊瑚扇',
    tube_coral: '管珊瑚', brain_coral: '脑纹珊瑚', bubble_coral: '气泡珊瑚',
    fire_coral: '火珊瑚', horn_coral: '鹿角珊瑚', sea_pickle: '海泡菜',
    kelp: '海带', seagrass: '海草', sponge: '海绵', wet_sponge: '湿海绵',
    turtle_egg: '海龟蛋',

    // 下界 / 末地特殊
    shroomlight: '菌光体', wart_block: '疣块', nether_wart_block: '下界疣块',
    crimson_nylium: '绯红菌岩', warped_nylium: '诡异菌岩',
    crimson_stem: '绯红菌柄', warped_stem: '诡异菌柄',
    gilded_blackstone: '镶金黑石', soul_fire: '灵魂火', fire: '火',
    lava: '熔岩', water: '水', portal: '下界传送门',

    // 幽匿（Sculk）
    sculk: '幽匿块', sculk_catalyst: '幽匿催发体', sculk_sensor: '幽匿感测体',
    sculk_shrieker: '幽匿尖啸体', sculk_vein: '幽匿脉络', calibrated_sculk_sensor: '校频幽匿感测体',

    // 羊毛 / 地毯 / 混凝土（颜色共用材质）
    wool: '羊毛', carpet: '地毯', concrete: '混凝土', concrete_powder: '混凝土粉末',
    terracotta: '陶瓦', glazed_terracotta: '带釉陶瓦', stained_glass: '染色玻璃',
    stained_glass_pane: '染色玻璃板', glass: '玻璃', glass_pane: '玻璃板',
    banner: '旗帜', candle_cake: '插上蜡烛的蛋糕',
    // §3.1：cloth 是羊毛的材质音效组（中文 Wiki「布料」页只是重定向到羊毛），
    // 旧值「布料」会让 6 条事件指向不存在的方块
    cloth: '羊毛',
    // §五「资料不足，不猜」：这几条 Wiki 上没有对应方块页（copper_bricks /
    // dry_grass / wet_grass），没有可靠依据，故保留原值、只作标记，不编造新名。
    wet_grass: '湿润草方块', dry_grass: '干草',

    // 其他
    item: '物品', honey: '蜂蜜', honey_block: '蜂蜜块', slime: '黏液块',
    slime_block: '黏液块', honeycomb: '蜜脾', bone: '骨块', bone_block: '骨块',
    lodestone: '磁石', netherite: '下界合金', target: '标靶',
    lightning_rod: '避雷针', tripwire: '绊线', tripwire_hook: '绊线钩',
    ladder_hit: '梯子撞击', metal: '金属', wood_hit: '木头撞击',

    // 补充：原版事件里出现但上面没覆盖的方块/物件
    // §4.2：官方字幕用「下界木质」（绯红木/诡异木没有统称），
    // 逐条写全，避免拼成「下界木门」这种非官方名
    nether_wood: '下界木质', nether_wood_button: '下界木质按钮',
    nether_wood_door: '下界木质门', nether_wood_trapdoor: '下界木质活板门',
    nether_wood_fence_gate: '下界木质栅栏门',
    nether_wood_hanging_sign: '悬挂式下界木质告示牌',
    nether_wood_pressure_plate: '下界木质压力板',
    wooden_door: '木门', wooden_trapdoor: '木活板门',
    hanging_sign: '悬挂式告示牌', froglight: '蛙明灯',
    heavy_core: '沉重核心', pink_petals: '粉红色花簇',
    large_amethyst_bud: '大型紫晶芽', medium_amethyst_bud: '中型紫晶芽',
    small_amethyst_bud: '小型紫晶芽',
    amethyst_bud: '紫晶芽', budding_amethyst_block: '紫水晶母岩',
    fish: '鱼', agent: '智能体',
  };

  // -------------------------------------------------------------------------
  // 生物名（Wiki 权威中文名）
  // -------------------------------------------------------------------------
  const MOB = {
    // 友好生物（Wiki「友好生物」章节）
    allay: '悦灵', armadillo: '犰狳', armor_stand: '盔甲架', bat: '蝙蝠',
    camel: '骆驼', camel_husk: '骆驼尸壳', chicken: '鸡', cod: '鳕鱼',
    copper_golem: '铜傀儡', cow: '牛', donkey: '驴', glow_squid: '发光鱿鱼',
    happy_ghast: '快乐恶魂', horse: '马', mooshroom: '哞菇', mule: '骡',
    parrot: '鹦鹉', pig: '猪', rabbit: '兔子', salmon: '鲑鱼', sheep: '绵羊',
    skeleton_horse: '骷髅马', sniffer: '嗅探兽', squid: '鱿鱼', strider: '炽足兽',
    tadpole: '蝌蚪', tropical_fish: '热带鱼', turtle: '海龟',
    wandering_trader: '流浪商人', zombie_horse: '僵尸马',
    goat: '山羊', pufferfish: '河豚', sulfur_cube: '硫方怪', villager: '村民',
    axolotl: '美西螈', cat: '猫', frog: '青蛙', ocelot: '豹猫',
    snow_golem: '雪傀儡', bee: '蜜蜂', dolphin: '海豚', fox: '狐狸',
    irongolem: '铁傀儡', llama: '羊驼', nautilus: '鹦鹉螺', panda: '熊猫',
    polar_bear: '北极熊', trader_llama: '行商羊驼', wolf: '狼',
    zombie_nautilus: '僵尸鹦鹉螺',
    // 敌对生物（Wiki「敌对生物」章节）
    blaze: '烈焰人', bogged: '沼骸', breeze: '旋风人', creeper: '苦力怕',
    elder_guardian: '远古守卫者', endermite: '末影螨', evoker: '唤魔者',
    ghast: '恶魂', guardian: '守卫者', hoglin: '疣猪兽', husk: '尸壳',
    magma_cube: '岩浆怪', parched: '焦骸', phantom: '幻翼', piglin_brute: '猪灵蛮兵',
    pillager: '掠夺者', ravager: '劫掠兽', shulker: '潜影贝', silverfish: '蠹虫',
    skeleton: '骷髅', slime: '史莱姆', stray: '流浪者', vex: '恼鬼',
    vindicator: '卫道士', warden: '监守者', witch: '女巫', wither_skeleton: '凋灵骷髅',
    zombified_piglin: '僵尸猪灵', zombie: '僵尸', zombie_villager: '僵尸村民',
    cave_spider: '洞穴蜘蛛', creaking: '嘎枝', drowned: '溺尸', enderman: '末影人',
    piglin: '猪灵', spider: '蜘蛛', zoglin: '僵尸疣猪兽',
    ender_dragon: '末影龙', wither: '凋灵',
    endermen: '末影人', fish: '鱼', agent: '智能体',
    // 旧版 ID 变体（基岩版历史上同一生物有复数写法）
    enderdragon: '末影龙',
    // 卡 t_4e96920b：基岩版旧事件 ID 里远古守卫者写作 elderguardian
    // （mob.elderguardian.curse/death/hit/idle），词典里只有 elder_guardian，
    // 于是这 4 条在「敌对生物」下顶着英文组名。别名表（event-audio.js MOB_ALIAS）
    // 同时把它并回 elder_guardian，和 mob.imitate.elder_guardian 归同一组。
    elderguardian: '远古守卫者',
    // 唤魔者的尖牙（mob.evocation_fangs.attack）：Wiki 条目名就是「唤魔者尖牙」
    evocation_fangs: '唤魔者尖牙',
    wanderingtrader: '流浪商人',
    polarbear: '北极熊',
    snowgolem: '雪傀儡',
    magmacube: '岩浆怪',
    evocation_illager: '唤魔者',
    evoker: '唤魔者',
    illusion_illager: '幻术师',
    // §3.3：「小熊猫」在中文里是另一种动物（红熊猫），熊猫的幼体是「幼年熊猫」
    panda_baby: '幼年熊猫',
    polarbear_baby: '幼年北极熊',
    wolf_baby: '小狼',
    villager_v2: '村民',
    zombie_villager_v2: '僵尸村民',
    zombie_pigman: '僵尸猪灵',
    irongolem_crackiness_high: '铁傀儡',
    irongolem_crackiness_medium: '铁傀儡',
    irongolem_crackiness_low: '铁傀儡',
    piglin_brute: '猪灵蛮兵',
    wither_skeleton: '凋灵骷髅',
    elder_guardian: '远古守卫者',
    cave_spider: '洞穴蜘蛛',
    glow_squid: '发光鱿鱼',
    skeleton_horse: '骷髅马',
    zombie_horse: '僵尸马',
    trader_llama: '行商羊驼',
    armor_stand: '盔甲架',
    tropical_fish: '热带鱼',
    // 音效专用的通用名
    player: '玩家',
  };

  // -------------------------------------------------------------------------
  // 动作名（事件 ID 末段）
  // -------------------------------------------------------------------------
  const ACTION = {
    break: '破坏', place: '放置', hit: '被击中', step: '脚步', fall: '落地',
    dig: '挖掘', land: '落地', jump: '跳跃', climb: '攀爬', use: '使用',
    open: '打开', close: '关闭', fill: '装填', empty: '倒空',
    fill_success: '装填成功', ready: '准备完成', craft: '合成',
    // 生物
    say: '空闲叫声', idle: '空闲音效', ambient: '环境音效', death: '死亡',
    hurt: '受伤', attack: '攻击', eat: '进食', celebrate: '欢呼', trade: '交易',
    growl: '低吼', bark: '吠叫', whine: '呜咽', pant: '喘息', beg: '讨食',
    step_wood: '木质地面脚步', step_sand: '沙地脚步', step_lava: '熔岩上脚步',
    scream: '尖叫', screech: '尖啸', roar: '吼叫', hiss: '嘶嘶声', fuse: '引信',
    blow_up: '爆炸', explode: '爆炸', charge: '蓄力', primed: '引爆前',
    shoot: '射击', shoot_multi: '多重射击', throw: '投掷', throw_potion: '投掷药水',
    repair: '修复', convert: '转化', conversion: '转化', drink: '饮用',
    milk: '挤奶', shear: '剪毛', shear_off: '剪下', wax_on: '上蜡', wax_off: '脱蜡',
    equip: '装备', equip_wolf_armor: '装备狼铠', unequip_wolf_armor: '卸下狼铠',
    break_wolf_armor: '狼铠损坏', armor_break: '盔甲损坏',
    add: '添加', remove: '移除', pickup: '拾取', drop: '丢弃',
    swim: '游泳', splash: '溅水', splashing: '溅水', float: '浮起',
    flap: '振翅', fly: '飞行', glide: '滑翔', land_on: '落上',
    sniff: '嗅探', dig_soil: '刨土', lay_egg: '下蛋', hatch: '孵化',
    love: '求偶', tempted: '引诱', suspicious: '警觉', investigate: '探查',
    scared: '受惊', aggressive: '威吓', angry: '愤怒', happy: '愉悦',
    warble: '鸣叫', chirp: '啾鸣', scream_goat: '山羊尖叫',
    shriek: '尖啸', portal: '传送门', spawn: '生成', travel: '穿梭',
    death_animation: '死亡动作', scan: '扫描', interact: '交互',
    fail: '失败', success: '成功', insert: '放入', insert_fail: '放入失败',
    lit: '点燃', crackle: '噼啪作响', smoke: '冒烟', drip: '滴落',
    extract: '提取', harvest: '收获', harvest_fail: '收获失败',
    prepare_attack: '准备攻击', charge_hold: '蓄力保持', release: '释放',
    stop_charge: '停止蓄力', sound: '音效', scream_attack: '尖啸攻击',
    bite: '咬击', claw: '爪击', sting: '蜇刺', spit: '喷吐',
    blow: '吹气', push: '推动', retract: '收回', extend: '伸出',
    toggle: '切换', press: '按压', lock: '锁定', unlock: '解锁',
    ignite: '点燃', extinguish: '熄灭', extinguish_water: '水中熄灭',
    evaporate: '蒸发', focus: '聚焦', recharge: '重新蓄力',
    absorb: '吸收', resonate: '共振', carve: '雕刻', cut: '剪切',
    tilt_down: '向下倾斜', tilt_up: '向上倾斜', work: '运作',
    combine: '组合', upgrade: '升级', repair_item: '修复物品',
    slime: '黏液', bounce: '弹跳', teleport: '传送', vanish: '消失',
    disappear: '消失', appear: '出现', travel_end: '末地穿梭',
    celebrate_win: '胜利欢呼', convert_to_drowned: '转化为溺尸',
    zombie_convert: '转为僵尸', converted_to_drowned: '转化为溺尸',
    kill: '击杀', resurrection: '复活', summon: '召唤',
    consume: '吞噬', absorb_effect: '吸收效果', swirl: '旋涡',
    horn_break: '角断裂', shear_fail: '剪切失败', milk_fail: '挤奶失败',
    tame_fail: '驯服失败', feed: '喂食', breed: '繁殖',
    roll: '翻滚', sit: '坐下', stand: '站起', worried: '担忧',
    panic: '惊慌', listen: '倾听', accept: '接受', decline: '拒绝',
    yes: '同意', no: '拒绝', raise: '举起', cut_idle: '闲置剪切',
    digging: '挖掘', digging_stop: '停止挖掘', sniffing: '嗅探中',
  };

  // -------------------------------------------------------------------------
  // 分类修正（Wiki 阵营）
  // -------------------------------------------------------------------------
  // Wiki「友好生物」章节——这些不主动攻击玩家，绝不属于敌对
  const FRIENDLY = [
    'allay', 'armadillo', 'armor_stand', 'bat', 'camel', 'camel_husk', 'chicken',
    'cod', 'copper_golem', 'cow', 'donkey', 'glow_squid', 'happy_ghast', 'horse',
    'irongolem', 'llama', 'mooshroom', 'mule', 'nautilus', 'ocelot', 'panda',
    'parrot', 'pig', 'polar_bear', 'pufferfish', 'rabbit', 'salmon', 'sheep',
    'skeleton_horse', 'sniffer', 'snow_golem', 'squid', 'strider', 'sulfur_cube',
    'tadpole', 'trader_llama', 'tropical_fish', 'turtle', 'villager',
    'wandering_trader', 'wolf', 'zombie_horse', 'zombie_nautilus',
    'goat', 'axolotl', 'cat', 'frog', 'bee', 'dolphin', 'fox',
  ];
  // Wiki「敌对生物」章节
  const HOSTILE = [
    'blaze', 'bogged', 'breeze', 'cave_spider', 'creaking', 'creeper', 'drowned',
    'elder_guardian', 'enderman', 'endermite', 'evoker', 'ghast', 'guardian',
    'hoglin', 'husk', 'magma_cube', 'parched', 'phantom', 'piglin',
    'piglin_brute', 'pillager', 'ravager', 'shulker', 'silverfish', 'skeleton',
    'slime', 'spider', 'stray', 'vex', 'vindicator', 'warden', 'witch',
    'wither', 'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager',
    'zombified_piglin', 'ender_dragon',
  ];

  // 不是生物：方块/环境/玩家/UI 事件前缀
  const NON_MOB_PREFIX = /^(block|dig|step|place|break|hit|fall|random|tile|item|ui|note|ambient\.(?!cave|underwater|nether|weather)|apply_effect|crossbow|firework|liquid|copper|beacon|conduit|bell|creaking\.|component|armor|respawn_anchor|raid|weather|music|records|portal|elytra|trial_spawner|vault|bucket|bottle|cauldron|smithing_table|lectern|furnace|blastfurnace|smoker|grindstone|stonecutter|loom|cartography|composter|brewing|enchanting|beacon|conduit)/i;

  window.MCS_WIKI = {
    BLOCK, MOB, ACTION,
    FRIENDLY, HOSTILE, NON_MOB_PREFIX,
  };
})();
