# 靠近放大镜：可选本机感知

靠近感知默认关闭。用户点击“靠近放大”后，平台才检查本机检测环境并请求浏览器摄像头权限；不请求麦克风。关闭开关、离开工作区、隐藏窗口或关闭页面会停止视频轨道和检测。未授权、环境不可用或检测失败时，仍可使用 M 键放大镜。

## 实际检测内容

- 由浏览器读取低分辨率视频帧，只发送到本机同源服务。
- 固定本机 Python 工作进程使用已有 OpenCV Haar 分类器，只返回归一化人脸框和人数。
- 前端根据人脸框面积平方根相对初始基准的变化触发放大。这里没有身份识别、目光追踪、绝对距离或厘米测量。
- 本机帧、脸框、校准数据和会话令牌不进入项目存档，不保存录像、人脸照片或帧文件，也不发往云服务。

## 交互与阈值

初次开启后，用户保持自然坐姿，收集六个稳定的单人脸框。样本最大与最小尺寸之比不超过 1.16 时，以中位数作为基准；不稳定时继续等待稳定样本。可随时重新校准。

相对尺寸经过指数平滑，新观测权重为 0.55。进入阈值为基准的 1.24 倍，退出阈值为 1.12 倍，均需连续两帧满足，减少临界位置闪烁。无人、多人或无效数值立即退出自动放大；不会任意选取画面中最近的一人。

目标每 450 毫秒开始一次采样，约 2.2 帧/秒；同一时刻只允许一帧在途，处理较慢时降低频率，不排队积压。人脸检测在独立进程中执行，不占用绘画线程。浏览器权限、真实相机质量和本机 CPU 性能可能使实际频率下降。

## 模块与接口

前端：`web/node-studio/adapters/proximity-sensor.js`

```js
const sensor = mountProximitySensor(toolbar, {
  onNear(active) { magnifier.setAutomaticActive(active); },
  onStatus(message) {},
  notify(message) {},
});
// 不主动调用 enable()，由用户点击开关。
// 工作区退出时必须调用：
sensor.destroy();
```

可用方法为 `enable()`、`disable()`、`recalibrate()` 和 `destroy()`。`onNear` 仅传布尔值。手动放大镜与自动触发分别管理，摄像头关闭不影响普通绘画和 M 键。

后端：`node_studio/proximity.py`，注册方法为 `register_proximity_routes(app, core)`。

| 接口 | 作用 |
| --- | --- |
| `GET /api/proximity/capabilities` | 仅检查可选运行环境，不启动摄像头或检测进程 |
| `POST /api/proximity/sessions` | 明确提交 `{"confirmed":true}` 后启动固定工作进程 |
| `POST /api/proximity/sessions/{sessionId}/frames` | 请求头携带 `X-Proximity-Token`；只提交当前内存帧 |
| `DELETE /api/proximity/sessions/{sessionId}` | 校验令牌，关闭并等待工作进程结束 |
| `POST /api/proximity/sessions/{sessionId}/stop` | JSON 携带令牌，供页面退出时以 keepalive 释放会话 |

会话标识和随机令牌分开，令牌不出现在 URL 中。仅允许本机同源访问；最多两个活跃会话，十五秒无帧或二十分钟到期后清理。服务退出也会终止所有工作进程。

帧请求总量上限 220 KB，图片字节上限 150 KB，尺寸限制 64–640 × 64–480 像素。格式、尺寸、未知字段、畸形 JSON、非有限数值与错误令牌会被拒绝；无任意路径、可执行文件或命令参数入口。

## 可选环境

`tools/face_proximity_worker.py` 使用 JSON 行 stdin/stdout。标准输入结束即退出；服务还会在停止、超时或异常时依次关闭管道、等待、终止或强制终止进程。

运行环境只从受信任的进程配置选择，依次尝试 `RELIC_INTERACTION_PYTHON`、`RELIC_AI_PYTHON`、已有 `E:/lora-platform/.venv/Scripts/python.exe`，开发环境还可尝试当前 Python。候选环境没有 OpenCV 时继续尝试后续现有环境。请求本身不能提供路径。整个流程不自动安装软件或下载模型。

如果现有环境已能导入 `cv2`，无需安装另一份 OpenCV。确有需要时，可在独立可选环境中使用 `requirements-proximity.txt`；不要在同一环境重复安装多个 OpenCV 发行包。Haar 分类器从该环境的 OpenCV 自带数据中读取，不随本项目打包权重。Windows 中文路径通过 Python 读取 XML 后交给内存分类器，避免 OpenCV 文件路径兼容问题。

## 验证与限制

测试没有打开用户摄像头或申请真实硬件权限。

- `tools/check_proximity.py`：使用 OpenCV 官方公开静态样张，实际启动本机 Haar 工作进程；检查人脸框、空白及双脸帧、令牌、跨站请求、帧限制、速率限制、EOF 和空闲回收。检查前后未产生任何帧或会话存档。
- `tools/qa_proximity_sensor.cjs`：使用合成画布 `captureStream` 和模拟授权，检查默认关闭、校准、滞回、无人多人、拒绝授权、销毁、窗口隐藏、旧授权晚返回以及旧帧完成后的快速关开竞态。
- 报告保存在 `work/proximity-qa/api-report.json` 与 `work/proximity-qa/sensor-report.json`。静态样张仅在 `work` 中，不进入公开源码包。

Haar 检测依赖正脸、光照和遮挡情况，可能漏检或误检。转头、遮脸或多人入镜时不适合依赖自动触发。它不用于判断用户意图或身体状态，也不代替手动控制。此次验证覆盖真实静态图检测与模拟视频生命周期；未以用户真实摄像头验证日常坐姿体验。

## 官方依据

- [OpenCV Cascade Classifier 官方教程](https://docs.opencv.org/4.x/db/d28/tutorial_cascade_classifier.html)：分类器与人脸框检测。
- [OpenCV 官方公开样张](https://github.com/opencv/opencv/blob/4.x/samples/data/lena.jpg)：仅用于离线功能验证。
- [MDN：getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)：明确授权、媒体约束及权限失败情况。
- [MDN：MediaStreamTrack.stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop)：停止每个媒体轨道并释放引用。
- [MDN：Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)：窗口隐藏时停止感知；仅 CSS 隐藏 iframe 不触发该事件，因此仍须显式 `destroy()`。
