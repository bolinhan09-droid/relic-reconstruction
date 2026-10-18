import { createWorkspace, el, field, actions, notice, inputFor, assetURL, uploadControl } from './shared.js';
import { createRectangleCanvas } from './canvas-selection.js';

export async function productionGuide(container, context) {
  const ws = createWorkspace(container, context, { title: '把设计，变成可以照着做的步骤', description: '结合你的方案与制作条件，整理分区域步骤、小样测试和工具准备。', kicker: 'MAKING GUIDE' });
  ws.body.append(ws.preview(), field(ws, 'intent', '这次制作最在意什么', { type: 'textarea', placeholder: '例如：尽量保留原服，先处理领巾，再处理披风；希望血迹是干透后的哑光效果。' }).group,
    field(ws, 'skillLevel', '你目前的经验', { options: [{ value: 'beginner', label: '第一次尝试，希望步骤详细' }, { value: 'some', label: '做过一些，主要需要位置与效果提示' }, { value: 'experienced', label: '熟悉制作，主要整理方案' }], value: ws.params.skillLevel || 'beginner' }).group,
    notice('图像预览不能预测实际渗色、清洗或受热效果。制作指导会保留小样确认步骤，不将颜色比例当成通用配方。'),
    actions(ws.button('整理制作指导', () => ws.run(), { primary: true })));
  return ws;
}

export async function stencilExport(container, context) {
  const ws = createWorkspace(container, context, { title: '做一张有位置、有尺寸的辅助模板', description: '在真实平铺照片上框出需要遮罩的区域，生成带支撑桥的 SVG／DXF 初稿。当前支持简单矩形窗口，不会自动把照片变成精细血迹镂空。', kicker: 'STENCIL EXPORT' });
  const garment = context.workflow.nodes.find(node => node.type === 'garment_input');
  let flat = ws.params.flat || garment?.params?.flat || inputFor(context).flat;
  const pickerHost = el('div', { class: 'ns-ws-stencil-picker' }); let picker = null;
  const initial = (ws.params.polygons || []).filter(points => Array.isArray(points) && points.length >= 3).map(points => { const xs = points.map(p => p.x), ys = points.map(p => p.y); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; });
  const makePolygons = regions => regions.map(r => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]);
  async function mountPicker(regions = []) {
    picker?.destroy(); pickerHost.replaceChildren();
    if (!assetURL(flat)) { pickerHost.append(notice('请上传实际平铺照片，或在服装输入里补充平铺照片。穿着图不直接用于按尺寸加工。')); return; }
    picker = await createRectangleCanvas(ws, flat, regions, rectangles => ws.patch({ polygons: makePolygons(rectangles) }));
    pickerHost.append(picker.element, actions(ws.button('撤销窗口', () => picker.undo()), ws.button('清除窗口', () => picker.clear())));
  }
  const width = field(ws, 'widthMm', '照片覆盖的实际宽度（毫米）', { type: 'number', min: 10, max: 5000, step: 1, value: ws.params.widthMm || 1000, help: '填写整张平铺照片对应的测量范围，不是自动猜测衣服尺寸。' });
  const height = field(ws, 'heightMm', '照片覆盖的实际高度（毫米）', { type: 'number', min: 10, max: 5000, step: 1, value: ws.params.heightMm || 1000 });
  const bridge = field(ws, 'bridgeMm', '支撑桥宽度（毫米）', { type: 'number', min: 1, max: 30, step: .5, value: ws.params.bridgeMm || 2 });
  const flatConfirm = field(ws, 'flatConfirmed', '我确认这张照片是实际平铺服装，当前窗口位置已经核对', { type: 'checkbox' });
  const scaleConfirm = field(ws, 'scaleConfirmed', '我已实测并确认整张照片对应的宽高，打印时保持 100% 比例', { type: 'checkbox' });
  ws.body.append(uploadControl(ws, context, '上传／更换真实平铺照片', async asset => { flat = asset; ws.patch({ flat: asset, flatConfirmed: false, scaleConfirmed: false, polygons: [] }); flatConfirm.control.checked = false; scaleConfirm.control.checked = false; await ws.save(); await mountPicker(); }), pickerHost,
    el('div', { class: 'ns-ws-form-grid' }, width.group, height.group, bridge.group), flatConfirm.group, scaleConfirm.group,
    notice('输出是遮罩定位辅助模板，不是缝纫裁片。先小尺寸打样并核对定位；激光切割材料与最小桥宽还需交加工方确认。'),
    actions(ws.button('生成 SVG／DXF 模板', async () => {
      if (!assetURL(flat)) throw new Error('先补充真实平铺照片。');
      if (!flatConfirm.control.checked || !scaleConfirm.control.checked) throw new Error('请先确认平铺位置与实际尺寸。');
      if (!picker?.regions().length) throw new Error('先在平铺照片上框出至少一个模板窗口。');
      if (Number(width.control.value) <= 0 || Number(height.control.value) <= 0) throw new Error('请输入有效的实测宽高。');
      ws.patch({ flat, widthMm: Number(width.control.value), heightMm: Number(height.control.value), bridgeMm: Number(bridge.control.value), flatConfirmed: true, scaleConfirmed: true, polygons: makePolygons(picker.regions()) }); await ws.run();
    }, { primary: true })));
  await mountPicker(initial); return ws;
}
