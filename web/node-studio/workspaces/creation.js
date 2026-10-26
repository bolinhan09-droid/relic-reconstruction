import { createWorkspace, field, actions, notice, inputFor } from './shared.js';
import { createRectangleCanvas } from './canvas-selection.js';
import { generationBrief } from './generation-brief.js';

export async function quickCreate(container, context) {
  const ws = createWorkspace(container, context, { title: '先提出一个创作方向', description: '不用一次设定完所有细节。描述想要的整体感觉，生成任务准备好后，在图像生成节点选择模型并运行。', kicker: 'QUICK CREATE' });
  const brief = generationBrief(ws, context);
  ws.body.append(ws.preview(), brief.element,
    field(ws, 'scope', '这一步的范围', { options: [{ value: 'whole', label: '整体服装' }, { value: 'cape', label: '披风' }, { value: 'inner', label: '内搭' }, { value: 'selected', label: '当前部件' }], value: ws.params.scope || 'whole' }).group,
    actions(ws.button('准备生成', async () => { brief.assertReady(); ws.patch({ scope: ws.params.scope || 'whole' }); await ws.run(); }, { primary: true })));
  return ws;
}

export async function regionGenerate(container, context) {
  const ws = createWorkspace(container, context, { title: '圈出这一处，再交给 AI', description: '先在图上拖动框选，再写这一区域的变化。可添加多个区域；实际生图由后续图像生成节点执行。', kicker: 'REGION GENERATION' });
  const selection = await createRectangleCanvas(ws, inputFor(context), ws.params.regions || [], regions => ws.patch({ regions }));
  ws.body.append(selection.element, actions(ws.button('撤销上一个选区', () => selection.undo()), ws.button('清除选区', () => selection.clear())),
    field(ws, 'intent', '这些位置应该发生什么变化', { type: 'textarea', placeholder: '例如：沿下摆增加不规则焦边，保留缝线和衣服外轮廓。' }).group,
    actions(ws.button('准备局部生成任务', async () => { if (!selection.regions().length) throw new Error('先在图片上框出至少一处区域。'); if (!String(ws.params.intent || '').trim()) throw new Error('请描述选区里的变化。'); ws.patch({ regions: selection.regions() }); await ws.run(); }, { primary: true })));
  return ws;
}

const legacyDefinitions = {
  precision_edit: { title: '把每一处细节，改到自己满意', description: '打开已有精修画布：保留详细笔刷、保护区、图层和褶皱贴合。完成后将结果带回当前节点。', kicker: 'PRECISION EDIT', mode: 'brush', action: '进入精致修改画布' },
  garment_split: { title: '先分清楚，要改哪一件', description: '在真实图片上为披风、内搭等部件划分选区。当前使用可校正的手动分区，不冒充自动语义识别。', kicker: 'GARMENT PARTS', mode: 'split', action: '进入服装分区工作区' },
  flatten_map: { title: '把穿着效果，对应到真实平铺衣服', description: '上传真实平铺照片，通过确认定位点建立对应关系。未知和遮挡区域需要保留标记，这不是缝纫裁片重建。', kicker: 'FLATTEN & MAP', mode: 'mapping', action: '进入展平与映射工作区' }
};

export async function legacyWorkspace(container, context) {
  const definition = legacyDefinitions[context.node.type];
  const ws = createWorkspace(container, context, definition);
  ws.body.append(ws.preview(), notice(context.node.type === 'flatten_map' ? '可先映射再精修，也可以画完再映射。对应关系来自你确认的真实服装位置；单张照片无法保证隐藏区域的几何准确。' : '这一步会打开已经可用的详细工作区，保存独立笔触和定位资料。'),
    actions(ws.button(definition.action, async () => { await ws.save(); await context.openLegacy(definition.mode); }, { primary: true })));
  return ws;
}
