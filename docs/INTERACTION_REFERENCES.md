# 交互参考与本轮实现取舍

调研时间：2026-10-18。下列项目用于学习公开的节点、拖动、封装与动画模式；本版没有复制其专有素材，也没有强制用户安装这些平台。

| 来源 | 可借鉴机制 | 本项目取舍 |
| --- | --- | --- |
| https://github.com/xyflow/xyflow | 自定义节点、连接口、独立节点数据、交互验证 | 保留单轨标签与少量侧插，原生模块实现，暂不为自由布线引入 React 栈 |
| https://github.com/SortableJS/Sortable | 拖动手柄、排序、跨区域拖放、视觉反馈 | 采用原生拖放和语义重排，另提供按钮操作；不依赖运行时 CDN |
| https://github.com/formkit/auto-animate | 元素增删的空间连续性 | 使用浏览器 Web Animations 实现上传到节点和钻入工作区，支持减少动画 |
| https://derivative.ca/UserGuide/Component | 封装工作区，对外保留输入输出 | 每个节点内部是一个完整任务工作区 |
| https://docs.comfy.org/interface/features/subgraph | 子图输入输出与内部操作 | 借鉴封装思想，工作流底模仍可选 API 或本机服务 |
| https://www.youtube.com/watch?v=fBE8tWI1bdY&t=828s | AniimoSync 视频说明标注 13:48 为 Face Blend | 三候选与比例探索作为设计参考；本轮没有成功完整播放，不声称复现游戏内部参数算法 |

三角融合：同一底图独立效果层允许实时混合；不同模型生成的整图，游标表达多参考偏好，经图像节点执行生成。透明叠加不同衣服照片不能冒充语义融合。
