# 本地模型接入说明

软件与模型是两个可独立安装的部分。窗口、画笔、资料、方案保存运行在本机；本地 AI 需要对应的推理服务已经启动并加载模型，在线 AI 使用你自己选择的 API。

## 本地图像编辑候选

FLUX.2 [klein] 4B + stable-diffusion.cpp 的 `sd-server` 提供一条不需要训练 LoRA、也不依赖 ComfyUI 的路径。编辑运行步骤依对应版本的上游文档，本项目不自动执行来源不明的模型包脚本。

- [模型作者仓库](https://github.com/black-forest-labs/flux2)
- [模型卡与许可](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B)
- [stable-diffusion.cpp 的 FLUX.2 编辑说明](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/flux2.md)
- [sd-server 接口说明](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/README.md)

不同精度、文本编码器、分辨率和卸载策略有不同显存占用。发布本版本时未下载这些权重，未在目标显卡上运行实际图片编辑，不承诺效果、速度或某个包的即插即用。验证时先用小尺寸单张照片，确认编辑接口、人物与服装保真，再逐步扩大。

软件“图像服务 → 本机图像编辑”填写 `http://127.0.0.1:端口/v1` 和服务提供的实际模型名。接口必须支持上传图片的 `/images/edits`；只有文生图 `/images/generations` 的服务不满足当前流程。当前发送原图及区域引导，沿用本机合成保护区域。

## 本地对话

已加载模型的 Ollama 或 LM Studio 可提供兼容的聊天接口。填实际加载的模型名和本机 `/v1` 地址。选择图像理解选项前应确认所加载模型支持视觉；普通文本模型只获得文字与笔刷摘要。

- [Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)
- [LM Studio OpenAI 兼容接口](https://lmstudio.ai/docs/developer/openai-compat)

本地聊天与本地生图使用各自的地址、模型名和可选密钥；两者不互相替代。

## 随软件提供模型包

后续可分别发布 `Windows应用.zip` 和 `模型包.zip`。模型包放到用户选择的数据盘，目录面板负责登记/展示，真正加载与运算由对应服务完成。现有 safetensors 清单样例见 models 目录；GGUF 路线通过服务地址接入，不使用 safetensors 的 ComfyUI 登记清单。

本版本已经实现“可安装本地服务接口和模型目录”的结构，尚未交付带推理运行时和权重、完全离线自动启动的整合模型包。
