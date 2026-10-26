"""Resolve a making kit from the current route's confirmed mapping only.

Graph provenance belongs here; physical recipes and file generation live in
making_kit. A nearby result on another branch is never a fabrication input.
"""
from __future__ import annotations

import copy
import uuid
from pathlib import Path

from fastapi import HTTPException

from .store import fail


_PASSTHROUGH = frozenset({
    "scene_context", "production_context", "character_research", "intent_assist",
    "design_advice", "design_review", "production_guide", "branch_create",
})


def mapping_input(core, workflow, node):
    from .adapters import garment_asset, preceding_nodes

    garment_asset(workflow, node)
    previous = preceding_nodes(workflow, node)
    for candidate in reversed(previous):
        if candidate["type"] in _PASSTHROUGH:
            continue
        if candidate["type"] != "flatten_map":
            fail("请先把当前方案映射到真实平铺衣片，再连接模板制作；新生成或修改的图片需要重新映射")
        output = candidate.get("output") or {}
        if candidate.get("status") == "stale":
            fail("上游映射已过期，请打开效果映射，重新确认并保存当前结果", 409)
        if output.get("coordinateSpace") != "flatlay" or not isinstance(output.get("mapping"), dict):
            fail("效果映射还没有保存平铺结果，请完成对应点映射并保存节点")
        return copy.deepcopy(output), candidate
    fail("请先连接效果映射节点，完成真实平铺衣片的痕迹映射")


def inspect_input(core, workflow, node):
    from .making_kit import inspect_making_input

    from .adapters import preceding_nodes
    nearest = next((item for item in reversed(preceding_nodes(workflow, node))
                    if item["type"] == "flatten_map"), None)
    common = {"workflowRevision": workflow["revision"],
              "sourceNodeId": nearest["id"] if nearest else None,
              "sourceNodeLabel": nearest["label"] if nearest else None}
    try:
        source, candidate = mapping_input(core, workflow, node)
        result = inspect_making_input(core, source, node.get("params", {}))
        return {**result, **common, "sourceNodeId": candidate["id"]}
    except HTTPException as error:
        return {**common, "ready": False, "checks": [{"id": "mapping", "label": "展平与映射", "ok": False,
                "message": str(error.detail)}], "issues": [str(error.detail)], "warnings": [], "source": None}


def generate_kit(core, workflow, node):
    from .making_kit import build_making_kit

    source, candidate = mapping_input(core, workflow, node)
    folder = (Path(core.DATA) / "node-studio" / "exports" / workflow["id"] / node["id"]
              / ("kit-" + uuid.uuid4().hex[:12]))
    kit = build_making_kit(core, source, node.get("params", {}), folder, workflow["title"])
    return {**kit, "kind": "making_kit", "sourceNodeId": candidate["id"],
            "imageUrl": kit.get("previewUrl") or source["imageUrl"],
            "sourceImageUrl": source["imageUrl"], "coordinateSpace": "flatlay",
            "semanticAI": False, "apiRequest": False, "physicalSimulation": False,
            "message": "制作包已生成：按衣片、效果和工序查看模板与操作说明"}
