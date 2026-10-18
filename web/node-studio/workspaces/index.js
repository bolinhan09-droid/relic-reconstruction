import { garmentInput, imageReference } from './inputs.js';
import { sceneContext, productionContext } from './contexts.js';
import { quickCreate, regionGenerate, legacyWorkspace } from './creation.js';
import { blendCreate } from './blend.js';
import { imageGenerate } from './image-generation.js';
import { assistantWorkspace } from './assistants.js';
import { gestureSimulation, battleSimulation } from './experiments.js';
import { productionGuide, stencilExport } from './production.js';
import { createWorkspace, notice } from './shared.js';
import { characterResearch } from './character-research.js';

/** Workspaces are separate modules; adding a capability never expands one giant view. */
export const workspaceRegistry = Object.freeze({
  garment_input: garmentInput,
  image_reference: imageReference,
  scene_context: sceneContext,
  character_research: characterResearch,
  production_context: productionContext,
  quick_create: quickCreate,
  precision_edit: legacyWorkspace,
  blend_create: blendCreate,
  region_generate: regionGenerate,
  gesture_simulation: gestureSimulation,
  battle_simulation: battleSimulation,
  image_generate: imageGenerate,
  intent_assist: assistantWorkspace,
  design_advice: assistantWorkspace,
  design_review: assistantWorkspace,
  agent_execute: assistantWorkspace,
  garment_split: legacyWorkspace,
  flatten_map: legacyWorkspace,
  production_guide: productionGuide,
  stencil_export: stencilExport
});

export async function mountWorkspace(container, context) {
  const renderer = workspaceRegistry[context.node.type];
  if (renderer) return renderer(container, context);
  const workspace = createWorkspace(container, context, { title: '这个工作区尚未接入' });
  workspace.body.append(notice('节点入口已保留。当前版本没有为这个节点注册实现，不会产生假结果。'));
  return workspace;
}
