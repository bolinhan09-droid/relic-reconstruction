"""Branch-aware scope and dependencies, shared by validation and execution.

The original order is still the main lane. A fork and its adjacent merge delimit
independent branch orders. Merge outputs carry references, never raster blends.
"""
from __future__ import annotations

import copy


def lanes(workflow):
    return [{"id": "main", "label": "主线", "order": workflow.get("order", [])},
            *workflow.get("routes", []), *workflow.get("branches", [])]


def lane_for(workflow, identifier):
    return next((lane for lane in lanes(workflow) if identifier in lane["order"]), None)


def host_for(workflow, identifier):
    return next((node for node in workflow["nodes"]
                 if any(identifier in ids for ids in node.get("attachments", {}).values())), None)


def root_lane_for(workflow, identifier):
    """An independent canvas route never inherits the original main input."""
    host = host_for(workflow, identifier)
    lane = lane_for(workflow, host["id"] if host else identifier)
    seen = set()
    while lane and lane.get("forkId") and lane["id"] not in seen:
        seen.add(lane["id"])
        lane = lane_for(workflow, lane["forkId"])
    return lane


def scoped_ids(workflow, identifier):
    """Inputs that may be explicitly referenced, excluding unrelated routes."""
    result = set(preceding_ids(workflow, identifier))
    host = host_for(workflow, identifier)
    if host:
        result.add(host["id"])
    return result


def branches_for(workflow, fork_id):
    return [lane for lane in workflow.get("branches", []) if lane.get("forkId") == fork_id]


def preceding_ids(workflow, identifier, seen=None):
    seen = set() if seen is None else seen
    if identifier in seen:
        return []
    seen.add(identifier)
    lane = lane_for(workflow, identifier)
    if lane is None:
        host = host_for(workflow, identifier)
        return preceding_ids(workflow, host["id"], seen) if host else []
    inherited = preceding_ids(workflow, lane["forkId"], seen) + [lane["forkId"]] if lane.get("forkId") else []
    return inherited + lane["order"][:lane["order"].index(identifier)]


def merge_for(workflow, node):
    by_id = {entry["id"]: entry for entry in workflow["nodes"]}
    node = by_id.get(node) if isinstance(node, str) else node
    if not node:
        return None
    if node["type"] == "branch_merge":
        return node
    if node["type"] == "branch_create":
        return next((entry for entry in workflow["nodes"] if entry["type"] == "branch_merge" and entry.get("params", {}).get("forkId") == node["id"]), None)
    for identifier in reversed(preceding_ids(workflow, node["id"])):
        previous = by_id[identifier]
        if previous["type"] == "branch_merge":
            return previous
        if (previous.get("output") or {}).get("imageUrl") and previous["type"] != "branch_create":
            break
    return None


def merge_candidates(workflow, node, *, all_candidates=False):
    merge = merge_for(workflow, node)
    if not merge:
        return []
    by_id = {entry["id"]: entry for entry in workflow["nodes"]}

    def collect(fork_id, seen):
        if fork_id in seen:
            return []
        result = []
        for branch in branches_for(workflow, fork_id):
            for identifier in reversed(branch["order"]):
                entry = by_id[identifier]
                if entry["type"] == "branch_merge":
                    nested = collect(entry["params"].get("forkId"), seen | {fork_id})
                    selection = entry["params"].get("selectedCandidateIds")
                    if isinstance(selection, list) and selection:
                        nested = [candidate for candidate in nested if candidate["nodeId"] in selection]
                    result.extend(nested)
                    break
                output = entry.get("output") or {}
                if output.get("imageUrl"):
                    result.append({"id": identifier, "nodeId": identifier, "branchId": branch["id"],
                        "branchLabel": branch["label"], "label": branch["label"] or entry.get("label"),
                        "imageUrl": output["imageUrl"], "output": copy.deepcopy(output), "status": entry.get("status")})
                    break
        return result

    result = collect(merge["params"].get("forkId"), set())
    selection = merge["params"].get("selectedCandidateIds")
    if not all_candidates and isinstance(selection, list) and selection:
        result = [candidate for candidate in result if candidate["nodeId"] in selection]
    return result


def dependency_map(workflow):
    dependencies = {node["id"]: set() for node in workflow["nodes"]}
    for lane in lanes(workflow):
        previous = lane.get("forkId")
        for identifier in lane["order"]:
            if previous:
                dependencies[identifier].add(previous)
            previous = identifier
    for node in workflow["nodes"]:
        parents, params = dependencies[node["id"]], node.get("params", {})
        for children in node.get("attachments", {}).values():
            parents.update(children)
        parents.update(identifier for identifier in [params.get("sourceNodeId"), params.get("baseNodeId"),
            *params.get("sourceNodeIds", []), *params.get("candidateIds", [])] if identifier)
        if node["type"] == "branch_merge":
            for branch in branches_for(workflow, params.get("forkId")):
                parents.add(branch["order"][-1] if branch["order"] else params.get("forkId"))
    return dependencies


def validate_structure(workflow, by_id):
    """Called after node IDs, lane arrays and attachment ownership are checked."""
    for node in workflow["nodes"]:
        if node["type"] not in {"branch_create", "branch_merge"}:
            continue
        lane = lane_for(workflow, node["id"])
        if not lane:
            raise ValueError("分支与合拢必须保留在路线中，不能单独放入方案架")
        fork = node if node["type"] == "branch_create" else by_id.get(node["params"].get("forkId"))
        fork_lane = lane_for(workflow, fork["id"]) if fork else None
        if not fork or fork["type"] != "branch_create" or not fork_lane or fork_lane["id"] != lane["id"]:
            raise ValueError("分支与合拢必须属于同一条父路线")
        merges = [entry for entry in workflow["nodes"] if entry["type"] == "branch_merge" and entry["params"].get("forkId") == fork["id"]]
        if len(merges) != 1 or merges[0]["id"] not in lane["order"] or lane["order"].index(merges[0]["id"]) != lane["order"].index(fork["id"]) + 1:
            raise ValueError("分支与合拢应相邻，创作节点请放入其中的探索路线")
        if not 2 <= len(branches_for(workflow, fork["id"])) <= 12:
            raise ValueError("每个分叉需要 2–12 条探索路线")
        selected = node["params"].get("selectedCandidateIds", [])
        if not isinstance(selected, list) or any(not isinstance(identifier, str) or identifier not in by_id for identifier in selected) or len(selected) != len(set(selected)):
            raise ValueError("合拢候选须为不同的有效节点编号")
    # Saved outputs keep their historical provenance; only live input params
    # form dependencies. An explicit cross-route reference must use a merge.
    for node in workflow["nodes"]:
        params = node.get("params", {})
        allowed = scoped_ids(workflow, node["id"])
        if node["type"] == "blend_create":
            merge = merge_for(workflow, node)
            if merge:
                allowed.update(candidate["nodeId"] for candidate in merge_candidates(workflow, merge, all_candidates=True))
            else:
                allowed.update(workflow.get("stash", []))
        for key in ("sourceNodeId", "baseNodeId", "targetNodeId"):
            identifier = params.get(key)
            if identifier and identifier not in allowed:
                raise ValueError("节点来源必须位于当前路线的上游；其他方案请通过合拢连接")
        for key in ("sourceNodeIds", "candidateIds"):
            if any(identifier not in allowed for identifier in params.get(key, [])):
                raise ValueError("候选来源不属于当前路线；其他方案请通过合拢连接")
