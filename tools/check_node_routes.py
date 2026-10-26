"""Independent-root persistence and source isolation with synthetic images."""
from __future__ import annotations
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from PIL import Image
from node_studio.adapters import current_base, garment_asset, run_node
from node_studio.assistant_engine import _snapshot
from node_studio.graph import preceding_ids
from node_studio.store import WorkflowStore, validate_workflow


def node(identifier, kind, params=None, output=None):
    return {"id": identifier, "type": kind, "params": params or {}, "output": output,
            "status": "succeeded" if output else "draft", "attachments": {"top": [], "bottom": []}}


class RouteTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[1] / "work" / "route-checks"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="v011-", dir=parent)
        self.root = Path(self.temp.name)
        self.core = SimpleNamespace(DATA=self.root, RESOURCES=self.root / "resources")
        self.urls = {}
        for name, color in [("main", "gray"), ("other", "blue"), ("ref0", "red"), ("ref1", "green"), ("saved", "purple")]:
            folder = self.root / name
            folder.mkdir()
            Image.new("RGB", (20, 30), color).save(folder / "image.png")
            self.urls[name] = f"/data/{name}/image.png"
        self.workflow = validate_workflow({"id": "test-routes", "revision": 1, "nodes": [
            node("input", "garment_input", {"front": {"url": self.urls["main"]}}),
            node("main-edit", "precision_edit", output={"imageUrl": self.urls["main"]}),
            node("reference", "image_reference", {"references": [{"url": self.urls["ref0"]}, {"url": self.urls["ref1"]}], "activeReferenceIndex": 1}),
            node("ref-edit", "precision_edit"),
            node("other", "garment_input", {"front": {"url": self.urls["other"]}}),
            node("other-edit", "precision_edit", output={"imageUrl": self.urls["other"]}),
            node("saved", "precision_edit", output={"imageUrl": self.urls["saved"]}),
            node("draft", "quick_create"),
        ], "order": ["input", "main-edit"], "routes": [
            {"id": "ref-route", "label": "参考", "order": ["reference", "ref-edit"], "x": 140, "y": 500},
            {"id": "other-route", "order": ["other", "other-edit"], "x": -120, "y": 900},
            {"id": "saved-route", "order": ["saved"], "x": 700, "y": 30},
            {"id": "draft-route", "order": ["draft"], "x": 0, "y": 1200},
        ]})

    def tearDown(self):
        self.temp.cleanup()

    def get(self, identifier):
        return next(item for item in self.workflow["nodes"] if item["id"] == identifier)

    def test_reference_and_garment_roots_are_isolated(self):
        reference = current_base(self.core, self.workflow, self.get("ref-edit"))
        self.assertEqual(reference["imageUrl"], self.urls["ref1"])
        self.assertEqual(reference["sourceRole"], "reference")
        self.assertNotIn("garmentSource", reference)
        self.assertEqual(current_base(self.core, self.workflow, self.get("other-edit"))["imageUrl"], self.urls["other"])
        self.assertEqual(garment_asset(self.workflow, self.get("other-edit"))["url"], self.urls["other"])
        with self.assertRaises(HTTPException):
            garment_asset(self.workflow, self.get("ref-edit"))

    def test_root_input_exec_uses_own_photo(self):
        actual = run_node(self.core, self.workflow, self.get("other"), {}, None)
        self.assertEqual(actual["imageUrl"], self.urls["other"])
        actual = run_node(self.core, self.workflow, self.get("reference"), {}, None)
        self.assertEqual(actual["imageUrl"], self.urls["ref1"])
        self.assertEqual(actual["sourceRole"], "reference")

    def test_adopted_input_result_remains_bound_to_selected_source(self):
        self.get("other")["output"] = {"imageUrl": self.urls["saved"], "originalImageUrl": self.urls["other"], "projectId": "edited-root"}
        self.assertEqual(current_base(self.core, self.workflow, self.get("other-edit"))["imageUrl"], self.urls["saved"])
        self.get("other")["params"]["front"] = {"url": self.urls["main"]}
        self.assertEqual(current_base(self.core, self.workflow, self.get("other-edit"))["imageUrl"], self.urls["main"])

    def test_empty_reference_clears_output_and_blocks_fallback(self):
        self.get("reference")["params"]["references"] = []
        result = run_node(self.core, self.workflow, self.get("reference"), {}, None)
        self.assertNotIn("imageUrl", result)
        with self.assertRaises(HTTPException):
            current_base(self.core, self.workflow, self.get("ref-edit"))

    def test_detached_result_reopens_but_empty_draft_does_not_borrow(self):
        actual = current_base(self.core, self.workflow, self.get("saved"))
        self.assertEqual(actual["imageUrl"], self.urls["saved"])
        self.assertEqual(actual["sourceRole"], "detached")
        with self.assertRaises(HTTPException):
            current_base(self.core, self.workflow, self.get("draft"))

    def test_coordinate_reload_and_update_isolation(self):
        store = WorkflowStore(self.root)
        saved = store.create(self.workflow)
        self.assertEqual(store.get(saved["id"])["routes"], self.workflow["routes"])
        candidate = copy.deepcopy(saved)
        candidate["routes"][0]["x"] = 987.5
        moved = store.save(saved["id"], candidate, saved["revision"])
        self.assertEqual(next(item for item in moved["nodes"] if item["id"] == "other-edit")["status"], "succeeded")
        candidate = copy.deepcopy(moved)
        next(item for item in candidate["nodes"] if item["id"] == "input")["params"]["front"]["url"] = self.urls["saved"]
        edited = store.save(saved["id"], candidate, moved["revision"])
        self.assertEqual(next(item for item in edited["nodes"] if item["id"] == "main-edit")["status"], "stale")
        self.assertEqual(next(item for item in edited["nodes"] if item["id"] == "other-edit")["status"], "succeeded")

    def test_no_production_from_reference_only_route(self):
        for kind in ("production_guide", "flatten_map", "stencil_export"):
            self.get("ref-edit")["type"] = kind
            with self.assertRaises(HTTPException):
                run_node(self.core, self.workflow, self.get("ref-edit"), {}, None)

    def test_side_assistant_uses_reference_host_not_main(self):
        assistant = node("assist", "agent_execute")
        self.workflow["nodes"].append(assistant)
        self.get("reference")["attachments"]["bottom"] = ["assist"]
        self.workflow = validate_workflow(self.workflow)
        snapshot = _snapshot(self.core, self.workflow, self.get("assist"))
        self.assertEqual(snapshot["target"]["id"], "reference")
        self.assertEqual(snapshot["sourceUrl"], self.urls["ref1"])
        self.assertEqual(snapshot["originalUrl"], self.urls["ref1"])

    def test_branch_on_reference_root_inherits_only_reference(self):
        self.workflow["nodes"] += [node("fork", "branch_create"), node("merge", "branch_merge", {"forkId": "fork"}),
                                    node("a", "precision_edit"), node("b", "precision_edit")]
        self.workflow["routes"][0]["order"] = ["reference", "ref-edit", "fork", "merge"]
        self.workflow["branches"] = [{"id": "a-route", "forkId": "fork", "order": ["a"]},
                                     {"id": "b-route", "forkId": "fork", "order": ["b"]}]
        checked = validate_workflow(self.workflow)
        self.assertEqual(preceding_ids(checked, "b"), ["reference", "ref-edit", "fork"])
        self.assertEqual(current_base(self.core, checked, self.get("b"))["imageUrl"], self.urls["ref1"])

    def test_reject_invalid_graphs(self):
        variants = []
        duplicate = copy.deepcopy(self.workflow); duplicate["routes"][0]["order"].append("main-edit"); variants.append(duplicate)
        unknown = copy.deepcopy(self.workflow); unknown["routes"][0]["order"].append("missing"); variants.append(unknown)
        bad_id = copy.deepcopy(self.workflow); bad_id["routes"][0]["id"] = "../escape"; variants.append(bad_id)
        nonfinite = copy.deepcopy(self.workflow); nonfinite["routes"][0]["x"] = float("nan"); variants.append(nonfinite)
        cross = copy.deepcopy(self.workflow); cross["nodes"][-1]["params"]["sourceNodeId"] = "input"; variants.append(cross)
        self_reference = copy.deepcopy(self.workflow); self_reference["nodes"][-1]["params"]["sourceNodeId"] = "draft"; variants.append(self_reference)
        for variant in variants:
            with self.assertRaises(HTTPException):
                validate_workflow(variant)


if __name__ == "__main__":
    unittest.main(verbosity=2)
