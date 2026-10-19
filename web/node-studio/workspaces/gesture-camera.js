import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const WASM_ROOT = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const HAND_MODEL = new URL('../vendor/mediapipe/models/hand_landmarker.task', import.meta.url).href;
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
let active = null;
let generation = 0;

/** Stop the current camera session, including a pending permission/model load. */
export function stopHandInput() {
  generation += 1;
  active?.stop();
  active = null;
}

/**
 * Call directly from a user's click. Coordinates follow the mirrored camera by
 * default. `pressure` is pinch tightness for brush control, not physical force.
 * onGesture: { x, y, pressure, pinch, gesture, phase, tracked }
 * onStatus: { state: 'loading'|'ready'|'tracking'|'stopped'|'error', message }
 */
export async function startHandInput({ video, canvas, onGesture, onStatus, mirror = true } = {}) {
  if (!(video instanceof HTMLVideoElement)) throw new TypeError('需要摄像头视频元素。');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前窗口不支持摄像头，请使用本机桌面窗口或 localhost 页面。');
  if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('请点击“开启摄像头”后再开始手势输入。');
  stopHandInput();
  const token = generation;
  let stopped = false;
  let stream = null;
  let detector = null;
  let frameId = 0;
  let lastTime = -1;
  let lastFrame = -Infinity;
  let pinching = false;
  let cursor = null;
  let tracking = false;
  const context = canvas?.getContext('2d') || null;
  const notify = (state, message) => {
    try { onStatus?.({ state, message }); } catch (error) { console.error('手势状态回调出错', error); }
  };
  const emit = (event) => {
    try { onGesture?.(event); } catch (error) { console.error('手势输入回调出错', error); }
  };
  const endStroke = () => {
    if (pinching && cursor) emit({ ...cursor, pressure: 0, pinch: false, gesture: 'release', phase: 'end', tracked: false });
    pinching = false;
  };
  const onVisibility = () => { if (document.hidden) controller.stop(); };
  const controller = {
    stop() {
      if (stopped) return;
      stopped = true;
      endStroke();
      cancelAnimationFrame(frameId);
      stream?.getTracks().forEach(track => track.stop());
      if (video.srcObject === stream) { video.pause(); video.srcObject = null; }
      detector?.close();
      detector = null;
      context?.clearRect(0, 0, canvas.width, canvas.height);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', controller.stop);
      if (active === controller) active = null;
      notify('stopped', '摄像头已关闭');
    },
  };
  active = controller;
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', controller.stop);
  const obsolete = () => stopped || token !== generation;
  const draw = (landmarks) => {
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    if (!landmarks) return;
    const point = landmark => [(mirror ? 1 - landmark.x : landmark.x) * width, landmark.y * height];
    const color = getComputedStyle(canvas).color || '#ffffff';
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = Math.max(1.5, width / 320);
    context.globalAlpha = 0.75;
    context.beginPath();
    for (const [from, to] of CONNECTIONS) { context.moveTo(...point(landmarks[from])); context.lineTo(...point(landmarks[to])); }
    context.stroke();
    for (const landmark of landmarks) { context.beginPath(); context.arc(...point(landmark), width / 120, 0, Math.PI * 2); context.fill(); }
    context.globalAlpha = 1;
  };
  const frame = (now) => {
    if (obsolete()) return;
    if (!video.isConnected || document.hidden || stream?.getTracks().some(track => track.readyState === 'ended')) { controller.stop(); return; }
    frameId = requestAnimationFrame(frame);
    if (video.readyState < 2 || video.currentTime === lastTime || now - lastFrame < 50) return;
    lastTime = video.currentTime;
    lastFrame = now;
    try {
      const result = detector.detectForVideo(video, now);
      const landmarks = result.landmarks?.[0];
      draw(landmarks);
      if (!landmarks) {
        endStroke();
        cursor = null;
        if (tracking) notify('ready', '请将手放入镜头，捏合拇指与食指开始绘制');
        tracking = false;
        return;
      }
      if (!tracking) notify('tracking', '已识别手部：捏合绘制，松开停止');
      tracking = true;
      const aspect = video.videoWidth / Math.max(video.videoHeight, 1);
      const distance = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
      const ratio = distance(landmarks[4], landmarks[8]) / Math.max(distance(landmarks[5], landmarks[17]), 0.02);
      const nextPinch = ratio < (pinching ? 0.50 : 0.35);
      const target = { x: clamp(mirror ? 1 - landmarks[8].x : landmarks[8].x), y: clamp(landmarks[8].y) };
      cursor = cursor ? { x: cursor.x + (target.x - cursor.x) * 0.4, y: cursor.y + (target.y - cursor.y) * 0.4 } : target;
      const phase = nextPinch ? (pinching ? 'move' : 'start') : (pinching ? 'end' : 'hover');
      pinching = nextPinch;
      emit({ ...cursor, pressure: nextPinch ? clamp(1 - ratio / 0.6, 0.15, 1) : 0, pinch: nextPinch, gesture: nextPinch ? 'pinch' : 'open', phase, tracked: true });
    } catch (error) {
      controller.stop();
      notify('error', `手势识别失败：${error?.message || String(error)}`);
    }
  };
  notify('loading', '正在开启摄像头并加载本机手部识别模型…');
  try {
    // Request only from this explicit click path; no camera access at import time.
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    if (obsolete()) { stream.getTracks().forEach(track => track.stop()); return controller; }
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
    if (obsolete()) return controller;
    const created = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'CPU' },
      runningMode: 'VIDEO', numHands: 1,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.6,
    });
    if (obsolete()) { created.close(); return controller; }
    detector = created;
    notify('ready', '请将手放入镜头，捏合拇指与食指开始绘制');
    frameId = requestAnimationFrame(frame);
    return controller;
  } catch (error) {
    controller.stop();
    if (token !== generation) return controller;
    const message = error?.name === 'NotAllowedError' ? '摄像头权限未获允许，请在窗口权限设置中允许后重试。' : `无法开启手势输入：${error?.message || String(error)}`;
    notify('error', message);
    throw new Error(message, { cause: error });
  }
}
