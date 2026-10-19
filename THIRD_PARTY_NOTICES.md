# 第三方内容范围

- 明日方舟及角色乌尔比安仅作为课程案例和文字研究索引；相关权利归原权利人。本项目不是官方产品。
- 发布包不包含来自社交平台的封面、玩家实拍、私定立绘或训练素材。`deepsea-fallback.svg` 是项目绘制的几何背景；`demo_coat_front.png` 是流程示意服装。
- 外部故事、材料资料保持来源链接；链接与摘要不代表本软件取得原文/图片的再分发权。
- 本版仅随软件提供约 7.82MB 的手部关键点模型；千问视觉、生图、服装分割、深度等大模型与 GPU 推理程序均为独立可选下载，不放入应用发布包。模型权重、量化文件与推理程序分别遵循上游许可。
- MediaPipe Tasks Vision 1.1.1 的 JavaScript/WASM 按 Apache-2.0 提供，保留 `web/node-studio/vendor/mediapipe/LICENSE`。来源为 [Google MediaPipe](https://github.com/google-ai-edge/mediapipe) 和官方 npm 包 `@mediapipe/tasks-vision`。本项目禁用了该固定版本中的可选外部性能遥测发送点；这是本地修改，说明与校验值见同目录 `LOCAL_CHANGES.md`、`download-manifest.json`，模型和 WASM 未修改。
- 随包的 Hand Landmarker `float16/1` 权重来自 [Google 官方模型地址](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task)，原文件 7,819,105 字节。许可依据 [Google 手部跟踪模型卡](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf) 的 Apache-2.0 声明；随包位置为 `web/node-studio/vendor/mediapipe/models/`。摄像头图片只用于本机推理，未作为发布素材保存。
- Three.js 0.186.1 与 OrbitControls 按 MIT 许可提供，来源 [mrdoob/three.js](https://github.com/mrdoob/three.js)，保留 `web/node-studio/vendor/three/LICENSE`。OrbitControls 的模块导入改为包内相对路径，未修改其控制算法。
- 可选 SAM2.1 Hiera Tiny 来自 [Meta 官方模型](https://huggingface.co/facebook/sam2.1-hiera-tiny)，按 [SAM2 Apache-2.0 许可](https://github.com/facebookresearch/sam2/blob/main/LICENSE) 使用；本地模型目录保留 LICENSE，权重不随应用分发。
- 可选 Qwen3.5-4B 使用 [Qwen 官方 Apache-2.0 许可](https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE)，本机 Q4_K_M 由 Ollama 官方仓库分发。可选 Qwen-Image-2.1 使用独立的 [Qwen RESEARCH LICENSE](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE)，仅研究/评估，商业用途须另行许可；本机生成权重由 stable-diffusion.cpp 维护者量化，不能标为官方原精度或 Apache-2.0 权重。完整来源、许可与验证范围见 `LOCAL_MODELS.md`。
- 独立模型包中的 [llama.cpp](https://github.com/ggml-org/llama.cpp) 和 [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) 使用 MIT 许可；其 CUDA 依赖遵循 NVIDIA 自身条款。它们不属于默认应用安装包，不能把运行器许可当作模型或 CUDA 的许可。
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
