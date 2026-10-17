# MCSoundStudio

我的世界（中国版基岩版 / ModSDK）音效时序编辑器。

把 GIF 或 Blockbench 动画丢进来当作视觉参考，像剪辑一样在时间轴上拖排音效，
然后导出**策划案 Markdown** + **ModSDK Python 代码** + **sound_definitions.json**。

---

## 已验证的功能

下面这些不是「写完了」，是真机跑过测试的（每条都由 `scripts/` 下的脚本复现；**`scripts/` 只在开发仓库里，对外源码树不含它**，见下面「脚本（`scripts/`）与对外源码树」）：

| 功能 | 验证方式 | 结果 |
|---|---|---|
| GIF 暂停定格 | 真实窗口 + 真实鼠标点暂停，画布像素间隔 2.5s 三次采样 | 三次哈希完全一致 ✓ |
| GIF 反向拖动 | 真实鼠标拖标尺往回，比对画布像素与 GIF 时刻 | 倒退到位、松手不弹回 ✓ |
| GIF 播放中拖动 | 播放中按住标尺往回拖，检查画面跟手 | 画面跟手、不被音频时钟抢回 ✓ |
| GIF 播到末尾之后 | 时间轴比 GIF 长时拖到末尾之外 | 停在最后一帧，元信息写「已放完」 ✓ |
| GIF 单独预览（没有音效） | 只有 GIF 没片段时按播放 | 播放头与画面都推进、暂停能定格 ✓ |
| 视频同步 | `<video>` 原生 seek | 前进/倒退都准 ✓ |
| 波形预览 | 片段内 Canvas 真实像素 | 每个片段都有波形 ✓ |
| 属性试听 | 音频节点计数 | 真的创建了音频源 ✓ |
| **轨道静音** | 播放时统计音频节点 | 静音后 1 → **0** 个节点，确实不发声 ✓ |
| 轨道独奏 | `muted` 标志计算 | 非独奏轨自动静音 ✓ |
| 轨道删除 | 连带清理片段 | ✓ |
| BPM 拍线 | 120 BPM 落点核对 | `1250ms → 第3拍 +50%` ✓ |
| 工程存盘往返 | 存盘后读回逐字段比对 | 音量/音高/中文备注全部保留 ✓ |
| 导出 5 个文件 | 真实写出并检查内容 | ✓ |
| 中文描述 | 自动审计 + 钉死回归 | 1079 条 **0 缺陷** ✓ |
| 同名事件 | 重复描述检测 | 126 条 → **35 条** ✓ |
| 模型导入 | `samples/` 里的真实 `.bbmodel`（外加可选的 Downloads 真文件） | 全部解析成功 ✓ |
| 骨骼校对 | 动画 vs 模型逐骨骼 | 41 匹配 / 0 缺失 ✓ |
| **模型画到预览画布** | 真实窗口 + 画布像素指纹（`samples/robot-arm.bbmodel` ＋ Downloads 里的真文件） | 5 立方体/4 骨骼/30 面全部画出、贴图真的被采样 ✓ |
| **动画套用到画布姿态** | 三个时刻的画布指纹两两不同（0 / 500 / 1000ms） | 姿态真的跟着播放头变 ✓ |
| **工程总览（工程库）** | 真实窗口 + 工程库目录里的真工程 | 列表/元数据/缩略条/点卡片导入 ✓ |
| **导入失败诊断** | `samples/broken/` 下的坏样例（空、截断、BOM、全角逗号、导错按钮…） | 每条都给位置 + 原因 + 怎么修 ✓ |

重跑全部检查（**核心回归 = 一条命令**）：

```bash
node scripts/run-core-regression.js            # ← 核心回归：10 项 Node-only 检查（8 必过 + 2 可选），任一项判红总退出码就是 1
node scripts/run-core-regression.js --list     # 只列清单，不跑
node scripts/run-core-regression.js --strict   # 可选项被跳过（本机没有真实 GIF/模型）也算失败
node scripts/run-core-regression.js --only desc-regression,smoke-test
node scripts/run-core-regression-selftest.js   # 检查器自测 14 场景（证明子命令失败会传导、退出码 0 也拦得住假绿）
```

> 判结论只看退出码：`0` = 全部必过项通过；`1` = 有判红项。
> 机器可读结果在 `tmp-qa/run-core-regression.json`，人类摘要在 `tmp-qa/run-core-regression.txt`。
> 只有排查单项问题时才逐个跑：

本卡（工程总览 / 模型动画预览）新增的检查也能单独跑：

```bash
node scripts/model-pose-test.js        # 姿态采样 + 投影 + 导入诊断（吃 samples/ 里的真样例；项数看它自己打印的「通过 N / 失败 0」）
node scripts/project-library-test.js   # 工程库扫描 / 元数据 / 最近工程 / 缺失处理（同上，别在文档里写死项数）
node scripts/gen-samples.js            # 重造 samples/ 下的样例（--check 只校验是否与生成脚本一致）
./node_modules/electron/dist/electron.exe scripts/model-preview-e2e.js   # 真窗口端到端（含截图）
node scripts/probe-packaged-help.js    # 打包产物里的教程 == 当前 src/renderer/help.html？（需先 npm run dist）
```

```bash
node scripts/desc-regression.js     # 中文描述不能退化
node scripts/audit-desc.js          # 描述质量审计
node scripts/verify-path-rebind.js  # 音频路径全部可达
node scripts/gif-parse-real.js "<你的GIF路径>/养护核心.gif"   # GIF 逐帧解析结果（帧数/延迟/disposal）；把示例路径换成你自己的 GIF

# 需要窗口的（用 electron 跑）
#   GIF 同步回归：可见窗口 + 真实鼠标事件。退出码 0 = 该轮没判红，**不等于「全通过」**：
#   拖动期间若有真实鼠标划过窗口，app 的 `e.buttons===0 → endScrub()` 守卫会按设计收尾拖动，那一轮就会判红。
#   判定标准是「连续多轮全绿 + 侵入事件计数为 0」。
./node_modules/electron/dist/electron.exe scripts/gif-real-regression.js
./node_modules/electron/dist/electron.exe scripts/mute-audio-test.js
./node_modules/electron/dist/electron.exe scripts/roundtrip-test.js
./node_modules/electron/dist/electron.exe scripts/workflow-test.js
./node_modules/electron/dist/electron.exe scripts/bpm-test.js
#   片段缩放变速 / Alt 非破坏性裁剪 / 淡入淡出与预设（卡 t_47b9fab2）：
#   真窗口 + 真鼠标键盘，47 项断言（含播放调度探针：声音不得越过片段条）。退出码 0 = 全绿。
./node_modules/electron/dist/electron.exe scripts/clip-trim-fade-test.js
```

> **干净克隆（`git clone` 出来的仓库）里跑同一条核心回归**：10 项里有 1 项会判「⛔ 阻塞」而不是通过 ——
> `verify-path-rebind` 要逐条核对 `sounds/vanilla/audio/`（686 MB / 3717 个 OGG）里的文件是否真在，
> 而这个目录按设计**不入库**（`.gitignore` 第 2 行）。把它放回去再跑就是全绿；没放回去时它会明说
> 「阻塞：缺少输入 sounds\vanilla\audio」——**「阻塞」不等于「通过」**，别当成绿。
> 另外：仓库根的 `.gitattributes` 把行尾钉死了（文本一律按 LF 存储、按 LF 检出），
> 所以默认 `core.autocrlf=true` 的 Windows 克隆也不会把 `sounds/vanilla/library.json` 变成 CRLF ——
> 一旦变 CRLF，`verify-wiki-audit` 的 sha256 基线断言（第 4 项）就会失败。
> 打包产物里的教程是不是当前这一版，用 `node scripts/probe-packaged-help.js` 复核（需要先 `npm run dist:portable`，
> 它读的是 `dist/win-unpacked/MCSoundStudio.exe`）。这条同样是**开发仓库**的脚本。

---

## 脚本（`scripts/`）与对外源码树

**事实先摆清**：对外发布的源码树（公开仓库 / Release 里的源码）**不含 `scripts/` 目录**；
`package.json` 里 4 个 `verify:*` npm 脚本也都指向 `scripts/` 下的文件。
它们只存在于开发仓库（写这些测试的那一份），在对外源码树里跑会直接
`MODULE_NOT_FOUND`（例如 `npm run verify:portable-startup`）—— 那不是程序坏了，是这条命令本来就没随源码发出去。

所以本文按两类读者分档：

- **只想构建一个能跑的版本（绝大多数人）**：走「快速开始」里的 `npm ci` → `npm run dist:portable`，
  然后双击 `dist/win-unpacked/MCSoundStudio.exe`。看到 `node scripts/…`、
  `./node_modules/electron/dist/electron.exe scripts/…`、`npm run verify:*` 这类命令，
  那是**开发仓库的自测记录**（用来复核本页那张「已验证的功能」表），对外源码树里没有这些文件，跳过即可。
- **要复现「实测数字」**：那张表每一行的「怎么复现」都只用 `npm ci` + `npm run dist:portable` +
  程序自己的「导出系统信息…」或一段 `node -e` 统计，**不需要 `scripts/`**。

---

## 快速开始

```bash
cd <你的克隆目录>
npm ci                    # 装依赖（首次构建/运行必做；锁文件已入库，产物可复现）
npm start
```

构建（**当前交付形态 = 免安装「解压即用」ZIP**）：

```bash
npm ci                    # 首次构建必做（锁文件已入库，产物可复现）
npm run release:zip       # → release/MCSoundStudio-<版本>-win-x64.zip
```

产物（体积一律**现场量**，别在文档里写死 —— 命令见表格下面；本文给出的值是本机实跑结果，见「实测数字」）：

| 路径 | 用途 |
|---|---|
| `release/MCSoundStudio-<版本>-win-x64.zip` | **交付形态本体**：解压出单个 `MCSoundStudio/` 目录，双击里面的 `MCSoundStudio.exe` 即用，**自带原版音频** |
| `release/MCSoundStudio/` | 打 ZIP 前的同一份内容（`dist/win-unpacked/` + `LICENSE` / `THIRD_PARTY_NOTICES.txt` / `README.md`），可直接运行 |
| `dist/win-unpacked/` | electron-builder `--dir` 产物，ZIP 就是把它整体收进去；一般不直接发 |

**不产出安装器**：`package.json` 的 `win` 里没有 installer target（无 NSIS），不创建桌面/开始菜单快捷方式，发布物只有那个 ZIP。

**运行数据全部落在解压目录**：`MCSoundStudio/data/`（工程库 `projects/`、最近工程索引与配置、`session/`、`crash-dumps/`、`temp/`、`logs/`、默认导出 `exports/`）。不写 `%APPDATA%` / `%LOCALAPPDATA%` / `%TEMP%`，删掉解压目录即移除全部数据。

量交付目录体积 / 文件数（**这段在对外源码树里也能直接粘贴执行**：先在仓库根跑 `npm ci` → `npm run dist:portable`）：

```bash
node -e "const fs=require('fs');let n=0,b=0;(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=d+'/'+e.name;if(e.isDirectory())w(p);else{n++;b+=fs.statSync(p).size}}})('dist/win-unpacked');console.log(n+' 个文件 / '+b+' 字节 / '+(b/1048576).toFixed(2)+' MiB')"
# 本机实测输出（对外源码树 clone 之后构建，2026-10-17）：3793 个文件 / 994036926 字节 / 947.99 MiB
# 字节数随「怎么检出」差约 1.5 KB（1,525 字节）：开发工作区里 `src/renderer/style.css`（1190 个 CRLF）
# 和 `src/renderer/wiki-names.js`（335 个 CRLF）这两个文件是按 CRLF 落在磁盘上的，导出树照抄成 CRLF；
# `.gitattributes` 钉了 `eol=lf`，所以 clone 检出的是 LF 版本 —— 两种检出差的正好是 1190 + 335 = 1,525 字节。
# 直接在导出目录里构建用的是工作区的 CRLF 版本（994038451 字节）。**文件数与 MiB 两种检出都一样**。
# 在**开发仓库**里跑同一条命令会多 1 个文件（`resources/sounds/vanilla/missing.txt`，它只在开发仓库里、
# 不进对外源码树）→ 3,794 个文件 / 948.34 MiB。所以本文只认「对外源码树 clone 构建」这一套：
# **3,793 个文件 / 947.99 MiB**。
```

> **交付目录本体 = `release/MCSoundStudio/`（= ZIP 解压出来的 `MCSoundStudio/`）**：带内置音频实测 **947.99 MiB / 3,793 个文件**；
> 同一棵源码树里没有 `sounds/vanilla/audio/`（无音频构建）实测 **261.67 MiB / 76 个文件**。
> 两者都见「系统要求 → 实测数字」。开发仓库里还有 `node scripts/make-release.js --info`
> （交付目录 + exe 字节数与 sha256 + .ogg 数一次列全，只读不写盘）—— 那需要 `scripts/`，对外源码树里没有。

> **单文件 portable exe 已经废弃**（卡 t_7514dfa8 定案）。那种形态每次启动都要先把约 740 MB
> 解到 `%TEMP%`，在 Electron 起来之前就无窗口假死，所以 `package.json` 里既没有 portable
> target 也没有 NSIS target：`npm run dist:portable` 只是 `electron-builder --win --x64 --dir`，
> 产物是 `dist/win-unpacked/` 目录，而 `npm run release:zip` 把它压成唯一对外发布的
> `release/MCSoundStudio-<版本>-win-x64.zip`。**别再去找
> `dist/MCSoundStudio-<版本>-portable.exe` 或 `MCSoundStudio Setup <版本>.exe`，它们都不会被产出**。

应用图标在 `build/icon.ico`（7 种尺寸：16/24/32/48/64/128/256），
窗口与任务栏也用 `build/icon.png`，不再是 Electron 默认图标。

### 打包注意事项

**Release ZIP 自带原版音频，源码仓库不带。** `sounds/vanilla/audio/`（实测 3717 个 OGG / 686.3 MiB）由
`build.extraResources` 整体复制到 `<resources>/sounds/`，所以 `npm run release:zip` 产出的 ZIP 解压后
约 948 MiB（本机实测 **947.99 MiB / 3,793 个文件**，见「实测数字」）且
**自带全部音频**——用户解压即能试听，不需要在旁边另放音频文件夹。
`publish-export` 导出对外源码树时默认**不带音频**（`--with-audio` 才带，`.gitignore` 也忽略该目录），
所以从公开仓库 clone 出来的源码树构建出的是「无音频构建」；要让试听可用，请直接下载 Release ZIP，
或自备音频放进 `sounds/vanilla/audio/`。
（历史上这里曾用 `!vanilla/audio/**` 把音频排除出包，导致 72 MB 的 exe 试听全哑；
`scripts/check-packaging-audio.js` 专门守着这条回归 —— 别为了压体积把这条 filter 去掉。）

**交付形态是目录版，不是单文件 exe。** 单文件 portable 版每次启动都要先把约 740 MB 解到
`%TEMP%`，在 Electron 起来之前就无窗口假死（卡 t_7514dfa8 结论），已废弃：
`package.json` 里没有 portable target，`npm run dist:portable` 实际是
`electron-builder --win --x64 --dir`，产物是 `dist/win-unpacked/` 目录。
体积与会话相关的数字一律现场量，不写死（对外源码树用「快速开始 → 量交付目录」那条 `node -e`；
开发仓库另有 `node scripts/make-release.js --info`）。打包完先跑 `node scripts/check-packaging-audio.js`（**仅开发仓库**）。

音频目录的查找顺序（主进程 `findAudioDir()`，见 `src/main/main.js`）：

```
1) <exe 所在目录>/audio/                  ← 用户自己放音频用，最优先
2) <exe 所在目录>/sounds/vanilla/audio/
3) <resources>/sounds/vanilla/audio/      ← 打包进来的内置音频
   （目录版就在 exe 同级的 resources\ 下，靠 process.resourcesPath 找；已废弃的单文件版才在 %TEMP% 解包目录里）
4) library.json 同级的 audio/             ← 开发环境
```

**如果打包报 `Cannot create symbolic link ... libcrypto.dylib`**：

electron-builder 会**无条件**下载解压 `winCodeSign` 工具包（即使不签名），
其中 macOS 用的 dylib 符号链接在 Windows 非管理员会话下建不出来，
导致解压被判定失败、构建中止。**`signAndEditExecutable: false` 挡不住这一步** ——
解压发生在更早阶段。Windows 打包根本用不到那些 dylib。

一条命令修好（**不需要管理员权限**；但这条 `node scripts/…` **仅开发仓库可用** —— `scripts/` 不在对外源码树里，所以从公开源码树自己构建的用户跑不了这条命令，本节只作为「本机构建踩到这个坑时的成因与修法说明」保留）：

```bash
node scripts/fix-wincodesign-cache.js
```

它会自己解压该包（跳过整个 `darwin/` 目录），放进 electron-builder 期望的
缓存路径 `winCodeSign-2.6.0/`。缓存命中后就不会再碰那个有问题的包。
脚本是幂等的，重复运行无害。

验证打包产物（**仅开发仓库**：下面这几条都在 `scripts/` 下，对外源码树里没有）：

```bash
node scripts/check-packaging-audio.js           # 快：打包声明 + 音频解析回归（改打包配置后必跑）
node scripts/verify-packaged-audio-e2e.js       # 成品 exe：启动 + 真解码试听 + 包内音频完整性（可传路径：… <exe>）
node scripts/verify-packaged.js                 # 目录版（dist/win-unpacked）：资源完整性 + 启动
node scripts/verify-portable.js                 # 已废弃的单文件版专用（它找 dist/*-portable.exe，现在没有），存量回归才跑
node scripts/lib/portable-temp.js               # 看/清 %TEMP% 里的 ns*.tmp 与解包根（见「工程卫生」）
```

`verify-packaged-audio-e2e.js` 是黑盒验证：启动真正的 exe（带 `--remote-debugging-port`），
连上它的渲染进程，调真实的 `loadVanillaLibrary()` / `MCS_AUDIO.probeDuration()`，
断言音频目录落在**运行中的包内**、目录里 3717 个 .ogg 真的在、某个变体真的能解码出声。
不依赖开发仓库里的 `sounds/vanilla/audio`（那会让测试假通过）。

---

## 系统要求

### 硬性要求（能不能跑）

| 项 | 要求 | 依据 |
|---|---|---|
| 操作系统 | **Windows 10 x64（1809 及以上）** 或 **Windows 11 x64** | 这是这一档窗口程序（Electron 31 / Chromium 126）能跑的系统下限。Windows 10/11 自带的组件就够，**不需要**另装 .NET / Java / 运行库 |
| 磁盘 | **约 1 GB（只放交付目录）／约 3 GB（还要从源码自己构建）** | 交付目录本体（`dist/win-unpacked/`，带内置音频）实测 **947.99 MiB / 3,793 个文件**；从源码构建另需源码树约 689 MiB + `npm ci` 的依赖约 452 MiB + 构建产物 947.99 MiB（本机实测整个构建工作区约 2.8 GB）。它是**免安装目录版**，拷走就能用，不写系统目录 |
| 内存 | **4 GB（推荐 8 GB）** | 打包版（`dist/win-unpacked/`）实测：加载完整音效库后，程序整套 **4 个进程的工作集合计 409.9 ~ 438.8 MB**（`app.getAppMetrics()`，10 次运行的区间；开发模式那套约 470 ~ 480 MB）。4 GB 是「系统 + 其它程序 + 本程序」都装得下的要求，不是本程序的占用 |
| 显卡 | **无需独立显卡** | 渲染层是 Canvas 2D —— `src/` 里搜不到任何 WebGL / three.js / GPU 计算调用（只有 `getContext('2d')`），`package.json` 也没有图形库依赖。核显、甚至软件渲染都能跑 |
| 位数 | **只提供 x64** | `package.json` → `build.win.target.arch = ["x64"]`；ARM 版 Windows 不在本次交付范围内 |

> ⚠️ 「硬性要求」是按运行时下限 + 本机实测给的**判断**，不等于「这些组合我们都验过」。哪些是真跑过的、哪些只是推算，看下一节。

### 已实测 / 未实测（别把推算当验证）

**已实测（真机跑过）**：一台 **Windows 11 x64** 笔记本 ——
`10.0.26200`（build 26200）、i9-13900HX（32 逻辑处理器）、31.7 GB 内存、
Intel 核显（PCI `0x8086:0xA788`）+ NVIDIA 独显（PCI `0x10DE:0x2F18`，即本机的 RTX 5070 Ti Laptop 12GB）、
2560 x 1600 屏（150% 缩放）、Chromium 未回退软件渲染。

**未实测（推算，别当验证）**：其余 Windows 版本与 build、**纯核显机器**、虚拟机、4 GB 内存的机器、
低于 2560 x 1600 的屏幕 —— 这些都没在这个项目上跑过，上面的「硬性要求」只是按运行时下限推的。

**想让自己的机器变成「已实测」**：起始页 →「**系统信息 → 导出系统信息…**」，
把生成的 txt 发回来就行（那里面是程序现场读出来的机器坐标，见下）。

### 实测数字（跑出来的，不是估算）

| 指标 | 实测值（本机，2026-10-17） | 怎么复现 |
|---|---|---|
| **首次加载原版库耗时** | **71 ~ 126 ms**（打包目录版 `dist/win-unpacked`，每次都是关掉程序重开后的第一次点「原版库」，口径＝从点按钮到状态栏出现「已加载原版音效库」）。本机 10 次：开发仓库那次构建 7 次 88 / 105 / 120 / 95 / 84 / 89 / 89 ms，重新导出的对外源码树构建 3 次 126 / 97 / 94 ms；之后两组独立复核各 6 次：**71 / 76 / 76 / 81 / 83 / 96 ms**（第 3 轮验收）和 **82 / 83 / 86 / 87 / 87 / 88 ms**（本轮，用导出树 clone 出来重新构建的包）。两组都出现低于 84 的样本（最低 71），所以下限按 71 ms 写。**文件缓存冷透时会更慢**（刚构建完的第一次启动）：同机独立复核量到 **210 ms**，所以真实范围是 71 ~ 210 ms，单一数字复现不了 | 双击 `dist/win-unpacked/MCSoundStudio.exe` → 点「原版库」→ 起始页「系统信息 → 导出系统信息…」→ txt 里「首次加载库耗时」那一行 |
| **内存占用**（加载完库那一刻） | **409.9 ~ 438.8 MB**（同口径 10 次运行，4 个进程工作集相加：411.4 / 409.9 / 411.7 / 429.7 / 430.5 / 429.0 / 432.4 MB + 重导出树构建 438.8 / 432.8 / 433.0 MB。分项里 Browser 99.3~102.4 / Tab 92.4~99.2 / Utility 43.8~44.4 MB 基本不动，**差的全在 GPU 进程的两种状态：172.4 ~ 193.9 MB**） | 同一份 txt 的「本次会话的内存占用 → 进程组合计」那一行 |
| 音效库规模 | **1079 个事件 / 4234 个变体 / 磁盘上 3717 个 .ogg（686.3 MB）**，索引 `library.json` 约 **1.1 MiB**（打包树里 1,160,794 字节 —— 导出时绝对路径被改成相对路径，所以比开发仓库里的版本小；开发仓库那份带 `absPath` 的是 1,300,516 字节 / 1.3 MB） | 程序内加载「原版库」后看状态栏，或 txt 的「音效库规模」 |
| 交付目录体积 | **947.99 MiB / 3,793 个文件**（带内置音频）；**261.67 MiB / 76 个文件**（同一棵源码树不含 `sounds/vanilla/audio/` 时的构建） | `npm ci` → `npm run dist:portable` → 「快速开始 → 量交付目录」那条 `node -e`（在仓库根跑，量 `dist/win-unpacked/`） |

> **口径说明（两套值别混着看）**
>
> - 上表都是**打包目录版**（`dist/win-unpacked/MCSoundStudio.exe`，真窗口）量的。
> - 「首次加载库耗时」与「内存」两行给的是**多次运行的真实区间**，不是估算：耗时基本只受文件缓存冷热影响，
>   内存的差别几乎全在 GPU 进程（172.4 ~ 193.9 MB 两种状态）；这两个量本来就不是一个固定值，任何单一数字都复现不了。
> - 同一口径在**开发模式**（源码跑 `npm start`，由开发仓库的 `scripts/sysinfo-export-test.js` 驱动 —— 对外源码树里没有这个脚本）实测 2 次：
>   首次加载库 **80 / 82 ms**；加载完库那一刻 **479.8 / 469.3 MB**（GPU 进程 224.2 / 224.0 MB，比打包版大 30~50 MB）。
>   所以「内存 4 GB」这条按两套里更大的那套（≈480 MB）算也够。
> - 无音频构建的复现口径：把 `sounds/vanilla/audio/` 挪走再 `npm run dist:portable`，产出的 `dist/win-unpacked/`
>   是 **261.67 MiB / 76 个文件**（3717 个 .ogg 一个都不在）。**别把启动过程序之后落进产物目录的缓存算进去** ——
>   程序运行时会写 `userdata/`（Code Cache / GPUCache / Local Storage…），若它落在 `dist/win-unpacked/` 里，
>   同样的构建会变成 111 个文件、+1.67 MiB（本机实测），那不是交付物。
> - 上面每个数字都能用**程序自己导出的那份 txt** 在现场复核一遍；不信文档就自己导一次。

### 导出系统信息（一键回传机器坐标）

起始页最下面一栏「系统信息 → **导出系统信息…**」会写一个 txt 到你自己选的位置，里面有：

```
Windows 版本与 build（含「Windows 10 / 11」的按 build 推断结论）、位数
Electron / Chromium / Node / V8 版本
CPU 型号与逻辑处理器数、物理内存（总量与可用量）
显卡设备 + app.getGPUFeatureStatus() 逐项 + 是否回退到软件渲染
屏幕分辨率与缩放（含物理分辨率的推算口径）
音效库规模（事件数 / 变体数 / 磁盘上真实的 .ogg 个数）与首次加载库耗时
本次会话的进程组内存占用
```

全是**导出这一刻现场读出来的**（`os` / `process` / `app.getAppMetrics()` 的实时值），
没有一个数字是从文档里抄的，也**不含用户名、主机名**等个人信息 —— 可以直接发给别人。

排查「跑不起来 / 很卡 / 画面怪」时，先要这份 txt，比来回问「你什么电脑」快得多。

自动化 / 复核用（不弹框、不写盘，只把同一条生成逻辑的文本打出来；**仅开发仓库**，要 `scripts/`）：

```bash
./node_modules/electron/dist/electron.exe scripts/sysinfo-export-test.js
# 真窗口 + 真鼠标点「导出系统信息…」→ 写出 txt → 逐条与现场实测值核对；
# 结论只看它最后那行「全绿：0 项判红」（项数以它自己打印的为准，别在文档里写死）。
```

---

## 界面说明

```
┌─ 顶栏：← 工程 · 新建/打开/保存 · 导入GIF/视频/模型/动画 · 网格/BPM/总长 · 导出全部 ─┐
├──────────┬────────────────────────────────┬──────────┤
│ 音效库    │ ① 模型/GIF 调整 · ② 音效        │ 调整页：素材/角度/动画 │
│          │ 预览区（看模型 / 看画面）        │ 音效页：属性/校验/导出 │
│          ├────────────────────────────────┤ 校验     │
│ 内置      │ 传输控制（播放/停止/音量/缩放）  │ 导出     │
│ 扫描…     ├────────────────────────────────┤          │
│ +文件     │ 时间轴：标尺 + 多轨道 + 片段     │          │
└──────────┴────────────────────────────────┴──────────┘
```

工作流：在起始页「＋ 新建工程」或「打开工程文件…」进入工作页；导入模型、动画或画面后先到「① 模型/GIF 调整」摆角度、选择动画与素材，需要配音时再点「② 音效」。模型与画面素材各自有独立的移除入口，删错可用 `Ctrl+Z` 恢复。

### 内置使用教程（离线）

起始页的 **「打开使用教程」**（编辑时也可按 <kbd>F1</kbd>）打开的是一份**内置的 HTML 使用教程**，文件在
`src/renderer/help.html`：内容是工程 / 导入 / 时间轴 / 音效编辑 / 导出 / 快捷键六块
（外加常见问题），样式全部内联、**没有任何外部资源** —— 断网、或者把 exe 拷到没有网的机器上
照样能看。这个文件本身也可以直接双击用浏览器打开（要给别人传阅时很方便）。

实现上它是主进程开的独立窗口（`src/main/help.js` 的 `open-help`，`loadFile` 加载 asar 内的
那一份），不是主窗口里的弹窗 —— 可以一边看教程一边操作主界面。万一窗口开不出来，会退回
主窗口内的同内容弹窗，Help 不会变空。

起始页的 **「作者 · B 站主页」**（以及教程页里的同名按钮）走 `shell.openExternal`
打开 `https://space.bilibili.com/50955238`，用的是**系统默认浏览器**，程序里不内嵌网页。

自动验证：

```bash
# 下面两条仅开发仓库可用（scripts/ 不在对外源码树里）
node scripts/verify-help-e2e.js                 # 开发环境
node scripts/verify-help-e2e.js dist/win-unpacked/MCSoundStudio.exe   # 打包成品（目录版）
```

它验的是「用户视角的事实」：教程窗口真的开出来、六个主题都在、把 http/https 全部拉黑后
重新加载仍然完整排版（真离线）、作者按钮把准确地址交给系统浏览器、兜底弹窗仍有内容，
并在 `dev-verify-t_7ee2bf5b/` 留下截图与 `help-e2e-report.json`。

### 音效库

三个按钮：

| 按钮 | 作用 |
|---|---|
| **原版库** | 加载 **1079 个原版基岩版音效事件**（4234 个音频变体），按分类分组 |
| **扫描…** | 选择任意文件夹，递归索引其中的 ogg/wav/mp3/flac |
| **+文件** | 单独添加几个音频文件 |

鼠标悬停条目右侧出现 `▶` 可试听。**直接拖到时间轴上即可使用。**

#### 原版库怎么用

事件条目**第一行是中文描述，第二行是事件名**，例如：

```
石头挖掘音效
dig.stone
```

直接搜索中文也能查到（搜「铁傀儡」会列出它的全部音效）。

**折叠分组**：左侧是两级可折叠结构 ——

```
▾ 原版 · 方块 426
▸ 原版 · 友好生物 254
    ▸ 铁傀儡 4
    ▸ 熊猫 9
    ▸ 末影人 12
    ...
▸ 原版 · 敌对生物 202
```

点分组标题展开 / 收起，展开状态会记住，不用一直拉很远。

**收藏**：点条目右侧的 `☆` 收藏，收藏的音效会置顶在「★ 收藏」分组里，
跨会话保留（localStorage）。

**变体**：条目右侧有个 `×N` 角标 —— 这表示**该事件有 N 个音频变体，
游戏内会随机挑一个播**。这是原版自带的行为，不用管，拖进去就行。

> 鼠标悬停在 `×N` 上会弹出变体列表，可以逐个试听，选定某个变体听效果。

**试听**：鼠标悬停条目，右侧出现 `▶`。同一时刻只播一个音效（不会叠在一起）。

分类覆盖：

| 分类 | 事件数 | 用途 |
|---|---|---|
| 方块 | 426 | 按钮、活塞、铜块、门、铁砧、挖掘、放置、脚步（含物品用途的盔甲/桶音） |
| 友好生物 | 254 | 铁傀儡、熊猫、狼、村民、羊驼…（按生物二级分组） |
| 敌对生物 | 202 | 僵尸、骷髅、苦力怕、劫掠兽…（按生物二级分组） |
| 玩家 | 157 | 攻击、受伤、拾取、升级、弩、盔甲穿脱、鞘翅滑翔 |
| 环境 | 23 | 洞穴、水下、下界、天气（含长短 loop） |
| 瓶子 | 3 | 瓶子装水 / 倒空 / 收集龙息（官方 `category=bottle`） |
| 界面 | 4 | 石切/织布/制图台等交互 |
| 天气 | 3 | 雨、雷 |
| 其他 | 7 | 矿车、袭击号角、智能体生成等不属以上分类的 |

> ⚠️ 原版 `category` 字段本身有不少错误（铁傀儡、熊猫、北极熊被标成「敌对生物」，
> `copper.wax.on` 这类方块音被标成「中立生物」）。工具会**自动修正**后再展示。

机器 mod 最常用的那批（活塞、按钮、门、铁砧、铜块、链、脚步、挖掘、信标、导管、
爆炸、玻璃、金属压力板…）**实测 68/68 全覆盖**。

### 时间轴

- **拖拽音效**：从左侧列表拖到任意轨道
- **移动片段**：按住片段左右拖，会自动吸附到网格
- **改长度**：拖片段右侧的边缘
- **选中片段**：点一下，右侧「属性」页出现参数
- **拖动标尺**：移动播放头，音频和 GIF 都会同步到该时间点
- **Alt + 滚轮**：缩放时间轴（以鼠标位置为锚点）
- **空格**：播放 / 暂停
- **Delete**：删除选中片段

一条时间轴对应多个**轨道**（分层）。点轨道区左上角的 **`+ 轨道`** 新建，
双击轨道名可以重命名。每个轨道可以 `M` 静音、`S` 独奏。
分层很适合「机械层 + 音效层 + 环境层」这种结构。

### 预览同步

GIF 是一帧一帧真解码出来的（不是丢给 `<img>` 让浏览器自己播），
所以 GIF 的位置**完全由时间轴播放头决定**，行为跟视频一样可控：

| 你的操作 | GIF 的反应 |
|---|---|
| 播放（▶ 或空格） | 跟着播放头走；视频 / GIF 都同步 |
| 暂停 | **立刻定格在当前帧**，之后画面不再变化 |
| 拖标尺（往前 / 往回） | 跳到对应帧；**往回拖也倒退**，松手不回弹 |
| 播放中拖标尺 | 画面跟着鼠标走（音频暂停，状态栏写「已暂停，可拖动定位」，松手从新位置接着播） |
| 按停止（■） | 回到 0ms 并定格在第一帧 |
| 播到总长结束 | **停在最后一个时间点和最后一帧，不自动归零**；再点播放从 0ms / 首帧重新播 |

预览区会显示帧数和总时长，例如 `视觉：GIF (2.40s, 48帧)`。
时间轴比 GIF 长时，播放头越过 GIF 末尾会**停在最后一帧**，
元信息会写成 `视觉：GIF (5.01s, 167帧) · 已放完，停在最后一帧`。

> 还没有放任何音效时，按播放也能单看 GIF（播放头会照常推进），
> 方便先把画面看一遍再往里配声音。

> 如果 GIF 时长和游戏内动画实际时长不一致，以顶栏的「总长(ms)」为准 ——
> 那个值是导出时用的，GIF 只是视觉参考。

排查「GIF 不动 / 暂停了还在动」时，可以在 DevTools 里看状态快照：

```js
__MCS_DEBUG__.transport()
// { state:'stopped', audioPlaying:false, scrubbing:false,
//   playheadMs:1859, gifMs:1859, gifDriverAlive:false, btn:'▶' }
```

`state`（传输状态）、`gifMs`（GIF 停在第几毫秒）、`playheadMs`（播放头）
三个数必须互相一致；`gifDriverAlive` 为 true 表示还有东西在喂 GIF。

### 网格与精度

顶栏的「网格」下拉控制吸附精度，默认 **50ms = 1 tick**。

> ⚠️ 基岩版以 20 TPS 运行，**导出时所有时间点会吸附到 50ms 网格**。
> 如果你把片段放在 137ms，导出时会落到 150ms，校验页会明确告诉你。

BPM 填了非 0 值并勾选「拍线」，标尺上会出现虚线拍线和小节线，
方便做节奏型编排。策划案里会自动生成「第 N 小节第 M 拍」的落点描述。

### 音高 / 音量

| 参数 | 范围 | 说明 |
|---|---|---|
| 音量 | 0 ~ 1 | 中国版接口限制，超过 1 会叠加音源可能爆音 |
| 音高 | 0 ~ 256 | 中国版 `PlayCustomMusic` 的 pitch 参数 |

> 💡 **听感安全区是 0.5 ~ 2.0**。在这个区间里微调，玩家会感觉「这个音效是特意做的」，
> 而实际上只是同一素材变了参数 —— 这是最省成本做出听感差异的办法。
> 超出这个区间校验页会警告。

### 重复播放同一个音效

一个片段只响一次。要让同一段音效响多次，就把片段复制多份：
右键片段「再复制一份」，或选中后按 `D`（副本紧跟其后），也可以 `Ctrl+C` → `Ctrl+V` 粘到播放头。
工具里没有「循环播放」这种长响开关。

---

## 导入视觉参考

### GIF

`导入 GIF` 或直接把 GIF 拖进窗口。GIF 会显示在预览区，播放时从头同步。

> ⚠️ **GIF 只作为视觉参考，不作为时间基准的真值。**
> GIF 的帧延迟以 10ms 为单位存储，导出工具写法不一，实际时长常和游戏里对不上。
> **请手动填写顶栏的「总长(ms)」**，用你在游戏里看到的真实动画时长。

### Blockbench 模型 (.bbmodel)

`导入模型` 后会自动进入 **「① 模型/GIF 调整」**。在这里拖动画布设定角度、选择动画，再点 **「② 音效」** 回到时间轴；角度、选中的动画和素材共用同一份工程状态，保存后重开也会恢复。

调整页的「素材槽」将模型与 GIF / 视频 / 图片分开管理：模型使用「导入模型 / 移除模型」，画面参考使用「导入 / 替换 / 移除」。两种素材可以同时存在，预览区用「看模型 / 看画面」切换；移除其中一个不会影响另一个，且可用 `Ctrl+Z` 撤销。

调整页的动画区分为 **「关键帧动画」** 与 **「Molang 语言动画」**：前者可完整预览；后者会列出含表达式的动画，但当前版本不求值表达式，预览按保持前一帧处理，并在界面中明确提示。

模型导入仍会解析并弹出报告：

- 模型名、格式版本、尺寸、元素/组数量、包围盒
- 全部骨骼（group）名
- **贴图完整性检查**（下面详述）
- 模型内自带的动画列表

### 动画文件 (.animation.json)

`导入动画` 后会解析并弹出报告：

- 每条动画的时长（ms / 秒 / tick）、循环模式、骨骼列表、关键帧时间点、插值模式
- **脏数据检测**：数值里混进空白字符会被标出来
- **骨骼交叉校对**：动画里的骨骼名 vs 模型里的 group 名，谁多谁少一目了然

导入动画后，**最长的动画会自动设为时间轴总长**，时间轴就和动画对齐了。

### 模型与动画会显示在预览画布上

导入模型之后，模型**真的画在预览区那块画布上**（不是一个「解析成功」的弹窗）：

- 正投影 + 画家算法 + 背面剔除 + 方向光；每个面按 Blockbench 的 uv 贴图（内嵌 base64 直接解码，
  相对路径按「模型文件所在目录」找，找不到就用该立方体的纯色代替，并在校验页留一条警告）
- 导入动画后，**按播放头时刻套用骨骼姿态**：拖标尺可以逐帧看动作，播放时会跟着走
  （`visual.modelPath` 会被记进工程，重开工程时模型自动回到画布上）
- 预览区那行元信息会写明：`视觉：模型「养护核心」(63 立方体 / 66 骨骼, 贴图 2/2) · 动画 grab (1.00s) · 0.50s`
- 只有模型、还没配音效时也能按播放（和「只有 GIF」时一样，播放头会照常推进）
- **GIF / 视频预览一点没变**：同时有模型和 GIF 时，预览区会出现「看模型 / 看 GIF」按钮，
  两边都保留、一键来回切（切回 GIF 会还原画布像素尺寸并重画当前帧）

排查这件事的入口（不用肉眼看截图）：

```js
__MCS_VISUAL__()
// { mode:'model', cubeCount:5, boneCount:4, posedBones:[…], pixels:{painted,coverage,hash,colors},
//   stage:{canvas:true,…}, metaVisual:'视觉：模型「机械臂」…', switchButton:{…} }
```

> ⚠️ 已知边界：这是**预览**，不是完整 3D 渲染 —— 不做透视投影、光照只有方向光、
> 不支持 Blockbench 的粒子/元素级「不可见」标记；轴对齐立方体以外的斜置元素也能画，
> 但没有做遮挡排序以外的深度处理。看动作对不对足够了，要精修请回 Blockbench。

### 起始页（工程列表）

启动软件后先看到的是**起始页**（像 Adobe PR 的初始页面）：列出你已经创建的工程，在这里新建或打开工程；
选中工程之后才进入工作页。工作页左上角的 **「← 工程」** 随时回到这里。

```
┌ MCSoundStudio v0.1 ──────────────────────────────────────────────────┐
│ 开始            [＋ 新建工程] [打开工程文件…]                         │
│ 我的工程        [打开工程库文件夹] [刷新]                             │
│ 工程库目录：<程序目录>\userdata\projects　共 3 个工程                    │
│ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐              │
│ │ 机械臂抓取 工程库│ │ 空工程   工程库 │ │ 外面的工程 最近 │              │
│ │ ▁▂▅▃ 缩略条     │ │ （空工程提示）  │ │ 总长 2.00s …   │              │
│ │ 总长 1.00s 片段3│ │ …              │ │ …              │              │
│ └────────────────┘ └────────────────┘ └────────────────┘              │
│ 上手教程        [打开使用教程]                                        │
│ 关于作者        [作者 · B 站主页]                                     │
└──────────────────────────────────────────────────────────────────────┘
```

- **列出什么**：`userData/projects/` 下所有 `*.timeline.json` ＋「最近打开/保存过」的工程
  （两者按路径去重；库外的工程也会列出来，标「最近」）
- **卡片上能看到什么**：工程名、总长、片段数、用到/总轨道数、BPM、视觉参考、
  文件名、大小、修改时间，以及一条**按真实片段画出来的缩略条**
  （蓝块 = 原版音效事件，绿块 = 自定义音频文件，细竖线 = 工程总长，超出总长的一段有淡红底）
- **怎么导入**：点卡片 = 打开这个工程并进入工作页（和顶栏「打开」完全同一条实现：判定、诊断、
  「最近工程」记录、模型恢复都一致）；也可以用「打开工程文件…」从任意位置挑
- **没保存就切走**：有未保存改动时，点「← 工程」/ 点别的工程卡片 / 点「＋ 新建工程」都会先问一句
  「保存并继续 / 不保存继续 / 取消」，选「取消」不会动任何东西
- **文件不见了怎么办**：卡片灰显并写明「找不到文件：<路径>」，不会被静默去掉
- **保存到工程库**：工作页里 Ctrl+S / 顶栏「保存」按工程名写成 `<工程名>.timeline.json`（首次会问存放位置）；此后 Ctrl+S 直接写回库里的那一份
- **撞名先问再写**：库里已经有同名工程时，保存前弹一次确认 ——
  「覆盖 / 另存为新名字（`<名字> (2)`）/ 取消」三个按钮（默认停在「另存为新名字」，回车不会顶掉别人的工程）。
  选「另存为新名字」会**连工程名一起改**，所以卡片名、文件名、文件里的 `name` 三处一致；
  状态栏如实写「已覆盖…」或「已改存为…」，不会出现「看起来像保存了、其实是覆盖」的错觉
- **改完再存回自己那份**：撞名的文件就是**你正在编辑的**那一份时，对话框写「这是你正在编辑的那份工程：<路径>」，
  默认按钮改成「覆盖（更新这份）」—— 回车 = 把改动写回原来那个文件，不会凭空多出一张 `X (2)` 卡片。
  只有当前工程不来自工程库（新建 / 从别处打开）时，默认才停在「另存为新名字」
- **名字不套娃**：撞名时算出来的新名字会**接着往后顺延** —— 已有 `X (2)` 就建议 `X (3)`，
  不会写成读不出区别的 `X (2) (2)`
- **坏文件点名**：工程库目录里混进读不了的文件（JSON 坏了 / 不是工程）时，总览不会只报一个数字 ——
  提示里直接列出文件名，下面展开一块明细写每个文件的具体原因（这些文件只是被跳过，其它工程不受影响）
- 不是工程的 JSON（例如 `sound_definitions.json`、模型、动画）打开时会给出**这是什么的说明**，
  而不是一句 `Unexpected token`

---

## 导出

点「导出全部 ▾」会一次性写出 5 个文件到同一目录：

| 文件 | 用途 |
|---|---|
| `<名称>.策划案.md` | 可直接贴进策划文档的时序描述 |
| `<名称>.sound_sequence.py` | ModSDK Python 播放器 |
| `sound_definitions.json` | 自定义音效注册片段 |
| `<名称>.sound_effects.json` | 动画关键帧挂音效的片段 |
| `<名称>.timeline.json` | 回存用，下次拖回工具继续编辑 |

也可以单独导出任意一个（右侧「导出」页），或点「预览导出内容」先看。

### 策划案里包含什么

- 基础信息（总长 / 网格精度 / BPM / 视觉参考）
- 时序编排表（时间点、音效名、音量、音高、时长、备注）
- 分层结构（按轨道分组）
- 节奏型（若填了 BPM，给出「第 N 小节第 M 拍」）
- 音高设计（列出所有微调过音高的音效，说明升/降调幅度）

### 生成的 Python 代码长什么样

```python
class SoundSequencePlayer(object):
    TOTAL_MS = 5000
    TIMELINE = [
        (0, "machine.lock", 0.9, 1, False),       # 锁定机构咬合
        (150, "machine.hydraulic", 1, 0.85, False),  # 液压杆伸出
        (900, "machine.ratchet", 0.6, 1.2, True),    # 齿轮组持续运转
    ]

    def play(self, pos=(0.0, 0.0, 0.0), entityId=None,
             volumeScale=1.0, pitchScale=1.0):
        ...
```

用法：在客户端 System 里 `SoundSequencePlayer().play(pos)`。

**要点：**

- 所有音效的延迟都相对「序列开始时刻」统一计时，不会层层嵌套导致漂移
- 音量自动钳制到 `[0, 1]`，音高钳制到 `[0, 256]`
- 播放失败会打印错误码（`-6` = 距离玩家超过 16 格被跳过）
- 提供 `stop()` 可中途停止

---

## 已知限制

| 限制 | 说明 |
|---|---|
| GIF 与时间轴是 1:1 的 | GIF 自己不跑时钟，位置完全由播放头决定（逐帧解码 + 精确 seek）。时间轴比 GIF 长时，越过 GIF 末尾就停在最后一帧，元信息会写「已放完」。不做循环、也不按总长拉伸 |
| pitch 是叠乘关系 | 中国版文档提到 pitch「可以从 json 文件里进行修改」，`PlayCustomMusic` 传的 pitch 与 json 里的关系需实测确认。工具里给的是「调用时 pitch」 |
| 预览不是完整 3D | 模型/动画会画在预览画布上（正投影 + 面贴图 + 方向光 + 骨骼姿态），但不做透视、不做完整光照与粒子；用来核对动作与节奏，精修请回 Blockbench |
| 原版库是旧版快照 | 事件目录为 v1.26.50，音频来自 DeZoST 库（约 1.21 时代），**2091 条新内容（cinnabar/copper_chest/cherry_wood/armor 等）缺音频**。机器常用音效不受影响（68/68 全覆盖）。缺失清单见 `sounds/vanilla/missing.txt` |
| 原版音频来源 | 音频取自 GitHub [DeZoST/Minecraft-Sounds](https://github.com/DeZoST/Minecraft-Sounds)（上游声明 Apache-2.0），事件目录取自 Mojang 官方 [bedrock-samples](https://github.com/Mojang/bedrock-samples)。**源码仓库不收录音频文件**（体积 + 授权原因），只有 Release ZIP 内置；权利归属与再分发边界见 `THIRD_PARTY_NOTICES.txt`，Minecraft 名称与音频权利仍归其权利人 |

---

## 校验规则

右侧「校验」页会检查：

- **错误**：音效未指定、起始时间为负、pitch/volume 超出引擎范围
- **警告**：pitch 超出听感安全区、volume > 1、时间点超出总长、动画骨骼在模型里找不到、贴图指向临时目录
- **提示**：导出时会被网格吸附的时间点、同轨道时间重叠

点校验条目可以直接跳转到对应片段。

---

## 目录结构

```
mcsound-studio/
├─ src/
│  ├─ main/
│  │  ├─ main.js        Electron 主进程 + IPC（文件读写、目录扫描）
│  │  ├─ preload.js     安全的 API 桥接
│  │  ├─ help.js        内置离线教程窗口 + 作者外链
│  │  └─ sysinfo.js     导出系统信息（Windows/显卡/屏幕/库规模 → txt）
│  └─ renderer/
│     ├─ index.html     UI 骨架
│     ├─ style.css      深色主题
│     ├─ timeline.js    数据模型 + 校验 + 全部导出器
│     ├─ parsers.js     .bbmodel / .animation.json 解析
│     ├─ audio.js       Web Audio 播放引擎
│     └─ app.js         主逻辑（状态、渲染、交互）
├─ sounds/              内置音效库
├─ samples/             真实格式的导入样例（模型/动画/坏文件/工程，由 scripts/gen-samples.js 生成）
├─ scripts/             测试与工具脚本（**只在开发仓库里**，对外源码树不含；见「脚本（`scripts/`）与对外源码树」）
└─ docs/sample-output/  样例导出结果
```

---

## 开发脚本（**仅开发仓库**：下面每条 `node scripts/…` 都要求 `scripts/` 目录，对外源码树里没有）

```bash
node scripts/run-core-regression.js # 核心回归总入口（见上「重跑全部检查」）
node scripts/qa-artifact-hygiene.js # 日常清理工具（默认 dry-run，见「工程卫生」）
node scripts/clean.js               # 发布前收尾清理（默认 dry-run，见「发布前收尾」）
node scripts/clean-selftest.js      # 上面这个工具的自测（临时假仓库里跑；项数以它自己打印的「通过 N / 失败 0」为准，别在文档里写死）
node scripts/lib/portable-temp.js   # %TEMP% 残留查看/回收
node scripts/smoke-test.js          # 导出逻辑冒烟测试（样例导出写到 tmp-sample-output/，见下）
node scripts/test-parsers-real.js   # 用真实模型/动画文件测解析器
./node_modules/electron/dist/electron.exe scripts/headless-check.js     # 无头启动检查
./node_modules/electron/dist/electron.exe scripts/interaction-test.js   # 模拟操作全流程
./node_modules/electron/dist/electron.exe scripts/vanilla-lib-test.js   # 原版库加载 + 拖拽 + 导出
./node_modules/electron/dist/electron.exe scripts/sysinfo-export-test.js # 导出系统信息（真窗口点按钮 → txt → 逐条核对）
node scripts/check-machine-coverage.js   # 机器常用音效覆盖率检查
```

### 样例导出与工作区卫生

`docs/sample-output/` 是**提交进仓库的样例**（用来给策划看导出长什么样），
而 `smoke-test.js` / `export-inspect.js` 每次跑都会重写它、且片段 ID 是随机生成的 ——
结果就是跑一次测试工作区就脏一片，谁也分不清「样例」和「刚跑出来的东西」。

所以这两个脚本的导出目录现在**默认写到被忽略的 `tmp-sample-output/`**；
确实想刷新提交进仓库的样例时，显式指定目录：

```bash
MCS_SAMPLE_OUT=docs/sample-output node scripts/smoke-test.js
```

（`qa-report-multiselect/` 是 QA 证据包，`ctrls-repro.json`、`tmp-save/*.timeline.json`
同样是跑一次变一次的产物，重跑后不要顺手提交，`git checkout --` 还原即可。）

### 工程卫生：工作区目录规则 + %TEMP% 残留

三条规则（卡 t_650c6abf 定），目的是**别让每个 worker 的 `git status` 淹在噪声里**，
同时不许清理动作误伤证据：

**1. 可再生的临时产物 → 仓库根级 `tmp-*` 目录**（`.gitignore` 里根锚定 `/tmp-xxx/`）
，另外由清理工具定期收：

```bash
node scripts/qa-artifact-hygiene.js            # 只读 dry-run：列出候选与「暂缓」原因
node scripts/qa-artifact-hygiene.js --apply    # 真删：只删「不含报告且 30 分钟无活动」的候选
node scripts/qa-artifact-hygiene-selftest.js   # 工具自测（44 场景）
```

> ⚠️ 含报告的 `tmp-*`（如 `tmp-ctxmenu-dev/dev-report.md`）**刻意保持可见、永远不被删**；
> 清理白名单只有「仓库根级 `tmp-*`」，绝不扩散到 `qa-evidence/`、`dev-verify-*`、`docs/`、`src/`。

**2. 每张卡的一次性证据 / 自验目录 → 固定前缀** `qa-*`（QA 证据/报告）与
`dev-verify-*`（开发自验）。`.gitignore` 按前缀整体忽略（`/qa-review-*/`、`/qa-evidence/`、
`/dev-verify-*/` …）：文件照旧留在磁盘上供复核，但不再往 `git status` 里灌噪声。
需要人工看的报告请写成**仓库根级 `.md`** 或放进 `docs/`（那是跟踪的）。

> ⚠️ **这些目录只是快照，不是依赖** —— 被 `.gitignore` 忽略的东西在 `git clone` 出来的仓库里
> **不存在**，所以**任何脚本都不许读它们**：否则干净克隆里一跑就 `exit 3`（卡 t_7cf958b9 验收
> 发现的第 1 条 P1：`scripts/verify-library-groups.js` 当时读的就是 `qa-review-t_494d72c9/`）。
> 脚本要用的数据一律入库到 `scripts/data/`。哪些快照还在、各自的常驻等价物是谁、
> 怎么判断「这份数据该不该入库」，见 **`docs/qa-snapshots.md`**。

**3. 新脚本必须先 commit** —— 只存在于工作区（未跟踪）的文件，对 git 来说和垃圾没区别。
2026-10-14 20:03:25（一次手工提交前 20 秒）就发生过一次「清掉未跟踪文件」的动作，把三个
当时只存在于工作区、且已被各自卡片验收过的新脚本一起删了：
`scripts/run-core-regression.js`、`scripts/qa-artifact-hygiene.js`、`scripts/gif-parse-real.js`
（同目录下已提交的 `gif-real-regression.js` 安然无恙）。三张卡都以为它们还在，直到「核心回归」
跑不起来才发现。**交付脚本前先 `git status --short scripts/` 自查，别留 `??`。**

### 发布前收尾：`node scripts/clean.js`

日常收 `tmp-*` 用 `qa-artifact-hygiene.js`（白名单极窄）；**对外发版前**用这一条把一整轮开发
攒下的过程产物收干净（构建产物 / 交付目录 / 每张卡的自验与 QA 证据 / 临时文件与一次性脚本）：

```bash
node scripts/clean.js                      # dry-run：只列出「将删除 / 将归档 / 跳过 + 依据」
node scripts/clean.js --inventory          # 清理前快照（git status + 根级条目分档 + 体积）
node scripts/clean.js --apply              # 真删 + 归档
node scripts/clean.js --apply --keep-dist  # 保留 dist/（刚重打完、还要复核打包产物时）
node scripts/clean-selftest.js             # 工具自测（在临时假仓库里跑、不碰真仓库；项数看它自己打印的那一行）
```

三条闸门（任一不满足就不动手）：

1. 只认**仓库根级、名字命中白名单**的单层条目，脚本源码里没有任何会扩散的 `**` 通配 ——
   永远不会下探子目录误伤证据（自测 S2.5 专门盯这条）；
2. **保护名单永久保留**：`src/ sounds/ samples/ docs/ build/ scripts/ node_modules/ .git/`、
   `package.json`、`package-lock.json`、`README.md`、`.gitignore`，以及已入库的历史证据目录
   `qa-report-multiselect/`；
3. **已被 git 跟踪的条目一律不删** —— 它只收工作区里的产物，从不改版本库，因此也不需要
   `git rm` 任何东西。候选目录里含 `*.md` 报告时默认**搬到仓库外的同级归档目录**
   （`<仓库名>-archive-<时间戳>/`，同盘 rename 瞬间完成）而不是真删；
   确实要连报告一起清（回收磁盘）用 `--purge`。

白名单（`scripts/clean.js` 顶部的规则表，改规则只改那里）：
`dist/`、`release/`、`dev-verify-*/`、`qa-verify-*/`、`qa-review-*/`、`qa-anchor-*/`、
`qa-evidence/`、`qa-accept/`、`qa-verify-ctrls/`、`tmp-*/`，以及根级 `ui-shot*.png`、
`qa-tmp-*.{js,html}`、`tmp-*.json`。

发布流程（顺序别反：**先清理、后打包**，否则打出来的包里带的还是清理前的树）：

```bash
node scripts/run-core-regression.js    # 1) 回归先全绿
node scripts/clean.js --apply          # 2) 从干净树开始（默认连 dist/ release/ 一起收）
npm run dist:portable                  # 3) 构建免安装目录版 = electron-builder --win --x64 --dir
                                       #    （本项目没有单独的 `npm run build` 脚本；`npm run dist`
                                       #     会额外再压一个 NSIS 安装包）
node scripts/check-packaging-audio.js  # 4) 打包声明 + 音频解析回归
node scripts/make-release.js           # 5) 收成交付目录 release/MCSoundStudio/
                                       #    （= dist/win-unpacked 的副本 + 使用说明.txt + 构建信息.txt）
```

`make-release.js` 现在的职责是「**从 `dist/win-unpacked/` 生成交付目录**」：

- 不带参数就输出到 `release/MCSoundStudio/`，也可以显式给：
  `node scripts/make-release.js "<你的交付目录>/MCSoundStudio"`；
- 它**不做任何构建**：找不到 `dist/win-unpacked/MCSoundStudio.exe` 就报错并提示先跑
  `npm run dist:portable`（旧版脚本找的是已废弃的 `*-portable.exe`，只会 `exit 1`）；
- 交付目录里的 `使用说明.txt` 与 `构建信息.txt` 由它**现场生成**，里面的 exe 字节数、sha256、
  文件数、体积、`.ogg` 数、git commit 全是当场算出来的 —— **不要手改这两个文件**，
  要改格式就改脚本；
- 包内 `.ogg` 为 0 会**拒绝生成**（`exit 2`，防止把试听全哑的包发出去）；确实要做无音频包加
  `--allow-no-audio`（`--info` 复核也认同一个开关）；
- 交付目录应当建在**空目录**里 —— 或先跑一次 `node scripts/clean.js --apply` 收掉上一轮的
  残留。脚本对「不是本次从 `dist/win-unpacked/` 复制来的旧残留文件」是**告警但不删**，
  它们会一直留在交付目录里、并稀释上面的体积与文件数；因此生成结束的「合计」与回验两处
  数字都会标注「**不含** N 个旧残留」；
- 复核一条已有交付目录（只读，不写盘）：

```bash
node scripts/make-release.js --info
node scripts/make-release.js --info --sha256=<hex>   # 连 sha256 一起校验，不符 exit 2
```

（想让它也能 `npm run make:release`：在 `package.json` 的 `scripts` 里加一行
`"make:release": "node scripts/make-release.js"` 即可；本仓库当前没加别名，直接
`node scripts/make-release.js` 就是等价做法。）

> `release/` 已被 `.gitignore` 忽略（它只是本机构建产物，948 MiB 不进版本库）；
> 「怎么重建它」由上面这几条命令 + `scripts/make-release.js` 保证，不靠库里放副本。

### %TEMP% 残留（单文件 portable 版；该形态已废弃，本节保留给存量 exe 与清理工具）

> 交付形态已是免安装目录版（见「打包注意事项」），新建的交付目录不再产生 `%TEMP%` 残留。
> 下面这节仍然有用：存量的 portable exe，以及 `verify-portable.js` /
> `verify-packaged-audio-e2e.js` 这类要跑 exe 的脚本，收尾清理逻辑都在这里说明。

启动 `MCSoundStudio-*-portable.exe` 会先在 `%TEMP%` 解包两份东西：

| 残留 | 内容 | 单次体积 |
|---|---|---|
| `%TEMP%\nsXXXXXX.tmp\` | NSIS 启动器临时目录（`app-64.7z` + `7z-out`） | 0.3 ~ 1.7 GB |
| `%TEMP%\<随机字母数字>\` | 真正的解包根（Electron 应用本体） | ~0.8 GB |

窗口正常关闭时启动器会自己收拾；但脚本收尾如果是 `taskkill /F` 强杀，启动器来不及清，
**每跑一遍就漏 0.7~1.7 GB**，C: 盘紧张时直接卡住别人打包。

现在 `verify-portable.js` 与 `verify-packaged-audio-e2e.js` 的收尾会自动补清
（公共实现 `scripts/lib/portable-temp.js`）：

- 启动前 `snapshot()` 取基线，收尾**只删基线里没有的条目** —— 别人早先留下的残留、别人正在用的那份都不动；
- 目录里最近 30 秒还有写入的一律跳过（正在解包）；删除失败（Windows 文件占用）只记录原因，不抛异常；
- 收尾先走**正常关窗退出**（`taskkill` 不带 `/F`，会发 WM_CLOSE），8 秒没退才强杀 —— 让启动器有机会自己收拾。

手工查看 / 回收：

```bash
node scripts/lib/portable-temp.js                                   # 只读列出当前残留
node scripts/lib/portable-temp.js --clean-stale=6                   # 清「早于 6 小时」的 ns*.tmp
node scripts/lib/portable-temp.js --clean-stale=6 --include-roots   # 连陈旧解包根一起清
```

### portable e2e 必须串行跑（并发会互相踩）

单文件 portable 版**每次启动都用同一个 `%TEMP%` 解包目录**（本机是
`%TEMP%\3KgmjEEjKJdsz0DJz0a7OINo1xo`）。后启动的实例会先把这个目录删掉再重新解包，
于是先启动、还在跑的那个实例会在半路**丢音频** —— 实测同一目录的 `.ogg` 数一分钟内
1851 → 258 → 425，正在运行的实例点 5 次 ▶ 全部 `TypeError: Failed to fetch`，
包内连 `block/candle/ambient1.ogg` 都「不存在」，很容易被误判成产品缺陷（卡 t_8c74ddef 第 2 条）。

**单用户双击一次不会遇到；两个 QA/开发脚本同时跑就会看到假故障。** 现在跑 portable exe 的
脚本（`verify-portable.js`、`verify-packaged-audio-e2e.js`）启动前会走串行保护
（公共实现 `scripts/lib/portable-single-instance.js`）：

- 先等本机没有别的 `MCSoundStudio*` 进程（连续采到两次安静才算），最多等 10 分钟；
- 等不到就**拒绝开跑**，退出码 `3`（= 环境被占用、结论无效、重跑），绝不制造假 FAIL；
- 收尾仍**只按 PID 杀自己的进程树**（`killTreeGracefully`），不碰别人的实例。

```bash
node scripts/lib/portable-single-instance.js     # 只读列出当前实例，判断现在能不能跑 e2e
MCS_E2E_SKIP_QUIET=1 node scripts/verify-portable.js   # 强行开跑（要复现并发互踩时用，结果自负）
MCS_E2E_QUIET_MS=60000 node scripts/verify-packaged-audio-e2e.js   # 缩短等待上限
```

### 重建原版音效库

如果以后想换更新的音效来源，流程是：

```bash
# 1. 拿 Mojang 官方事件目录
#    下载 bedrock-samples 的 min 包，取 resource_pack/sounds/sound_definitions.json

# 2. 准备一个含 .ogg 的音频目录
#    例如 clone DeZoST/Minecraft-Sounds 的 sounds/ 目录

# 3. 合并
node scripts/build-vanilla-library.js <sound_definitions.json> <ogg根目录>

# 4. 把音频放到 sounds/vanilla/audio/，并重写 library.json 里的 absPath
```

> ⚠️ **注意**：原版游戏的音效在现代基岩版里存为 `.fsb`（FMOD 音库），
> 不是 `.ogg`，Windows 上无法直接解码。所以必须用第三方整理好的 ogg 版本。

---

## 分类与中文名的核对依据

音效库里的分类和中文名**不是猜的**，来源是中文 Minecraft Wiki，核对结果存在
`sounds/vanilla/wiki-verified.json`（含来源链接、逐条比对统计、以及有意保留的差异项）。

| 项目 | 来源页面 | 结果 |
|---|---|---|
| 生物名与阵营 | [生物](https://zh.minecraft.wiki/w/生物) · [实体格式](https://zh.minecraft.wiki/w/实体格式) | 109 条词条，与 Wiki 官方 ID 表**逐条比对 86 条一致、0 不符**，另 23 条为旧版 ID/衍生变体（逐个页面核对） |
| 方块名 | [基岩版数据值/方块ID](https://zh.minecraft.wiki/w/基岩版数据值/方块ID) | Wiki 官方 1474 个 ID，词典 286 条，逐条比对一致 |

生物阵营采用 Wiki 的**「友好生物 / 敌对生物」**二分法
（不用「中立生物」—— 那不是 Wiki 的说法，铁傀儡和熊猫属友好生物）。

**有意保留的 5 处差异**（已记录在 `wiki-verified.json` 里说明理由）：
`trapdoor`→活板门、`wooden_door`→木门、`stonecutter`→切石机、
`lava`→熔岩、`water`→水。这些在音效事件里是**通称**，
用 Wiki 单一方块名（如「橡木活板门」）反而会误导。

### 重新生成中文描述

```bash
node scripts/gen-descriptions.js      # 重新生成 descriptions.json
node scripts/audit-desc.js            # 审计：叠字/英文残留/主体错配/名词不一致
node scripts/verify-path-rebind.js    # 验证 4234 条音频路径都能找到文件
```

`audit-desc.js` 当前结果：**1079 条描述，0 缺陷**。
