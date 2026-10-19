"""Single node registry shared by the API and the overview/workspace renderer.

Capabilities describe implemented actions, not a promise that optional model
services are installed. Planned nodes deliberately have no pretend output.
"""
from __future__ import annotations

from copy import deepcopy


def _node(identifier, label, category, description, *, placement="main", slot="bottom",
          capability="available", inputs=("garment",), outputs=("garment",), action="local"):
    return {"id": identifier, "type": identifier, "label": label, "category": category,
            "description": description, "placement": placement, "slot": slot,
            "capability": capability, "inputs": list(inputs), "outputs": list(outputs),
            "action": action}


NODES = [
    _node("garment_input", "服装输入", "input", "一份真实服装档案，保存正反面、细节与原图。", inputs=(), action="input"),
    _node("image_reference", "图片参考", "input", "保存多张参考；二维设定仅作为参考，不能替代真实服装。", placement="attachment", slot="top", inputs=(), outputs=("reference",), action="input"),
    _node("scene_context", "角色与场景", "context", "保存角色、场景、血色、保护要求与资料出处；未知项保持未确认。", placement="both", slot="top", outputs=("garment", "context")),
    _node("character_research", "AI 识别与检索", "ai", "先看服装提出角色候选，确认角色后检索背景与战斗情境；选择有出处的场景用于后续创作。", placement="both", slot="top", outputs=("garment", "context"), action="research"),
    _node("production_context", "制作条件", "context", "保存已知材料、工具与可恢复要求，允许尚未确定。", placement="both", slot="top", outputs=("garment", "context")),
    _node("quick_create", "快速生成", "creation", "准备整体初稿任务；实际模型调用由图像生成节点执行。", outputs=("garment", "generation_task")),
    _node("precision_edit", "精致修改", "creation", "进入已有精修工作台，绘制独立血迹、割痕、磨损和焦痕。", action="workspace"),
    _node("blend_create", "融合创作", "creation", "拖动比例或三角控制器混合同底图笔触，也可分别选取血迹、刀痕等来源；不同照片接图像模型融合。", outputs=("garment", "generation_task")),
    _node("region_generate", "AI 选区生图", "creation", "准备局部选区、修改要求与保护范围；接图像生成节点执行。", outputs=("garment", "generation_task")),
    _node("gesture_simulation", "手势交互模拟", "creation", "开启本机摄像头识别捏合绘制动作，或用鼠标触控创作；动作幅度控制创作强度。", capability="experimental", action="workspace"),
    _node("battle_simulation", "真实战斗情景模拟", "creation", "旋转三维代理服装，挥刀记录实际命中的部件、位置、方向与UV；尚未与任意服装照片精确配准。", capability="experimental", action="workspace"),
    _node("image_generate", "图像生成", "ai", "集中管理模型执行；明确点击并确认后才调用在线接口。", inputs=("garment", "generation_task"), action="generation"),
    _node("intent_assist", "想法整理", "ai", "结合当前服装与场景，用视觉语言模型整理修改目标和保留条件。", placement="both", outputs=("garment", "intent")),
    _node("design_advice", "修改建议", "ai", "查看当前作品，讨论具体部位的修改方式和候选方向。", placement="both", outputs=("garment", "suggestions")),
    _node("design_review", "整体审阅", "ai", "结合修改前后图片、场景依据和制作条件进行视觉审阅。", placement="both", outputs=("garment", "review")),
    _node("agent_execute", "协作执行", "ai", "围绕所连接的节点理解任务、执行本地编辑，并准备跨节点协作；预览后采用，可恢复。", placement="both", outputs=("garment", "execution")),
    _node("garment_split", "服装分割", "structure", "点选或框选服装部件，用本机分割模型提取独立透明图片，选择部件继续创作。", action="workspace", outputs=("garment", "parts")),
    _node("garment_flatten", "服装展平", "structure", "四点校正可见衣片，或生成平铺参考；保留方法与未知区域说明。", action="workspace", outputs=("garment", "flat_reference"), capability="experimental"),
    _node("flatten_map", "效果映射", "structure", "将穿着图上的痕迹对应到真实平铺照片，通过确认定位点校准位置。", action="workspace", outputs=("garment", "mapping"), capability="experimental"),
    _node("branch_create", "探索分支", "structure", "从当前方案分出独立路线，保留原路线并比较不同方向。", outputs=("garment", "branches"), action="branch"),
    _node("branch_merge", "方案合拢", "structure", "收集各路线最后采用的图片，交给融合创作继续处理。", outputs=("candidate_set",), action="merge"),
    _node("production_guide", "制作指导", "production", "输出分区域建议、工具与小样验证步骤；不是材料物理预测。", outputs=("garment", "guide")),
    _node("stencil_export", "辅助模板生成", "production", "确认平铺位置与实际尺寸后，将明确的轮廓导出 SVG/DXF，附定位和尺度。", outputs=("garment", "fabrication"), capability="experimental"),
]

BY_TYPE = {node["type"]: node for node in NODES}
CATEGORIES = [
    {"id": "input", "label": "输入与参考"}, {"id": "context", "label": "设定与条件"},
    {"id": "creation", "label": "创作"}, {"id": "ai", "label": "AI 协作"},
    {"id": "structure", "label": "结构处理"}, {"id": "production", "label": "制作输出"},
]


def catalog():
    return {"schemaVersion": 1, "nodes": deepcopy(NODES), "categories": deepcopy(CATEGORIES),
            "connectionTypes": ["garment", "reference", "context", "generation_task", "suggestions", "review", "fabrication", "candidate_set"],
            "rules": {"singleGarmentInput": True, "orderedMainline": True,
                      "explicitGeneration": True, "sideAttachments": True,
                      "preservePreviousOutputs": True, "branchLanes": True, "nestedBranches": True,
                      "mergeCandidateSets": True}}
