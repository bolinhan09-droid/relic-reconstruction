# 首次安装与组员试用

仓库公开，无需协作邀请即可下载。程序在使用者自己的电脑上运行，不需要作者电脑保持开机。

## Windows 免安装包

1. 打开 [v0.10.0 下载页](https://github.com/bolinhan09-droid/relic-reconstruction/releases/tag/v0.10.0)。
2. 在附件中下载 `RelicReconstruction-Windows-x64.zip`；GitHub 自动生成的 Source code 是源码，不是桌面程序。
3. 将整个 ZIP 解压到可写目录，保留 EXE 旁的 `_internal` 和其他文件。
4. 双击 `RelicReconstruction.exe`。缺少 WebView2 时安装 [微软官方运行时](https://developer.microsoft.com/microsoft-edge/webview2/)。
5. 上传自己的服装图片开始创作。包内没有作者或其他玩家的照片。

软件尚无付费代码签名；先核对下载来自本仓库 Release。附件 `SHA256.json` 提供 ZIP 校验值，不需要关闭系统防护。

## 从源码运行

Windows 10/11 x64、Python 3.10–3.12。下载 `RelicReconstruction-source.zip` 或克隆公开仓库，运行 `install-desktop.cmd`，成功后运行 `start-desktop.cmd`。两脚本使用项目独立环境。

## 先体验不依赖大模型的部分

1. 新建工作流，上传照片，添加“精致修改”。
2. 绘制几笔痕迹，保存后回到总览；从该步骤创建两条分支，分别调整。
3. 合拢后添加融合创作。同底图可编辑笔触可以实时比较和采用。
4. 打开三维战斗，旋转代理服装并划切，检查命中记录；手势可由按钮自行开启摄像头。
5. 保存、退出并重开，确认工作记录仍在。

## 模型、API 和隐私

大型模型是可选组件，安装包没有它们。完整的 [模型下载与配置说明](../LOCAL_MODELS.md) 列出官方来源、安装步骤和许可证。完成对应模型与运行器安装后，再使用软件内启动按钮；仅下载权重并不等于服务已就绪。

每位使用者配置自己的 API 或本机服务。需要看图的节点必须连接视觉模型；聊天可用不代表视觉或图像编辑可用。在线调用只在明确执行时发生，按服务商规则计费。软件不会提供作者的密钥或账号用量。

照片与方案默认保存在软件旁的 `workspace`。更新前关闭旧版并备份此目录；分享代码时不要附带它。完整功能边界见 [v0.10 说明](V010.md)。
