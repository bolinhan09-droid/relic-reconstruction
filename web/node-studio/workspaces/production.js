import { createWorkspace, field, actions, notice } from './shared.js';
import { makingKitWorkspace } from './making-kit.js';

export async function productionGuide(container, context) {
  const ws = createWorkspace(container, context, { title: '把设计，变成可以照着做的步骤', description: '结合你的方案与制作条件，整理分区域步骤、小样测试和工具准备。', kicker: 'MAKING GUIDE' });
  ws.body.append(ws.preview(), field(ws, 'intent', '这次制作最在意什么', { type: 'textarea', placeholder: '例如：尽量保留原服，先处理领巾，再处理披风；希望血迹是干透后的哑光效果。' }).group,
    field(ws, 'skillLevel', '你目前的经验', { options: [{ value: 'beginner', label: '第一次尝试，希望步骤详细' }, { value: 'some', label: '做过一些，主要需要位置与效果提示' }, { value: 'experienced', label: '熟悉制作，主要整理方案' }], value: ws.params.skillLevel || 'beginner' }).group,
    notice('实际渗色、清洗和受热效果，请先用材料小样确认'),
    actions(ws.button('整理制作指导', () => ws.run(), { primary: true }),ws.button('把方案做出来', () => context.startMaking(),{className:'ns-start-making'})));
  return ws;
}

export async function stencilExport(container, context) {
  return makingKitWorkspace(container, context);
}
