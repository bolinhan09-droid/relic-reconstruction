# 可选 safetensors 模型包

本目录只有清单样例，没有模型权重。复制 manifest.example.json 为 manifest.json，按实际文件修改，再在“本机模型”选择此目录。

file 必须为包内相对路径，不支持跳出目录、不支持可执行文件。登记成功不代表模型架构、效果、显存或推理服务兼容性已经验证。旧 SD1.5 实验还需要单独的本机 ComfyUI 正确加载对应 checkpoint；新画笔精修走本地图像编辑接口。

GGUF/其他架构由独立推理服务管理，不用此 safetensors 清单加载。不要将模型目录上传到源码 GitHub 仓库。
