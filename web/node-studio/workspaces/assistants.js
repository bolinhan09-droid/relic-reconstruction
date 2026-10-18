import { createWorkspace, el, field, actions, notice, inputFor } from './shared.js';

const definitions = {
  intent_assist: { title: '把一句想法，整理成可操作的方向', kicker: 'INTENT ASSIST', description: '整理你希望保留、增加和避免的内容，得到可以继续修改的创作任务。', label: '你目前的想法', action: '整理想法' },
  design_advice: { title: '一起看看，下一步还能怎么改', kicker: 'DESIGN ADVICE', description: '结合当前方案和场景提出候选方向。建议不会直接覆盖衣服。', label: '最想讨论什么', action: '获得修改建议' },
  design_review: { title: '停一下，检查整版方案', kicker: 'DESIGN REVIEW', description: '按场景、保护区域和制作准备检查方案，留下明确的待确认事项。', label: '特别希望检查什么', action: '检查当前方案' },
  agent_execute: { title: '选好这一步，让助手协助落实', kicker: 'COLLABORATIVE EXECUTION', description: '先选择具体操作。可以准备下一步任务或检查制作资料，不会自动调用付费生图。', label: '要执行的修改意图', action: '执行已选择的操作' }
};

export async function assistantWorkspace(container, context) {
  const definition = definitions[context.node.type], ws = createWorkspace(container, context, definition);
  const input = inputFor(context);
  ws.body.append(ws.preview(input), field(ws, 'intent', definition.label, { type: 'textarea', rows: 4, placeholder: '例如：我觉得下摆太密，想更克制一点，但保留右侧主飞溅。' }).group);
  if (context.node.type === 'agent_execute') ws.body.append(field(ws, 'adviceSelection', '这次执行什么', { options: [{ value: 'prepare_quick', label: '把想法整理为整体生成任务' }, { value: 'open_precision', label: '为分层精修准备独立工作区' }, { value: 'prepare_guide', label: '整理制作指导与小样步骤' }], value: ws.params.adviceSelection || 'prepare_quick' }).group);
  if (context.node.type === 'design_review') ws.body.append(field(ws, 'reviewFocus', '审阅重点', { options: [{ value: 'overall', label: '整体分布与场景' }, { value: 'preservation', label: '角色特征与保护区域' }, { value: 'production', label: '制作准备与可恢复要求' }], value: ws.params.reviewFocus || 'overall' }).group);
  ws.body.append(notice('当前版本使用本机规则整理需求和检查准备项，不进行联网检索或图像语义判断。后续可在这个入口接入对话模型。'),
    actions(ws.button(definition.action, () => ws.run(), { primary: true })));
  return ws;
}
