# 第三方内容范围

- 明日方舟及角色乌尔比安仅作为课程案例和文字研究索引；相关权利归原权利人。本项目不是官方产品。
- 发布包不包含来自社交平台的封面、玩家实拍、私定立绘或训练素材。`deepsea-fallback.svg` 是项目绘制的几何背景；`demo_coat_front.png` 是流程示意服装。
- 外部故事、材料资料保持来源链接；链接与摘要不代表本软件取得原文/图片的再分发权。
- 模型不随本版软件提供。模型权重、量化文件与推理程序分别遵循其上游许可证，制作模型包时保留对应说明和来源。
- 可选DINOv2-S/14使用Meta官方预训练权重，Apache-2.0，来源 https://huggingface.co/facebook/dinov2-small 。本项目自行编写匹配与轮廓近似程序，没有把公开服装配对样本纳入软件发布包。VITON-HD衍生例图仅保留在个人本地课程实验目录，不作为可再分发素材。
- 可选表面分析使用Depth Anything V2 Small（Apache-2.0，https://github.com/DepthAnything/Depth-Anything-V2 ）与U2Netp（上游Apache-2.0，https://github.com/xuebinqin/U-2-Net ；ONNX权重由rembg官方分发）。模型权重和个人实测照片不在发布包内；位移和融合程序由本项目编写，算法来源与限制见 tools/cloth_surface_algorithm.txt。
- PyInstaller、Python、pywebview、pythonnet、WebView2 与 Python 库各按原有许可提供；构建时收集到 `third-party-licenses`。WebView2 本身使用系统已有运行时，不在本包内重新分发其安装程序。

主要上游：
- https://www.python.org/psf/license/
- https://pywebview.flowrl.com/
- https://pyinstaller.org/
- https://github.com/fastapi/fastapi
- https://github.com/encode/uvicorn
- https://github.com/encode/httpx
- https://python-pillow.github.io/
