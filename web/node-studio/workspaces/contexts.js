import { createWorkspace, el, field, actions, notice, inputFor, assetURL } from './shared.js';

export async function sceneContext(container, context) {
  const ws = createWorkspace(container, context, { title: '让 AI 找资料，你来选这一场', description: '不用手填角色背景。让视觉助手先识别服装，确认角色后寻找战斗场景，最后由你选择采用。', kicker: 'STORY & CONSTRAINTS' });
  const workflow = context.getWorkflow?.() || context.workflow;
  const currentSource = assetURL(inputFor(context));
  const research = workflow.nodes.filter(node => node.type === 'character_research' && node.params?.selectedScene
    && (!node.params.adoptedImageFingerprint || node.params.adoptedImageFingerprint === node.params.imageFingerprint)
    && (!node.params.adoptedSourceImageUrl || node.params.adoptedSourceImageUrl === currentSource)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]?.params;
  const character = research?.selectedCharacter, scene = research?.selectedScene;
  const selected = el('section', { class: 'ns-research-current-scene' });
  if (character && scene) {
    selected.append(el('span', { class: 'ns-research-badge', text: '当前已采用' }), el('h3', { text: `${character.name}${character.ip ? ' · ' + character.ip : ''}` }), el('h4', { text: scene.title }), el('p', { text: scene.summary || '' }));
    if (scene.designDirection) selected.append(el('p', { class: 'ns-research-direction', text: typeof scene.designDirection === 'string' ? scene.designDirection : JSON.stringify(scene.designDirection) }));
    for (const source of research.adoptedSources || research.researchSources || []) {
      try { const url = new URL(source.url); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) selected.append(el('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer', text: source.title || url.hostname })); } catch { /* Unreadable references are not made clickable. */ }
    }
  } else if (ws.params.character || ws.params.scene) selected.append(el('span', { class: 'ns-research-badge', text: '之前保存的设定' }), el('h3', { text: ws.params.character || '当前角色' }), el('p', { text: ws.params.scene || '还没有选择场景。' }));
  else selected.append(el('h3', { text: '还没选场景？从服装照片开始。' }), el('p', { text: '识别候选 → 你确认角色 → AI 检索资料 → 你选择一个创作方向。' }));
  selected.append(actions(ws.button(character && scene ? '更换角色或场景' : '识别角色并寻找场景', async () => {
    if (!context.addCharacterResearch) throw new Error('请从设定节点库加入“角色识别与资料”节点，或重新打开新版创作台。');
    await context.addCharacterResearch();
  }, { primary: true })));
  const details = el('details', { class: 'ns-ws-details' }, el('summary', { text: '补充一点自己的想法 · 可选' }));
  details.append(el('p', { class: 'ns-ws-description', text: '保留你已选的角色和场景，只补充这次希望强调的细节。' }),
    field(ws, 'sceneNotes', '希望强调的情境或情绪', { type: 'textarea', rows: 3, placeholder: '例如：刚结束交战，痕迹集中在披风下摆；整体不要太狼狈。' }).group,
    field(ws, 'protectedNotes', '特别需要保留的地方', { type: 'textarea', rows: 2, placeholder: '例如：胸前徽章、帽型、腰带。' }).group,
    field(ws, 'bloodColor', '希望使用的痕迹主色', { type: 'color', value: ws.params.bloodColor || '#6d2530', help: '没有确认血色设定时，保持为你的视觉选择。后续笔刷仍能修改。' }).group,
    actions(ws.button('保存补充设定', () => ws.run())));
  ws.body.append(selected, details, notice('浏览候选和资料不会改变已经采用的方案；明确采用新场景后，才影响后续创作。'));
  return ws;
}

export async function productionContext(container, context) {
  const ws = createWorkspace(container, context, { title: '制作前，先知道这些就够了', description: '不知道具体面料名称也没关系。先选择你能判断的类别，详细成分以后通过标签、商品资料或小样补充。', kicker: 'MAKING CONDITIONS' });
  const fields = [
    field(ws, 'materialKind', '大概是什么材料', { options: [{ value: 'unknown', label: '暂时不确定' }, { value: 'cloth', label: '布料' }, { value: 'leather', label: '皮革／仿皮' }, { value: 'mixed', label: '混合材料' }, { value: 'rigid', label: '硬质配件' }], value: ws.params.materialKind || 'unknown' }),
    field(ws, 'materialEvidence', '标签或商品页里的材料说明 · 可选', { type: 'textarea', rows: 3, placeholder: '可以粘贴商品描述。照片本身不能可靠判断精确纤维成分。' }),
    field(ws, 'productUrl', '商品页面 · 可选', { type: 'url', placeholder: 'https://…', help: '保存为资料来源；当前不会擅自抓取商品或判断材料。' }),
    field(ws, 'reversibleRequired', '希望之后能恢复吗', { options: [{ value: 'true', label: '尽量可恢复' }, { value: 'false', label: '接受永久改造' }, { value: 'unknown', label: '暂时不确定' }], value: String(ws.params.reversibleRequired ?? true) }),
    field(ws, 'tools', '手边有什么工具', { type: 'textarea', rows: 2, value: Array.isArray(ws.params.tools) ? ws.params.tools.join('、') : ws.params.tools || '', placeholder: '例如：喷壶、牙刷、海绵、裁纸刀、遮挡纸。' }),
    field(ws, 'materialTested', '已经在同材质小样上测试', { type: 'checkbox' })
  ];
  ws.body.append(el('div', { class: 'ns-ws-form-grid' }, fields.map(item => item.group)), actions(ws.button('保存制作条件', async () => { ws.patch({ reversibleRequired: fields[3].control.value === 'unknown' ? 'unknown' : fields[3].control.value === 'true', tools: fields[4].control.value.split(/[\n、，,]/).map(item => item.trim()).filter(Boolean) }); await ws.run(); }, { primary: true })));
  return ws;
}
