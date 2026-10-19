# 本地模型：下载链接与安装

**GitHub 源码与 Windows 软件包不含大型模型、个人照片或个人工作区。** 手势使用的约 7.82MB MediaPipe 小模型已随包提供。画布、画笔、项目保存、四点校正和三维代理服装可直接使用；下面的模型按需安装，不必全部下载。来源与脚本核对日期：2026-10-19。

“已验证”指开发电脑的实测，不代表下载软件后已经具备相同模型和运行环境。开发电脑为 Windows、RTX 4060 Laptop 8GB、32GB 内存；不同电脑仍需实际运行一次。

## 先选需要的功能

| 功能 | 模型与下载来源 | 权重占用约 | 安装入口与许可 |
| --- | --- | ---: | --- |
| 看图、讨论、审阅、协作工具调用 | [Qwen3.5-4B 官方模型](https://huggingface.co/Qwen/Qwen3.5-4B)；本项目使用 [Ollama 官方 Q4_K_M 分发](https://ollama.com/library/qwen3.5:4b-q4_K_M) | 3.32GB，含视觉投影 | `tools/install_qwen_local.py`；Apache-2.0 |
| 本机图片编辑、生成图融合 | [Qwen-Image-2.1 官方模型](https://huggingface.co/Qwen/Qwen-Image-2.1)；[leejet 量化文件](https://huggingface.co/leejet/Qwen-Image-2.1-GGUF) | 11.06GB，四个配套权重合计 | `tools/install_qwen_image_local.py`；**Qwen RESEARCH LICENSE，仅研究/评估，商业用途须另行许可** |
| 点击或框选服装，输出透明部件 | [Meta SAM2.1 Hiera Tiny](https://huggingface.co/facebook/sam2.1-hiera-tiny) | 156MB | `tools/download_segmentation_model.py`；Apache-2.0 |
| 相对深度、笔刷表面辅助 | [Depth Anything V2 Small HF](https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf)；[作者仓库](https://github.com/DepthAnything/Depth-Anything-V2) | 99MB | `tools/download_surface_models.py`；Small 为 Apache-2.0，其他尺寸许可不同 |
| 完整人物去背景 | [U²-Net 作者仓库](https://github.com/xuebinqin/U-2-Net)；[rembg ONNX 分发](https://github.com/danielgatis/rembg/releases/tag/v0.0.0) | U2Netp 4.6MB；完整 U2Net 约176MB | 同一表面模型下载脚本；上游 Apache-2.0，默认 U2Netp |
| 穿着图与平铺图的语义对应建议 | [Meta DINOv2 Small](https://huggingface.co/facebook/dinov2-small)；[作者仓库](https://github.com/facebookresearch/dinov2) | 88MB | `tools/download_correspondence_model.py`；Apache-2.0，非自动准确映射保证 |
| AI 生成平铺参考，高级研究扩展 | [MGT / TryOffDiff 作者仓库](https://github.com/rizavelioglu/tryoffdiff)；[模型文件](https://huggingface.co/rizavelioglu/tryoffdiff) | 多GB，另有依赖 | **独立 SSPL-1.0 扩展，未随本公开包提供完整适配器**；见后文 |
| 摄像头捏合绘制 | [Google Hand Landmarker 指南](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js) | 7.82MB | 已附小模型及本地 WASM，Apache-2.0，无需另下 |

占用仅指权重，不包括 Python、PyTorch、运行器、下载缓存和运行内存。下载脚本只下载公开文件，不上传服装照片。模型安装后，本机推理不依赖云接口；配置云服务时，请按界面提示确认上传范围。

## 新电脑：安装千问助手或本机生图

当前自带安装脚本针对 **Windows x64 + NVIDIA CUDA12 运行器**。其他硬件可自行运行兼容服务并在软件中填写本机地址；本包没有承诺 Mac、AMD 或纯 CPU 的同等性能。

1. 先解压 Windows 软件包并打开一次，或按 [README](README.md) 从源码运行。再下载源码到一个固定位置，下面用 `D:/RelicSource` 作示例。不要把它放入临时目录；模型脚本按源码根目录保存 `models/` 和 `tools/runtime/`。
2. 在源码根目录打开 PowerShell，准备 Python 3.11 x64 的独立下载环境。若已安装兼容的 Python 3.10–3.12，可使用对应版本。

```powershell
py -3.11 -m venv .model-runtime
.\.model-runtime\Scripts\python.exe -m pip install requests
```

3. 按需运行一项。助手脚本同时下载权重、视觉投影和固定版 llama.cpp；生图脚本同时下载四个权重和固定版 stable-diffusion.cpp。不需要先安装 Ollama 或 ComfyUI。

```powershell
# 视觉助手，约 3.32GB 权重，另有运行器
.\.model-runtime\Scripts\python.exe tools/install_qwen_local.py

# 可选：先阅读下方研究许可，再安装约 11.06GB 生图权重与运行器
.\.model-runtime\Scripts\python.exe tools/install_qwen_image_local.py
```

助手脚本支持 `--weights-only` / `--runtime-only`。下载有校验；安装成功只代表文件齐全，仍需启动测试。若上游变更或校验失败，不要跳过校验或随意改文件名。运行器分别固定为 [llama.cpp b11669](https://github.com/ggml-org/llama.cpp/releases/tag/b11669) 和 [stable-diffusion.cpp master-975-95b3090](https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-975-95b3090)。

4. **下载不会自动替桌面软件写入模型路径。** 若运行源码，默认查找本源码目录。若运行独立 EXE，在应用工作区 `runtime/local-ai.json` 写入实际源码根目录，例如：

```json
{"modelHome":"D:/RelicSource"}
```

`modelHome` 指同时含 `models` 和 `tools/runtime` 的根目录，不是某个 GGUF 文件。千问助手与千问生图共用这项路径。也可使用环境变量 `RELIC_LOCAL_AI_HOME`。默认 EXE 工作区是软件旁的 `workspace`；源码默认是 `data`；若启动时指定了其他数据目录，应修改实际使用的目录。

5. 重新打开软件。在助手连接中点击“启动本机千问”；在图像服务中选择本机模型并启动。服务就绪后配置如下：

| 用途 | Base URL | 模型名 |
| --- | --- | --- |
| 看图与工具调用 | `http://127.0.0.1:8188/v1` | `qwen3.5-4b-local` |
| 图片编辑 | `http://127.0.0.1:8190/v1` | `sd-cpp-local` |

这两个本机服务无需 API 密钥。8GB 显卡建议交替运行助手和生图；软件提供停止助手释放显存的按钮，只停止自己启动的模型进程。运行器仅监听本机，不设开机自启。最后用自己的小图做一次看图或编辑，确认实际可用。

**视觉助手必须真的支持图片输入。** 仅文本的 DeepSeek 或其他文本接口可用于文字讨论，不能因勾选“视觉”就获得读图能力，也不能用它完成视觉审阅。协作执行还需要服务支持工具调用。图像服务需支持接收参考图的 `/images/edits`，只有文生图接口不够。

## 新电脑：安装分割、去背景、深度与对应模型

这些模型通过独立 Python 工作进程运行；EXE 内置的 Python 不会自动拥有 PyTorch 等依赖。可复用刚才创建的 `.model-runtime`，先在源码根目录安装：

```powershell
.\.model-runtime\Scripts\python.exe -m pip install -r requirements-surface.txt -r requirements-correspondence.txt
# 现有 requirements 的最低版本不保证含 Sam2Model；开发实测使用此版本
.\.model-runtime\Scripts\python.exe -m pip install transformers==5.17.0
.\.model-runtime\Scripts\python.exe -c "from transformers import Sam2Model, Sam2Processor; print('SAM2 imports OK')"
```

上述依赖安装本身可能占数GB。SAM 默认 CPU 模式可先跑通；若使用 CUDA PyTorch，请按 [PyTorch 官方安装页](https://pytorch.org/get-started/locally/) 选择与系统、显卡驱动相符的安装方式。开发验证环境为 PyTorch 2.8.0+cu128、Transformers 5.17.0；这是验证记录，不代表全部硬件最低需求。

按需下载：

```powershell
# 服装分割
.\.model-runtime\Scripts\python.exe tools/download_segmentation_model.py

# 相对深度 + 默认轻量去背景
.\.model-runtime\Scripts\python.exe tools/download_surface_models.py --foreground u2netp

# 可选的语义对应建议；手工对应点不依赖它
.\.model-runtime\Scripts\python.exe tools/download_correspondence_model.py
```

然后在**实际应用工作区**的 `runtime` 目录建立以下 JSON 文件，将 `D:/RelicSource` 改成自己的源码位置。这些配置只在本机编辑，网页不能提交任意可执行命令。安装脚本不会自动写这些文件。

`segmentation-runtime.json`：

```json
{
  "pythonExecutable": "D:/RelicSource/.model-runtime/Scripts/python.exe",
  "modelDir": "D:/RelicSource/models/sam2.1-hiera-tiny",
  "scriptPath": "D:/RelicSource/tools/segment_garment.py",
  "device": "cpu"
}
```

`surface-runtime.json`：

```json
{
  "pythonExecutable": "D:/RelicSource/.model-runtime/Scripts/python.exe",
  "modelDir": "D:/RelicSource/models/garment-surface",
  "scriptPath": "D:/RelicSource/tools/analyze_garment_surface.py"
}
```

`correspondence-runtime.json`（仅安装 DINOv2 时需要）：

```json
{
  "pythonExecutable": "D:/RelicSource/.model-runtime/Scripts/python.exe",
  "modelDir": "D:/RelicSource/models/dinov2-small",
  "scriptPath": "D:/RelicSource/tools/dino_garment_correspondence.py"
}
```

重新打开软件，用自己的照片测试分割、表面分析或对应建议。首次推理才会实际验证依赖与硬件；找到文件不等于推理成功。前景模型默认 U2Netp；下载 `--foreground u2net` 并不自动切换使用版本，应另行完成表面工作进程验证和配置，不要仅修改“已验证”状态。

## 千问生图的组件、许可与实际范围

本项目使用的四个权重如下。生成 GGUF 来自运行器维护者，不是 Qwen 官方量化。各下载文件按对应分发仓库 LFS SHA256 校验，安装目录保留 LICENSE、NOTICE 和下载记录。

| 组件 | 文件 | 来源 |
| --- | --- | --- |
| 生成模型 | `qwen_image_2.1-Q4_K.gguf` | [leejet/Qwen-Image-2.1-GGUF](https://huggingface.co/leejet/Qwen-Image-2.1-GGUF) |
| 文本/图像编码 | `Qwen3VL-8B-Instruct-Q4_K_M.gguf` | [Qwen 官方 GGUF](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF) |
| 视觉投影 | `mmproj-Qwen3VL-8B-Instruct-F16.gguf` | 同一 Qwen 官方 GGUF 仓库 |
| VAE | `qwen_image_2.1_vae_bf16.safetensors` | [Comfy-Org 分发](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/main/vae) |

**[Qwen RESEARCH LICENSE](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE) 限研究/评估；商业用途须另行取得许可。** 主软件的 MIT 许可、运行器的 MIT 许可，都不能替代模型许可。此模型未混入默认应用分发包。

开发电脑实际通过单图编辑及平台两图编辑。两图任务以 384×512 处理，55.77 秒返回，再恢复 768×1024；这是一次小图实测，不是高清性能保证。固定本机服务的适配范围是最多两张参考图、最长边512、最短边64、尺寸对齐32。三个候选的图像融合会在创建生成任务前提示超出已验证范围；三角控制器的同底图可编辑笔触融合不受这项图像服务限制。

结果保留实际处理尺寸和缩放记录。该运行器没有验证原生 OpenAI 透明蒙版重绘，平台采用生成后按原蒙版合成，记录 `serverMask=false`、`maskStrategy=local_post_composite`；蒙版外像素可保持原样，但硬边可能可见。这不是原生高分辨率修补。运行器用法见 [上游 Qwen Image 2.1 文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_2.1.md)。

## MGT / TryOffDiff：独立研究扩展

作者代码与权重使用 [SSPL-1.0](https://github.com/rizavelioglu/tryoffdiff/blob/main/LICENSE)，不是本软件的 MIT 许可。公开包保留 AI 展平接入入口，**未附完整研究适配器与权重，没有一条已支持的一键安装命令**。开发电脑已有研究环境，并实测普通上衣；这不等于新电脑下载主软件后直接可用。

高级用户需按 [作者部署说明](https://github.com/rizavelioglu/tryoffdiff) 独立安装环境，下载对应模型及配套 SigLIP、VAE，运行真实推理，再对接本软件工作进程协议。应用在 `runtime/flatlay-runtime.json` 读取 `pythonExecutable`、`modelDir`、`scriptPath`，还检查权重与实际推理验证记录；仅下载模型或手写一个成功状态不足以完成接入。作者原始脚本不是本软件适配器，不能直接填进去就宣称接通。

没有这一扩展时，可以使用四点校正，或上传真实平铺服装照片进入效果映射。AI 平铺生成的隐藏部分是猜测，复杂披风、叠穿和痕迹保持仍可能失真，不能当准确纸样或已验证的损伤映射。

## 隐私、验证和模型边界

- 手势模型、WASM 与 Three.js 浏览器依赖本地加载；摄像头由用户点击开启，离开或停止时释放。默认遥测发送点的本地修改和校验记录在 `web/node-studio/vendor/mediapipe/`，模型/WASM 未修改。开发测试使用真实 WASM 和合成摄像头，未据此宣称真人识别准确率。
- 开发已实测千问看图/工具调用、SAM 分割、前景/深度、研究平铺及本机生图；个人测试图和报告不随公开包分享。新电脑应运行自己的测试，不复制开发电脑的验证状态。
- 深度是相对关系，不是真实褶皱高度；分割不等于识别纤维成分；对应建议仍需确认；三维代理服装不等于重建真实衣服。
- 本版使用预训练模型与受限工具，不需要先训练 LoRA。只有明确的风格需求、授权训练数据和可重复评估时，再考虑微调。
