/** Optional, explicit camera control. Only low-resolution frames visit localhost RAM.
 * No video, frame, face box, calibration value, or token enters project persistence.
 */
export class RelativeFaceProximity {
  constructor({ calibrationFrames = 6, enterRatio = 1.24, exitRatio = 1.12, stableFrames = 2 } = {}) {
    this.calibrationFrames = calibrationFrames; this.enterRatio = enterRatio; this.exitRatio = exitRatio; this.stableFrames = stableFrames;
    this.reset();
  }
  reset() { this.samples = []; this.baseline = null; this.smoothed = null; this.near = false; this.enterCount = 0; this.exitCount = 0; }
  update(faces, faceCount = Array.isArray(faces) ? faces.length : 0) {
    const valid = Array.isArray(faces) && faceCount === 1 && faces.length === 1 && ['x', 'y', 'w', 'h'].every(key => typeof faces[0][key] === 'number' && Number.isFinite(faces[0][key]))
      && faces[0].x >= 0 && faces[0].y >= 0 && faces[0].w > 0 && faces[0].h > 0 && faces[0].x + faces[0].w <= 1.00001 && faces[0].y + faces[0].h <= 1.00001;
    if (!valid) {
      this.near = false; this.smoothed = null; this.enterCount = this.exitCount = 0;
      if (!this.baseline) this.samples = [];
      return { near: false, calibrated: !!this.baseline, status: faceCount > 1 ? '多人入镜，自动放大已暂停' : '未找到稳定正脸，可继续使用 M 键' };
    }
    const size = Math.sqrt(faces[0].w * faces[0].h);
    if (!this.baseline) {
      this.samples.push(size); this.samples = this.samples.slice(-this.calibrationFrames);
      if (this.samples.length < this.calibrationFrames || Math.max(...this.samples) / Math.min(...this.samples) > 1.16) {
        return { near: false, calibrated: false, status: `请保持自然坐姿，正在校准 ${Math.min(this.samples.length, this.calibrationFrames)}/${this.calibrationFrames}` };
      }
      const sorted = [...this.samples].sort((a, b) => a - b);
      this.baseline = sorted[Math.floor(sorted.length / 2)]; this.smoothed = 1;
      return { near: false, calibrated: true, status: '已校准，稍微靠近可触发放大' };
    }
    const ratio = size / this.baseline;
    if (!Number.isFinite(ratio) || ratio > 3.5 || ratio < .15) {
      this.near = false; this.smoothed = null; this.enterCount = this.exitCount = 0;
      return { near: false, calibrated: true, status: '位置变化较大，请重新校准' };
    }
    this.smoothed = this.smoothed === null ? ratio : this.smoothed * .45 + ratio * .55;
    if (!this.near) {
      this.enterCount = this.smoothed >= this.enterRatio ? this.enterCount + 1 : 0;
      if (this.enterCount >= this.stableFrames) { this.near = true; this.enterCount = 0; }
    } else {
      this.exitCount = this.smoothed <= this.exitRatio ? this.exitCount + 1 : 0;
      if (this.exitCount >= this.stableFrames) { this.near = false; this.exitCount = 0; }
    }
    return { near: this.near, calibrated: true, ratio: this.smoothed, status: this.near ? '靠近放大中，退后恢复' : '已开启，靠近触发；M 键也可切换' };
  }
}

function makeButton(text) { const element = document.createElement('button'); element.type = 'button'; element.className = 'ns-button ns-quiet'; element.textContent = text; return element; }

export function mountProximitySensor(container, { onNear = () => {}, onStatus = () => {}, notify = () => {} } = {}) {
  const wrapper = document.createElement('div'); wrapper.className = 'ns-proximity-sensor';
  wrapper.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px';
  const toggle = makeButton('靠近放大 · 关闭'), recalibrateButton = makeButton('重新校准');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.title = '可选：点击开启后请求摄像头；只在本机分析相对脸框大小，不保存画面。也可使用 M 键放大。';
  recalibrateButton.disabled = true;
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'max-width:290px;color:inherit;opacity:.76';
  status.textContent = '默认关闭，可使用 M 键放大';
  wrapper.append(toggle, recalibrateButton, status); container.append(wrapper);
  const tracker = new RelativeFaceProximity(), video = document.createElement('video'), canvas = document.createElement('canvas');
  video.muted = true; video.playsInline = true; video.autoplay = true;
  const listeners = new AbortController();
  let enabled = false, enabling = false, destroyed = false, stream = null, session = null, timer = null, generation = 0, frameController = null, lastNear = false, readyChecks = 0;
  function say(text) { if (status.textContent === text) return; status.textContent = text; onStatus(text); }
  function emit(value) { const next = !!value; if (lastNear !== next) { lastNear = next; onNear(next); } }
  async function request(path, payload, { token, signal, keepalive = false } = {}) {
    const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Proximity-Token': token } : {}) };
    const response = await fetch(path, { method: payload === undefined ? 'GET' : 'POST', headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal, keepalive, cache: 'no-store' });
    let result; try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) { const error = new Error(typeof result.detail === 'string' ? result.detail : '本机靠近感知暂不可用，可使用 M 键。'); error.status = response.status; throw error; }
    return result;
  }
  function closeSession(value) {
    if (!value?.sessionId || !value?.token) return;
    // keepalive survives pagehide; the idle reaper also covers a crashed browser.
    request(`/api/proximity/sessions/${encodeURIComponent(value.sessionId)}/stop`, { token: value.token }, { keepalive: true }).catch(() => {});
  }
  function stopTracks(value) { for (const track of value?.getTracks?.() || []) { try { track.stop(); } catch {} } }
  function disable(message = '已关闭，可继续使用 M 键') {
    generation++; enabled = enabling = false; clearTimeout(timer); timer = null;
    frameController?.abort(); frameController = null;
    stopTracks(stream); stream = null; video.pause(); video.srcObject = null;
    canvas.width = canvas.height = 0;
    const previous = session; session = null; closeSession(previous);
    tracker.reset(); emit(false); toggle.textContent = '靠近放大 · 关闭'; toggle.setAttribute('aria-pressed', 'false'); recalibrateButton.disabled = true;
    if (!destroyed) say(message);
  }
  async function tick(token) {
    const frameStarted = performance.now();
    if (destroyed || !enabled || token !== generation) return;
    if (!container.isConnected || document.hidden) { disable('工作区已离开，摄像头已关闭'); return; }
    if (video.readyState < 2 || video.videoWidth < 64 || video.videoHeight < 64) {
      if (++readyChecks > 12) { disable('没有可读取的摄像头画面，可使用 M 键'); return; }
      timer = setTimeout(() => tick(token), 450); return;
    }
    try {
      readyChecks = 0;
      const scale = Math.min(1, 320 / video.videoWidth, 240 / video.videoHeight);
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      if (canvas.width < 64 || canvas.height < 64) throw new Error('摄像头比例不适合本机感知，可使用 M 键。');
      canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', .65);
      const controller = new AbortController(); frameController = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      let result;
      try { result = await request(`/api/proximity/sessions/${encodeURIComponent(session.sessionId)}/frames`, { image }, { token: session.token, signal: controller.signal }); }
      finally { clearTimeout(timeout); if (frameController === controller) frameController = null; if (token === generation) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); }
      if (destroyed || !enabled || token !== generation) return;
      const state = tracker.update(result.faces, result.faceCount); emit(state.near); say(state.status);
    } catch (error) {
      if (token !== generation || destroyed) return;
      if (error.status !== 429) { disable(error.name === 'AbortError' ? '本机检测超时，已关闭摄像头；可使用 M 键' : error.message); return; }
    }
    if (!destroyed && enabled && token === generation) timer = setTimeout(() => tick(token), Math.max(60, 450 - (performance.now() - frameStarted)));
  }
  async function enable() {
    if (destroyed || enabled || enabling) return false;
    const token = ++generation; enabling = true; toggle.textContent = '取消开启'; say('正在检查可选本机检测环境…');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前窗口不支持摄像头授权，可继续使用 M 键放大。');
      const caps = await request('/api/proximity/capabilities');
      if (destroyed || token !== generation) return false;
      if (!caps.available) throw new Error(caps.reason || '本机检测环境未就绪，可使用 M 键。');
      const created = await request('/api/proximity/sessions', { confirmed: true });
      if (destroyed || token !== generation) { closeSession(created); return false; }
      session = created; say('请允许摄像头；仅在本机分析，不保存画面');
      const pending = navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 320, max: 640 }, height: { ideal: 240, max: 480 }, frameRate: { ideal: 3, max: 5 }, facingMode: 'user' } }).then(value => {
        if (destroyed || token !== generation) { stopTracks(value); return null; } return value;
      });
      let permissionTimer, acquiredStream;
      try { acquiredStream = await Promise.race([pending, new Promise((_, reject) => { permissionTimer = setTimeout(() => reject(new Error('摄像头尚未授权，已暂停；需要时可重新开启。')), 12000); })]); }
      finally { clearTimeout(permissionTimer); }
      if (!acquiredStream || destroyed || token !== generation) { stopTracks(acquiredStream); return false; }
      stream = acquiredStream; video.srcObject = acquiredStream; await video.play();
      if (destroyed || token !== generation) { stopTracks(acquiredStream); return false; }
      enabled = true; enabling = false; tracker.reset(); readyChecks = 0;
      toggle.textContent = '靠近放大 · 开启'; toggle.setAttribute('aria-pressed', 'true'); recalibrateButton.disabled = false;
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => { if (enabled) disable('摄像头已断开，可继续使用 M 键'); }, { once: true });
      say('请保持自然坐姿，正在校准'); tick(token); return true;
    } catch (error) {
      if (destroyed || token !== generation) return false;
      const message = error.name === 'NotAllowedError' ? '摄像头未获授权，可继续使用 M 键放大' : error.name === 'NotFoundError' ? '未找到摄像头，可继续使用 M 键放大' : error.message;
      disable(message); notify(message); return false;
    }
  }
  function recalibrate() { if (!enabled || destroyed) return; tracker.reset(); emit(false); say('重新校准：请保持自然坐姿'); }
  toggle.addEventListener('click', () => enabled || enabling ? disable() : enable(), { signal: listeners.signal });
  recalibrateButton.addEventListener('click', recalibrate, { signal: listeners.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden && (enabled || enabling)) disable('窗口已隐藏，摄像头已关闭'); }, { signal: listeners.signal });
  window.addEventListener('pagehide', () => disable(), { signal: listeners.signal });
  window.addEventListener('beforeunload', () => disable(), { signal: listeners.signal });
  return { enable, disable, recalibrate, get enabled() { return enabled; },
    destroy() { if (destroyed) return; destroyed = true; disable(); listeners.abort(); wrapper.remove(); },
  };
}
