import { garmentInput, imageReference } from './inputs.js';
import { sceneContext, productionContext } from './contexts.js';
import { quickCreate, regionGenerate, legacyWorkspace } from './creation.js';
import { blendCreate } from './blend.js';
import { imageGenerate } from './image-generation.js';
import { assistantWorkspace } from './assistants.js';
import { gestureSimulation } from './experiments.js';
import { battleSimulation3D } from './battle-3d.js';
import { productionGuide, stencilExport } from './production.js';
import { createWorkspace, notice } from './shared.js';
import { characterResearch } from './character-research.js';
import { branchCreate, branchMerge } from './branches.js';
import { arrangeWorkspace } from './layout.js';
import { garmentWorkspace } from './garments.js';

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
  battle_simulation: battleSimulation3D,
  image_generate: imageGenerate,
  intent_assist: assistantWorkspace,
  design_advice: assistantWorkspace,
  design_review: assistantWorkspace,
  agent_execute: assistantWorkspace,
  garment_split: garmentWorkspace,
  garment_flatten: garmentWorkspace,
  flatten_map: legacyWorkspace,
  production_guide: productionGuide,
  stencil_export: stencilExport,
  branch_create: branchCreate,
  branch_merge: branchMerge
});

export async function mountWorkspace(container, context) {
  const renderer = workspaceRegistry[context.node.type];
  if (renderer) return arrangeWorkspace(await renderer(container, context), context);
  const workspace = createWorkspace(container, context, { title: '这个工作区尚未接入' });
  workspace.body.append(notice('节点入口已保留。当前版本没有为这个节点注册实现，不会产生假结果。'));
  return workspace;
}
