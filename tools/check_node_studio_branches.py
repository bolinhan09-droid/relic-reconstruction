"""Branch persistence and execution tests with synthetic local images; no models."""
from __future__ import annotations

import copy
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from PIL import Image
from node_studio.adapters import current_base, context_for, run_node
from node_studio.graph import merge_candidates, preceding_ids
from node_studio.store import WorkflowStore, validate_workflow


def node(identifier, kind, params=None, image=None):
    return {"id": identifier, "type": kind, "params": params or {}, "attachments": {"top": [], "bottom": []},
            "status": "completed", "output": {"kind": "garment", "imageUrl": image} if image else None}


def reject(callback):
    try:
        callback()
    except HTTPException as exc:
        assert exc.status_code == 422, exc.detail
        return
    raise AssertionError("Invalid branch operation was accepted")


def main():
    checks = []
    scratch_parent = Path(__file__).resolve().parents[1] / "work" / "branch-core-checks"
    scratch_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="relic-branch-test-", dir=scratch_parent) as temporary:
        root = Path(temporary)
        assert root.resolve().is_relative_to(scratch_parent.resolve())
        core = SimpleNamespace(DATA=root, RESOURCES=root / "resources", require_local_origin=lambda request: None)
        urls = {}
        for name, color in {"input": "gray", "a": "red", "a2": "orange", "b": "blue", "b2": "navy", "c": "green", "d": "purple"}.items():
            folder = root / "uploads" / name
            folder.mkdir(parents=True)
            Image.new("RGB", (24, 32), color).save(folder / "image.png")
            urls[name] = f"/data/uploads/{name}/image.png"
        workflow = {"schemaVersion": 1, "title": "Branch regression", "nodes": [
            node("input", "garment_input", {"front": {"url": urls["input"]}}, urls["input"]),
            node("fork", "branch_create"), node("merge", "branch_merge", {"forkId": "fork"}),
            node("a", "precision_edit", image=urls["a"]), node("a2", "precision_edit", image=urls["a2"]),
            node("b", "precision_edit", image=urls["b"]), node("b2", "precision_edit", image=urls["b2"]),
            node("blend", "blend_create"), node("sceneA", "scene_context", {"scene": "Route A only"}),
        ], "order": ["input", "fork", "merge", "blend"], "stash": [], "branches": [
            {"id": "lane-a", "forkId": "fork", "label": "方案 A", "order": ["a", "a2"]},
            {"id": "lane-b", "forkId": "fork", "label": "方案 B", "order": ["b", "b2"]}], "context": {}, "assets": []}
        workflow["nodes"][3]["attachments"]["top"] = ["sceneA"]
        workflow = validate_workflow(workflow)
        by_id = {entry["id"]: entry for entry in workflow["nodes"]}
        assert current_base(core, workflow, by_id["b"])["imageUrl"] == urls["input"]
        assert current_base(core, workflow, by_id["b2"])["imageUrl"] == urls["b"]
        assert context_for(workflow, by_id["a2"])["scene"]["scene"] == "Route A only"
        assert not context_for(workflow, by_id["b2"])["scene"]
        checks.append("backend image and context scopes inherit only the current route and its ancestors")

        merged = run_node(core, workflow, by_id["merge"], {}, None)
        assert merged["kind"] == "candidate_set" and "imageUrl" not in merged and merged["apiRequest"] is False
        assert merged["candidateIds"] == ["a2", "b2"]
        assert merged["baseImageUrl"] == urls["input"]
        blend = run_node(core, workflow, by_id["blend"], {}, None)
        assert blend["task"]["candidateIds"] == ["a2", "b2"]
        assert blend["task"]["candidateImages"] == [urls["a2"], urls["b2"]]
        assert blend["task"]["weights"] == [.5, .5]
        assert by_id["blend"]["params"]["candidateIds"] == ["a2", "b2"]
        checks.append("merge creates a candidate set; blend automatically prepares both real references without calling a model")

        bad = copy.deepcopy(workflow)
        bad_blend = next(entry for entry in bad["nodes"] if entry["id"] == "blend")
        bad_blend["params"].update(candidateIds=["a2", "input"], weights=[.5, .5])
        reject(lambda: run_node(core, bad, bad_blend, {}, None))
        checks.append("explicit foreign candidates cannot escape the connected merge scope")
        direct = copy.deepcopy(workflow)
        image = node("image", "image_generate", {"provider": "openai", "intent": "test"})
        direct["nodes"].append(image)
        direct["order"] = ["input", "fork", "merge", "image", "blend"]
        reject(lambda: run_node(core, direct, image, {"confirmedExternal": True}, None))
        checks.append("a raw candidate set cannot silently trigger an older image-generation task")

        store = WorkflowStore(root)
        saved = store.create(workflow)
        assert store.get(saved["id"])["branches"] == workflow["branches"]
        first = copy.deepcopy(saved)
        for entry in first["nodes"]:
            if entry["id"] == "merge": entry["output"] = merged
            if entry["id"] == "blend": entry["output"] = blend
        saved = store.save(saved["id"], first, saved["revision"])
        changed = copy.deepcopy(saved)
        next(entry for entry in changed["nodes"] if entry["id"] == "a2")["params"]["color"] = "dark red"
        saved = store.save(saved["id"], changed, saved["revision"])
        statuses = {entry["id"]: entry["status"] for entry in saved["nodes"]}
        assert statuses["a2"] == statuses["merge"] == statuses["blend"] == "stale"
        assert statuses["b"] == statuses["b2"] == "completed"
        assert next(entry for entry in saved["nodes"] if entry["id"] == "a2")["output"]["imageUrl"] == urls["a2"]
        checks.append("atomic save/read retains branch data and old images while invalidating only dependent descendants")

        old = {"schemaVersion": 1, "nodes": [node("input", "garment_input", {"front": {"url": urls["input"]}})], "order": ["input"]}
        restored = store.create(old)
        assert restored["branches"] == [] and store.get(restored["id"])["order"] == ["input"]
        checks.append("older linear workflows remain readable and writable without a migration")

        many = copy.deepcopy(workflow)
        many["nodes"] += [node("c", "precision_edit", image=urls["c"]), node("d", "precision_edit", image=urls["d"])]
        many["branches"] += [{"id": "lane-c", "forkId": "fork", "label": "C", "order": ["c"]}, {"id": "lane-d", "forkId": "fork", "label": "D", "order": ["d"]}]
        many_blend = next(entry for entry in many["nodes"] if entry["id"] == "blend")
        many_blend["params"] = {}
        reject(lambda: run_node(core, many, many_blend, {}, None))
        next(entry for entry in many["nodes"] if entry["id"] == "merge")["params"]["selectedCandidateIds"] = ["b2", "d"]
        selected = run_node(core, many, many_blend, {}, None)
        assert selected["task"]["candidateIds"] == ["b2", "d"]
        checks.append("more than three candidates require a choice; the merge choice is inherited by blend")

        nested = copy.deepcopy(workflow)
        nested["nodes"] += [node("fork2", "branch_create"), node("merge2", "branch_merge", {"forkId": "fork2"}), node("c", "precision_edit", image=urls["c"])]
        nested["branches"][1]["order"] = ["b", "fork2", "merge2"]
        nested["branches"] += [{"id": "nested-a", "forkId": "fork2", "label": "B.1", "order": ["b2"]}, {"id": "nested-b", "forkId": "fork2", "label": "B.2", "order": ["c"]}]
        nested = validate_workflow(nested)
        assert preceding_ids(nested, "c") == ["input", "fork", "b", "fork2"]
        assert [candidate["nodeId"] for candidate in merge_candidates(nested, "merge")] == ["a2", "b2", "c"]
        assert current_base(core, nested, next(entry for entry in nested["nodes"] if entry["id"] == "c"))["imageUrl"] == urls["b"]
        checks.append("nested route scopes and nested merged results resolve recursively")

        duplicate = copy.deepcopy(workflow); duplicate["branches"][1]["order"].append("a2")
        reject(lambda: validate_workflow(duplicate))
        cycle = copy.deepcopy(workflow); next(entry for entry in cycle["nodes"] if entry["id"] == "a")["params"]["sourceNodeId"] = "blend"
        reject(lambda: validate_workflow(cycle))
        invalid = copy.deepcopy(workflow); next(entry for entry in invalid["nodes"] if entry["id"] == "merge")["params"]["forkId"] = "b"
        reject(lambda: validate_workflow(invalid))
        separated = copy.deepcopy(workflow); separated["order"] = ["input", "fork", "blend", "merge"]
        reject(lambda: validate_workflow(separated))
        orphan = copy.deepcopy(workflow); orphan["order"].remove("fork"); orphan["stash"] = ["fork"]
        reject(lambda: validate_workflow(orphan))
        checks.append("duplicate ownership, candidate cycles, invalid merge targets and broken group structures are rejected")
    print(json.dumps({"passed": len(checks), "checks": checks, "paidCalls": 0, "userImagesUsed": False}, indent=2))


if __name__ == "__main__":
    main()
