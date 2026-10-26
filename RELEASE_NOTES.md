# 遗迹重构 v0.11.7 · 公开体验版

在服装照片上绘制、比较和讨论战损效果，再把方案整理成制作步骤与模板。这是一份面向同学与创作者的课程原型体验版。

## 下载后怎么打开

1. 下载附件 **RelicReconstruction-Windows-x64.zip**，完整解压。
2. 双击文件夹内的 **RelicReconstruction.exe**。不需要 Python、Node.js 或大模型。
3. 先点 **跟着示例做一遍**，不用 API 也能练习绘制、保存和传递输出。
4. 需要 AI 时，点首页 **API 怎么填**，按引导进入左上角的 **AI 设置**。

适用 Windows 10/11 x64。缺少 WebView2 Runtime 时，软件会提示前往 [微软官方下载页](https://developer.microsoft.com/microsoft-edge/webview2/) 安装。请完整保留 EXE 旁的 `_internal` 文件夹，包内 `开始使用.txt` 有简短说明。

## 这次更新

- 首页采用第十代的布局比例：左侧介绍、右侧适中上传标签、下方横排作品
- 内部保留第十一代的标准工作流、独立节点、分支、全局 AI 设置和作品删除
- 新增三步 API 引导，区分协作助手与图像生成，可跳过、可随时复看
- 生成结果直接显示在主画布，历史版本从小入口切换
- 精修与制作采用固定工作台；“把方案做出来”可准备平铺、映射和模板步骤

## API 与模型

每位使用者填写自己的 API。千问可直接在 [阿里云百炼](https://bailian.console.aliyun.com/) 开通，按 [官方指南](https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen) 创建密钥、查看工作空间 ID，再回到“AI 设置 → 图像生成”选择千问并核对地域。API 按服务商规则计费，打开软件与连接节点不会自动生图。手动输入的密钥仅本次运行有效，不写入作品。

大型模型不随安装包分发，按需使用 [本地模型下载与配置](https://github.com/bolinhan09-droid/relic-reconstruction/blob/main/LOCAL_MODELS.md)。基础绘制和示例练习可先离线体验。

## 验证与边界

已验证真实 Windows 桌面窗口启动、保存、新版页面加载，以及两种桌面尺寸下的新手引导和首页操作；本次发布检查没有发起付费模型请求。

AI 展平属于参考图。制作模板仍需真实平铺照片、对应点与实测尺寸核对，不能代替缝制纸样或材料小样。可选模型未安装时，对应能力会显示未就绪。

发布包不含作者照片、私人作品、API 密钥或大型模型。首次运行使用新的本机工作区；旧用户更新前请关闭软件，并保留、备份自己的 `workspace`。软件目前没有代码签名，可用附件 `SHA256.json` 核对下载文件。

开发者可下载 **RelicReconstruction-source.zip**。使用反馈请发在 [Issues](https://github.com/bolinhan09-droid/relic-reconstruction/issues)，附版本与复现步骤，截图请遮住密钥和私人照片。
