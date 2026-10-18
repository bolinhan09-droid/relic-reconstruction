export async function api(method, path, body) {
  const form = body instanceof FormData;
  const response = await fetch(path, {method, credentials: 'same-origin', headers: body && !form ? {'Content-Type': 'application/json'} : {}, body: body === undefined ? undefined : form ? body : JSON.stringify(body)});
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof value.detail === 'string' ? value.detail : value.message || '操作未完成，请重试。');
    error.status = response.status;
    throw error;
  }
  return value;
}
export async function upload(file) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) throw Error('请选择 PNG、JPG 或 WebP 图片。');
  if (file.size > 20 * 1024 * 1024) throw Error('图片超过 20 MB，请缩小后再试。');
  const form = new FormData(); form.append('file', file);
  return api('POST', '/api/uploads', form);
}
export async function saveDownload(path, name) {
  const response = await fetch(path, {credentials: 'same-origin'});
  if (!response.ok) throw Error('导出未完成。');
  const blob = await response.blob();
  if (window.pywebview?.api?.save_export) {
    const encoded = await new Promise((resolve, reject) => {const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);});
    const result = await window.pywebview.api.save_export(name, encoded);
    if (!result.ok && !result.cancelled) throw Error(result.message || '未保存。');
    return;
  }
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}
