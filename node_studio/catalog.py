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
    _node("blend_create", "融合创作", "creation", "三角权重表达候选偏好，生成融合任务；不同照片不冒充精确语义插值。", outputs=("garment", "generation_task"), capability="experimental"),
    _node("region_generate", "AI 选区生图", "creation", "准备局部选区、修改要求与保护范围；接图像生成节点执行。", outputs=("garment", "generation_task")),
    _node("gesture_simulation", "手势交互模拟", "creation", "可用鼠标与触控动作生成实验痕迹草稿；摄像头手势识别入口保留，尚未接入。", capability="experimental", action="workspace"),
    _node("battle_simulation", "真实战斗情景模拟", "creation", "可操作二维战斗事件草稿并生成程序笔触；完整三维战斗、真实服装配准尚未实现。", capability="experimental", action="workspace"),
    _node("image_generate", "图像生成", "ai", "集中管理模型执行；明确点击并确认后才调用在线接口。", inputs=("garment", "generation_task"), action="generation"),
    _node("intent_assist", "想法整理", "ai", "将想法整理为需求卡；本地规则辅助明确标记，不冒充大模型理解。", placement="both", outputs=("garment", "intent")),
    _node("design_advice", "修改建议", "ai", "根据已填写信息提供可选择的建议；本地模式不宣称已经视觉识别。", placement="both", outputs=("garment", "suggestions")),
    _node("design_review", "整体审阅", "ai", "核查资料与制作前置条件；不凭空给角色还原度评分。", placement="both", outputs=("garment", "review")),
    _node("agent_execute", "协作执行", "ai", "执行已选定的可用工具操作；跨工具自动改图保留入口，暂不伪造执行。", placement="both", capability="experimental", outputs=("garment", "execution")),
    _node("garment_split", "服装分割", "structure", "进入已有圈区工作台，由用户确定服装部件；不宣称自动识别裁片。", action="workspace", outputs=("garment", "parts")),
    _node("flatten_map", "展平与映射", "structure", "进入真实平铺照片与已确认对应点的映射工作台，结果仍可继续创作。", action="workspace", outputs=("garment", "mapping"), capability="experimental"),
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
            "connectionTypes": ["garment", "reference", "context", "generation_task", "suggestions", "review", "fabrication"],
            "rules": {"singleGarmentInput": True, "orderedMainline": True,
                      "explicitGeneration": True, "sideAttachments": True,
                      "preservePreviousOutputs": True}}
