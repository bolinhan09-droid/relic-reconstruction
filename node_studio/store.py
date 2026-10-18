"""Bounded workflow documents, optimistic revisions and atomic local storage.

The visible main line is ordered. Side attachments and candidate references add
dependencies, so cycles are validated even though the UI never draws a tree.
Previous results stay available when upstream content changes.
"""
from __future__ import annotations

import copy
import json
import math
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .catalog import BY_TYPE

MAX_BYTES = 3 * 1024 * 1024
MAX_NODES = 200
_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
_SECRET_KEYS = {"apikey", "api_key", "authorization", "bearertoken", "bearer_token", "experimental_bearer_token", "secret", "password", "accesstoken", "access_token"}
RESEARCH_DRAFT_FIELDS = frozenset({"identification", "imageFingerprint", "sourceImageHash", "sourceImageUrl",
    "identifiedCandidates", "candidates", "autoIdentifyAttemptedFor", "draftCharacter", "sceneCandidates",
    "researchSources", "researchResult", "researchError", "identificationError", "researchStatus", "identificationStatus"})


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def fail(message, status=422):
    raise HTTPException(status, message)


def safe_id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        fail("工作流或节点编号无效")
    return value


def _safe_json(value, depth=0):
    if depth > 40:
        fail("节点记录层级过深")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            fail("节点记录不能包含无穷数或 NaN")
        return
    if isinstance(value, str):
        if len(value) > 250_000:
            fail("单项记录过长，请保存文件引用而不是嵌入文件")
        if value.startswith("data:image/"):
            fail("请先上传图片，工作流只保存本地图片引用")
        if re.search(r"\bsk-[A-Za-z0-9_-]{16,}", value):
            fail("工作流不能保存接口密钥，请在接口设置中连接")
        return
    if isinstance(value, list):
        if len(value) > 30_000:
            fail("节点记录数量超过上限")
        for item in value:
            _safe_json(item, depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 400:
            fail("节点字段过多")
        for key, item in value.items():
            if not isinstance(key, str) or key.lower() in _SECRET_KEYS:
                fail("工作流只接受非密钥的节点设置")
            _safe_json(item, depth + 1)
        return
    fail("节点记录必须是 JSON 数据")


def bounded_copy(value):
    _safe_json(value)
    try:
        # Check the same representation that is persisted so pretty-printing
        # cannot create a file that the next read refuses as oversized.
        raw = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        fail("工作流格式无效")
    if len(raw.encode("utf-8")) > MAX_BYTES:
        fail("工作流记录超过 3 MB，请减少嵌入数据", 413)
    return json.loads(raw)


def validate_workflow(value):
    if not isinstance(value, dict):
        fail("请提交工作流对象")
    result = bounded_copy(value)
    if result.get("schemaVersion", 1) != 1:
        fail("该工作流版本暂不受支持")
    result["schemaVersion"] = 1
    if result.get("id"):
        safe_id(result["id"])
    result["title"] = str(result.get("title") or "未命名创作")[:200]
    nodes = result.get("nodes", [])
    if not isinstance(nodes, list) or len(nodes) > MAX_NODES:
        fail("每份工作流最多 200 个节点")
    by_id = {}
    for node in nodes:
        if not isinstance(node, dict):
            fail("节点必须为对象")
        identifier = safe_id(node.get("id"))
        kind = node.get("type")
        if not isinstance(kind, str) or kind not in BY_TYPE:
            fail("节点类型未登记")
        if identifier in by_id:
            fail("节点编号不能重复")
        if not isinstance(node.get("params", {}), dict):
            fail("节点设置须为对象")
        node.setdefault("params", {})
        node.setdefault("label", BY_TYPE[kind]["label"])
        node["label"] = str(node["label"])[:160]
        node.setdefault("output", None)
        if node["output"] is not None and not isinstance(node["output"], dict):
            fail("节点输出须为对象或空值")
        versions = node.get("versions", [])
        if not isinstance(versions, list) or len(versions) > 30 or any(not isinstance(version, dict) or not isinstance(version.get("output"), dict) for version in versions):
            fail("节点最多保留 30 个有效的历史输出")
        node.setdefault("status", "planned" if BY_TYPE[kind]["capability"] == "planned" else "idle")
        if not isinstance(node["status"], str) or len(node["status"]) > 40:
            fail("节点状态无效")
        attachments = node.setdefault("attachments", {})
        if not isinstance(attachments, dict) or set(attachments) - {"top", "bottom"}:
            fail("附件仅接受上侧与下侧槽位")
        for slot in ("top", "bottom"):
            children = attachments.setdefault(slot, [])
            if not isinstance(children, list) or len(children) > 24 or any(not isinstance(child, str) for child in children):
                fail("每侧最多连接 24 个附件节点")
            if len(set(children)) != len(children):
                fail("同一附件不能重复连接")
        by_id[identifier] = node

    garment_ids = [node["id"] for node in nodes if node["type"] == "garment_input"]
    if len(garment_ids) > 1:
        fail("每份工作流只有一个真实服装输入，参考图请使用图片参考节点")
    order = result.setdefault("order", [])
    stash = result.setdefault("stash", [])
    if not isinstance(order, list) or not isinstance(stash, list):
        fail("主线与方案架须为节点编号列表")
    for identifiers in (order, stash):
        if any(not isinstance(identifier, str) or identifier not in by_id for identifier in identifiers):
            fail("连接引用了不存在的节点")
        if len(set(identifiers)) != len(identifiers):
            fail("主线或方案架中的节点不能重复")
    if set(order).intersection(stash):
        fail("同一节点不能同时位于主线和方案架")
    if order and (not garment_ids or order[0] != garment_ids[0]):
        fail("主线必须从真实服装输入开始")
    if any(BY_TYPE[by_id[identifier]["type"]]["placement"] == "attachment" for identifier in order):
        fail("参考节点请连接到参考槽，不作为真实服装主线")

    occupied = set(order) | set(stash)
    dependencies = {identifier: set() for identifier in by_id}
    for previous, current in zip(order, order[1:]):
        dependencies[current].add(previous)
    for node in nodes:
        for slot, children in node["attachments"].items():
            for child in children:
                if child not in by_id:
                    fail("附件引用了不存在的节点")
                meta = BY_TYPE[by_id[child]["type"]]
                if meta["placement"] not in {"both", "attachment"} or meta["slot"] != slot:
                    fail("该节点与此附件槽类型不匹配")
                if child in occupied:
                    fail("附件节点已在其他位置连接，请先拆下")
                occupied.add(child)
                dependencies[node["id"]].add(child)
        params = node["params"]
        references = []
        if params.get("sourceNodeId"):
            references.append(params["sourceNodeId"])
        if params.get("baseNodeId"):
            references.append(params["baseNodeId"])
        for key in ("candidateIds", "sourceNodeIds"):
            items = params.get(key, [])
            if not isinstance(items, list):
                fail("候选来源须为节点编号列表")
            references.extend(items)
        for identifier in references:
            if not isinstance(identifier, str) or identifier not in by_id:
                fail("候选方案引用了不存在的节点")
            dependencies[node["id"]].add(identifier)

    visited, visiting = set(), set()
    def visit(identifier):
        if identifier in visiting:
            fail("节点依赖不能形成循环，请保存新版本后继续")
        if identifier in visited:
            return
        visiting.add(identifier)
        for parent in dependencies[identifier]:
            visit(parent)
        visiting.remove(identifier)
        visited.add(identifier)
    for identifier in by_id:
        visit(identifier)
    # Detached drafts survive even if an older client forgot to list its stash.
    result["stash"] += [identifier for identifier in by_id if identifier not in occupied]
    selected = result.setdefault("selectedNodeId", order[-1] if order else None)
    if selected is not None and selected not in by_id:
        fail("当前选中的节点不存在")
    if not isinstance(result.setdefault("context", {}), dict):
        fail("项目设定须为对象")
    assets = result.setdefault("assets", [])
    if not isinstance(assets, list) or len(assets) > 100 or any(not isinstance(asset, dict) for asset in assets):
        fail("素材记录须为最多 100 项的对象列表")
    return result


def effective_params(node):
    params = node.get("params", {})
    if node.get("type") == "character_research":
        return {key: value for key, value in params.items() if key not in RESEARCH_DRAFT_FIELDS}
    return params


def _effective_context(workflow):
    return {key: value for key, value in workflow.get("context", {}).items() if key != "researchConsent"}


def _fingerprint(node):
    return {"type": node.get("type"), "params": effective_params(node),
            "attachments": node.get("attachments"), "output": node.get("output")}


def stale_downstream(old, new):
    old_nodes = {node["id"]: node for node in old.get("nodes", [])}
    new_nodes = {node["id"]: node for node in new["nodes"]}
    changed = {identifier for identifier, node in new_nodes.items()
               if identifier not in old_nodes or _fingerprint(node) != _fingerprint(old_nodes[identifier])}
    old_order, order = old.get("order", []), new["order"]
    first_changed = len(order)
    for index, identifier in enumerate(order):
        if index >= len(old_order) or old_order[index] != identifier or identifier in changed:
            first_changed = min(first_changed, index)
        if any(child in changed for children in new_nodes[identifier]["attachments"].values() for child in children):
            first_changed = min(first_changed, index)
        params = new_nodes[identifier]["params"]
        references = [params.get("sourceNodeId"), params.get("baseNodeId"),
                      *params.get("sourceNodeIds", []), *params.get("candidateIds", [])]
        if any(reference in changed for reference in references if reference):
            first_changed = min(first_changed, index)
    context_changed = _effective_context(old) != _effective_context(new)
    if context_changed:
        first_changed = min(first_changed, 0)
    for index, identifier in enumerate(order):
        node = new_nodes[identifier]
        if index < first_changed or identifier not in old_nodes or not node.get("output"):
            continue
        prior = old_nodes[identifier]
        # A node whose newly committed result changed is current; downstream
        # results remain visible but are labelled as based on older inputs.
        own_output_changed = node.get("output") != prior.get("output")
        if own_output_changed:
            continue
        own_params_changed = effective_params(node) != effective_params(prior)
        own_dependencies_changed = any(child in changed for children in node["attachments"].values() for child in children)
        params = node["params"]
        own_dependencies_changed = own_dependencies_changed or any(reference in changed for reference in
            [params.get("sourceNodeId"), params.get("baseNodeId"), *params.get("sourceNodeIds", []), *params.get("candidateIds", [])] if reference)
        if index > first_changed or own_params_changed or own_dependencies_changed or old_order != order or context_changed:
            node["status"] = "stale"
            node["staleReason"] = "上游方案、设定或顺序已经更新；旧结果已保留，请确认后重新运行。"
    return new


class WorkflowStore:
    def __init__(self, data_root):
        self.root = Path(data_root) / "node-studio" / "workflows"
        self.lock = threading.RLock()

    def _folder(self, identifier):
        return self.root / safe_id(identifier)

    def _read(self, path):
        try:
            if not path.is_file():
                return None
            if path.stat().st_size > MAX_BYTES:
                fail("本地工作流记录超过大小上限", 500)
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            fail("本地工作流读取失败，原文件已保留", 500)

    def _write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("w", encoding="utf-8") as stream:
                json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        except OSError:
            fail("工作流保存失败，请检查磁盘空间；原有版本未被删除", 500)
        finally:
            if temporary.exists():
                temporary.unlink(missing_ok=True)

    def get(self, identifier):
        with self.lock:
            value = self._read(self._folder(identifier) / "workflow.json")
            if value is None:
                fail("工作流不存在", 404)
            return value

    def list(self):
        with self.lock:
            rows = []
            for path in self.root.glob("*/workflow.json"):
                value = self._read(path)
                if value:
                    rows.append({"id": value["id"], "title": value["title"], "revision": value["revision"],
                                 "updatedAt": value["updatedAt"], "createdAt": value["createdAt"],
                                 "nodeCount": len(value["nodes"]), "selectedNodeId": value.get("selectedNodeId"),
                                 "thumbnailUrl": next(((node.get("output") or {}).get("imageUrl")
                                                       for node in value["nodes"] if (node.get("output") or {}).get("imageUrl")), None)})
            return sorted(rows, key=lambda value: value["updatedAt"], reverse=True)

    def create(self, workflow):
        with self.lock:
            value = validate_workflow(workflow)
            identifier = "flow-" + uuid.uuid4().hex[:16]
            stamp = now()
            value.update(id=identifier, revision=1, createdAt=stamp, updatedAt=stamp)
            self._persist(value)
            return copy.deepcopy(value)

    def save(self, identifier, workflow, expected_revision):
        with self.lock:
            old = self.get(identifier)
            if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or expected_revision != old["revision"]:
                fail("工作流已更新，请重新载入后保存；没有覆盖已有修改", 409)
            value = validate_workflow(workflow)
            if value.get("id") not in (None, identifier):
                fail("保存目标与工作流编号不一致")
            value = stale_downstream(old, value)
            value.update(id=identifier, revision=old["revision"] + 1,
                         createdAt=old["createdAt"], updatedAt=now())
            self._persist(value)
            return copy.deepcopy(value)

    def _persist(self, value):
        folder = self._folder(value["id"])
        self._write(folder / "history" / f"revision-{value['revision']:06d}.json", value)
        self._write(folder / "workflow.json", value)

    def history(self, identifier):
        self.get(identifier)
        return [{"revision": int(path.stem.split("-")[-1]), "url":
                 f"/data/node-studio/workflows/{identifier}/history/{path.name}"}
                for path in sorted((self._folder(identifier) / "history").glob("revision-*.json"))]
