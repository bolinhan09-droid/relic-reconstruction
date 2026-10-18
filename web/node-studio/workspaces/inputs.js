import { createWorkspace, el, field, actions, uploadControl, assetURL } from './shared.js';

export async function garmentInput(container, context) {
  const ws = createWorkspace(container, context, { title: '这次改造，从你的衣服开始', description: '一份真实服装档案。正面是起点，背面和平铺照片可以之后继续补充。', kicker: 'GARMENT INPUT' });
  const slots = el('div', { class: 'ns-ws-upload-grid' });
  for (const [key, label] of [['front', '正面照片 · 必需'], ['back', '背面照片 · 可选'], ['flat', '平铺照片 · 可选']]) {
    const card = el('section', { class: 'ns-ws-upload-card' }, el('h3', { text: label }));
    const preview = el('div', { class: 'ns-ws-upload-preview' });
    const refresh = () => { preview.replaceChildren(); const asset = ws.params[key] || (key === 'front' ? context.node.output?.asset || context.node.output?.front : null); if (assetURL(asset)) preview.append(el('img', { src: assetURL(asset), alt: label })); else preview.append(el('p', { text: key === 'front' ? 'PNG / JPG / WebP，最多 20 MB' : '随时可以补充' })); };
    card.append(preview, uploadControl(ws, context, '选择图片', async asset => { ws.patch({ [key]: asset }); await ws.save(); refresh(); }));
    refresh(); slots.append(card);
  }
  const name = field(ws, 'garmentName', '服装名称', { placeholder: '例如：乌尔比安 · 披风与内搭' });
  ws.body.append(name.group, slots, actions(ws.button('保存服装输入', async () => { if (!ws.params.front && !context.node.output?.imageUrl) throw new Error('请先上传真实服装的正面照片。'); await ws.run(); }, { primary: true })));
  return ws;
}

export async function imageReference(container, context) {
  const ws = createWorkspace(container, context, { title: '收集这次创作的参考', description: '可以放立绘、喜欢的痕迹、材质细节。参考不会替换真实服装。', kicker: 'REFERENCE COLLECTION' });
  const gallery = el('div', { class: 'ns-ws-reference-grid' });
  const refresh = () => { gallery.replaceChildren(); (ws.params.references || []).forEach((asset, index) => {
    const card = el('figure', { class: 'ns-ws-reference-card' }, el('img', { src: assetURL(asset), alt: asset.name || `参考 ${index + 1}` }), el('figcaption', { text: asset.name || `参考 ${index + 1}` }));
    card.append(ws.button('移除', async () => { ws.patch({ references: ws.params.references.filter((_, i) => i !== index) }); await ws.save(); refresh(); })); gallery.append(card);
  }); };
  const role = field(ws, 'referenceRole', '这组参考主要用来参考什么', { options: [{ value: 'appearance', label: '整体外观' }, { value: 'damage', label: '血迹／磨损／破损' }, { value: 'character', label: '角色二维设定' }, { value: 'material', label: '材料效果' }], value: ws.params.referenceRole || 'appearance' });
  const description = field(ws, 'notes', '想参考的地方', { type: 'textarea', placeholder: '例如：参考第一张的血迹分布，保留我的服装结构。' });
  const concept = field(ws, 'conceptPrompt', '二维参考生成描述 · 可选', { type: 'textarea', placeholder: '希望先探索动漫版效果，可以在这里准备任务，再连接图像生成节点。' });
  ws.body.append(uploadControl(ws, context, '添加参考图片', async asset => { ws.patch({ references: [...(ws.params.references || []), asset] }); await ws.save(); refresh(); }, { multiple: true }), gallery, role.group, description.group, concept.group,
    actions(ws.button('保存参考', () => ws.run(), { primary: true })));
  refresh(); return ws;
}
