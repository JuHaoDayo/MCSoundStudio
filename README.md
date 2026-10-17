# MCSound Studio

给 Minecraft 音效师用的**音效时序编辑器**（Windows 免安装）。把原版音效事件摆上时间轴、对齐模型动画，然后一键导出策划案和 ModSDK 调用代码——不用再手写 `json` 和记变体名。

## 下载即用

1. 到 [Releases](https://github.com/JuHaoDayo/MCSoundStudio/releases/latest) 下载 `MCSoundStudio-<版本>-win-x64.zip`
2. 解压到任意位置（约 957 MiB）
3. 双击 `MCSoundStudio\MCSoundStudio.exe`

不需要安装，不写注册表，不建快捷方式。**所有数据都在解压目录的 `data\` 里**，删掉整个目录就等于清除全部数据，可以整个拷到 U 盘带走。

## 能做什么

- **原版音效库**：1079 个基岩版音效事件 / 4234 个变体，包内自带 3717 个 `.ogg`，装上就能试听
- **时间轴**：多选与跨轨拖动、复制粘贴、右键菜单、变速、`Alt` 裁剪、淡入淡出与效果预设、撤销重做
- **模型 / GIF 调整页**：旋转与角度、关键帧动画、Molang 语言动画，切回音效页沿用同一份时间
- **导入素材**：GIF / 视频 / 图片 / 自定义音频，可在预览区删除并撤销
- **工程库**：工程总览、新建/打开/另存，未保存改动关窗会提示
- **导出**：音效策划案文档、ModSDK 调用代码、GIF

## 系统要求

- Windows 10 / 11（x64）
- 磁盘：解压后约 957 MiB（从源码自己构建另需约 3 GB）
- 首次启动加载音效索引约 0.1 秒；不联网

## 数据存放

```
MCSoundStudio\data\            ← 全部可写数据都在这一个目录
├─ projects\    工程库          ├─ session\  Chromium 会话与缓存
├─ exports\     默认导出位置    ├─ logs\     运行日志
└─ temp\        运行时临时文件  └─ crash-dumps\
```

不写 `%APPDATA%`、`%LOCALAPPDATA%`、`%TEMP%`。

## 音频来源与许可

- 试听音频：来自 [DeZoST/Minecraft-Sounds](https://github.com/DeZoST/Minecraft-Sounds)（上游声明 Apache-2.0）
- 事件目录：来自 Mojang 官方 [bedrock-samples](https://github.com/Mojang/bedrock-samples)
- Minecraft 名称、原版音频及相关内容的权利仍归各自权利人；本仓库只把原版库内容用于本应用的离线试听，不收集、不分发任何用户个人音频
- 自有源代码以 MIT 发布（见 [LICENSE](LICENSE)），详细边界见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)

## 从源码构建

```bash
npm ci
npm run release:zip     # → release/MCSoundStudio-<版本>-win-x64.zip
npm start               # 直接跑开发模式
```

源码仓库**不含音频文件**（687 MB，体积与授权原因，`.gitignore` 已忽略）。从源码构建出来的是「无音频构建」：界面和编辑功能完整，但试听没有声音。要听声音请下载 Release ZIP，或自备音频放进 `sounds/vanilla/audio/`。

## 反馈

遇到问题请开 [Issue](https://github.com/JuHaoDayo/MCSoundStudio/issues)，附上版本、操作步骤和 `data\logs\` 里的日志。
