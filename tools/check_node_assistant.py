"""Offline end-to-end assistant checks: fake model transport, temporary data."""
from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from PIL import Image, ImageChops
from starlette.requests import Request

import brush_workflow as brush
import co_design
from node_studio import assistant_engine as engine
from node_studio.store import validate_workflow


def request():
    return Request({"type": "http", "method": "POST", "path": "/api/node-studio/test", "scheme": "http", "query_string": b"",
                    "headers": [(b"host", b"127.0.0.1:7870"), (b"origin", b"http://127.0.0.1:7870"), (b"content-type", b"application/json")],
                    "server": ("127.0.0.1", 7870), "client": ("127.0.0.1", 12345)})


class AssistantTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="assistant-check-", dir=Path.cwd())
        self.root = Path(self.scratch.name); data = self.root / "data"; resources = self.root / "resources"
        resources.mkdir(); source = data / "uploads" / "upload-source" / "image.png"; source.parent.mkdir(parents=True)
        Image.new("RGB", (160, 200), (184, 193, 201)).save(source)
        self.source = source; self.source_bytes = source.read_bytes(); self.calls = []
        stroke = {"id": "stroke-1", "type": "blood", "size": .05, "opacity": .8, "seed": 42,
                  "points": [{"x": .4, "y": .4}], "color": "#7d302e",
                  "shapes": [{"kind": "ellipse", "cx": .4, "cy": .4, "rx": .15, "ry": .1, "color": "#7d302e", "alpha": .8}]}
        asset = {"id": "upload-source", "url": "/data/uploads/upload-source/image.png", "width": 160, "height": 200}
        project = {"id": "project-source", "revision": 1, "title": "Test", "reference": asset,
                   "brushStrokes": [stroke], "damageItems": [], "protectedRects": [{"id": "protect-1", "rect": {"x": .35, "y": .35, "w": .05, "h": .1}}]}
        self.projects = {project["id"]: copy.deepcopy(project)}
        def write_json(path, value):
            path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        def create_project(value):
            clean = copy.deepcopy(value); clean["brushStrokes"] = brush.validate_brush_strokes(clean.get("brushStrokes", []))
            clean.update(id="project-" + uuid.uuid4().hex[:16], revision=1)
            self.projects[clean["id"]] = copy.deepcopy(clean)
            return clean
        self.core = SimpleNamespace(DATA=data, RESOURCES=resources, write_json=write_json,
                    get_project=lambda identifier: copy.deepcopy(self.projects[identifier]), create_project=create_project,
                    data_url=lambda path: "/data/" + path.relative_to(data).as_posix(),
                    require_local_origin=lambda value: None, node_assistant_tools={})
        output = {"kind": "garment", "imageUrl": asset["url"], "projectId": project["id"], "reference": asset,
                  "projectSnapshot": copy.deepcopy(project), "brushStrokes": [stroke], "protectedRects": project["protectedRects"],
                  "imageSemantics": "editable_preview", "editableStrokes": True}
        self.node = {"id": "assistant-1", "type": "agent_execute", "params": {"intent": "降低这笔血迹并在下摆添加磨损", "regions": [{"id": "hem", "rect": {"x": .2, "y": .7, "w": .5, "h": .2}}]},
                     "attachments": {"top": [], "bottom": []}, "output": None}
        self.workflow = validate_workflow({"id": "workflow-test", "revision": 1, "title": "Test", "nodes": [
            {"id": "garment-1", "type": "garment_input", "params": {"front": asset}, "attachments": {"top": [], "bottom": []}, "output": {"imageUrl": asset["url"]}},
            {"id": "target-1", "type": "precision_edit", "params": {}, "attachments": {"top": [], "bottom": [self.node["id"]]}, "output": output}, self.node],
            "order": ["garment-1", "target-1"]})
        self.node = next(item for item in self.workflow["nodes"] if item["id"] == "assistant-1")
        self.original_workflow = copy.deepcopy(self.workflow)
        self.saved_settings, self.saved_active = copy.deepcopy(co_design._SETTINGS), co_design._ACTIVE
        co_design._ACTIVE = "local_openai"
        co_design._SETTINGS["local_openai"] = {"baseUrl": "http://127.0.0.1:11434/v1", "model": "test-local", "apiKey": "", "vision": True}
        self.answer = {"message": "在独立候选里减淡指定笔触，并加少量下摆磨损。", "questions": [], "toolCalls": [
            {"name": "adjust_strokes", "arguments": {"strokeIds": ["stroke-1"], "opacityScale": .5}},
            {"name": "add_stroke", "arguments": {"type": "wear", "regionId": "hem", "color": "#938a77", "opacity": .5, "pattern": "wear"}},
            {"name": "create_node", "arguments": {"type": "production_guide", "intent": "整理小样步骤"}}]}
        self.raw_response = None
        def transport(method, url, **kwargs):
            self.calls.append({"method": method, "url": url, **kwargs})
            response = self.raw_response or {"choices": [{"message": {"content": json.dumps(self.answer, ensure_ascii=False)}}]}
            return json.dumps(response).encode(), {}
        self.transport = patch.object(co_design, "_request", transport); self.transport.start()

    def tearDown(self):
        self.transport.stop(); co_design._SETTINGS = self.saved_settings; co_design._ACTIVE = self.saved_active
        self.scratch.cleanup()

    def run_engine(self, payload=None, workflow=None):
        workflow = workflow or self.workflow
        node = next(item for item in workflow["nodes"] if item["id"] == self.node["id"])
        return engine.run_assistant(self.core, workflow, node, payload or {}, request())

    def assert_rejected(self, status, callback):
        with self.assertRaises(HTTPException) as caught:
            callback()
        self.assertEqual(status, caught.exception.status_code, caught.exception.detail)

    def preview_adopt(self):
        preview = self.run_engine()
        adoption = self.run_engine({"assistantAction": "adopt", "runId": preview["runId"]})
        adopted = engine.apply_workflow_patch(self.workflow, adoption["workflowPatch"])
        return preview, adopted

    def test_preview_adopt_restore_complete_loop(self):
        preview, adopted = self.preview_adopt()
        self.assertEqual(preview["kind"], "assistant_candidate")
        self.assertTrue(preview["validation"]["passed"])
        self.assertTrue(preview["validation"]["pixelChange"])
        self.assertEqual(self.workflow, self.original_workflow)
        self.assertEqual(self.source.read_bytes(), self.source_bytes)
        target = next(item for item in adopted["nodes"] if item["id"] == "target-1")
        self.assertEqual(target["output"]["brushStrokes"][0]["opacity"], .4)
        self.assertEqual(len(target["output"]["brushStrokes"]), 2)
        self.assertEqual(target["output"]["brushStrokes"][0]["shapes"][0]["alpha"], .4)
        self.assertNotEqual(target["output"]["projectId"], "project-source")
        self.assertEqual(len(target["versions"]), 1)
        self.assertEqual(len(adopted["nodes"]), 4)
        before = Image.open(self.core.DATA / preview["beforeImageUrl"].removeprefix("/data/"))
        candidate = Image.open(self.core.DATA / preview["candidateImageUrl"].removeprefix("/data/"))
        self.assertIsNone(ImageChops.difference(before.crop((56, 70, 64, 90)), candidate.crop((56, 70, 64, 90))).getbbox())
        restored = self.run_engine({"assistantAction": "restore", "runId": preview["runId"]}, adopted)
        result = engine.apply_workflow_patch(adopted, restored["workflowPatch"])
        original_target = next(item for item in self.workflow["nodes"] if item["id"] == "target-1")
        restored_target = next(item for item in result["nodes"] if item["id"] == "target-1")
        self.assertEqual(restored_target["output"], original_target["output"])
        self.assertEqual(restored_target["params"], original_target["params"])
        self.assertEqual(len(result["nodes"]), 3)
        self.assertEqual(len(self.calls), 1)

    def test_real_analysis_routes_and_two_image_review(self):
        for kind, key, value in [("intent_assist", "items", [{"label": "目标", "value": "减淡血迹"}]),
                                 ("design_advice", "suggestions", [{"title": "控制下摆密度", "detail": "沿边缘减少重复飞溅"}]),
                                 ("design_review", "checks", [{"label": "徽记保留", "status": "unknown", "detail": "需放大确认"}])]:
            self.node["type"] = kind; self.answer = {"message": "根据当前方案分析。", key: value}
            result = self.run_engine()
            self.assertTrue(result["semanticAI"]); self.assertEqual(result["mode"], "local_model")
            self.assertTrue(result[key]); self.assertEqual(result["visualInspection"], kind == "design_review")
            images = [item for item in self.calls[-1]["payload"]["messages"][-1]["content"] if item["type"] == "image_url"]
            self.assertEqual(len(images), 2)

    def test_unconfigured_and_text_only_review_are_honest(self):
        co_design._SETTINGS["local_openai"]["model"] = ""
        result = self.run_engine(); self.assertEqual(result["mode"], "unconfigured"); self.assertFalse(result["semanticAI"])
        co_design._SETTINGS["local_openai"].update(model="test-local", vision=False)
        self.node["type"] = "design_review"
        result = self.run_engine(); self.assertEqual(result["mode"], "needs_vision"); self.assertFalse(result["visualInspection"])
        self.assertFalse(self.calls)

    def test_plan_executes_once_and_binds_source_and_target(self):
        plan = self.run_engine({"assistantAction": "plan"})
        self.assertFalse(plan["candidateImageUrl"])
        self.assertEqual(len(self.projects), 1)
        preview = self.run_engine({"assistantAction": "preview", "runId": plan["runId"]})
        again = self.run_engine({"assistantAction": "preview", "runId": plan["runId"]})
        self.assertEqual(preview["candidateImageUrl"], again["candidateImageUrl"])
        self.assertEqual(len(self.calls), 1)
        Image.new("RGB", (160, 200), "blue").save(self.source)
        self.assert_rejected(409, lambda: self.run_engine({"assistantAction": "adopt", "runId": plan["runId"]}))

    def test_stale_project_and_patch_do_not_overwrite(self):
        plan = self.run_engine({"assistantAction": "plan"})
        self.projects["project-source"]["revision"] = 2
        self.assert_rejected(409, lambda: self.run_engine({"assistantAction": "preview", "runId": plan["runId"]}))
        self.projects["project-source"]["revision"] = 1
        preview = self.run_engine({"assistantAction": "preview", "runId": plan["runId"]})
        patch_value = self.run_engine({"assistantAction": "adopt", "runId": preview["runId"]})["workflowPatch"]
        self.workflow["revision"] += 1
        self.assert_rejected(409, lambda: engine.apply_workflow_patch(self.workflow, patch_value))

    def test_restore_preserves_later_user_work(self):
        preview, adopted = self.preview_adopt()
        adopted["order"].append("later-user-node")
        self.assert_rejected(409, lambda: self.run_engine({"assistantAction": "restore", "runId": preview["runId"]}, adopted))
        self.assertIn("later-user-node", adopted["order"])

    def test_rejects_unknown_tools_ids_nan_and_bad_types_before_execution(self):
        values = [{"name": "run_python", "arguments": {"code": "delete everything"}},
                  {"name": "adjust_strokes", "arguments": {"strokeIds": ["invented"], "opacityScale": .5}},
                  {"name": "adjust_strokes", "arguments": {"strokeIds": ["stroke-1"], "opacityScale": True}},
                  {"name": "adjust_strokes", "arguments": {"strokeIds": [{}], "opacityScale": .5}},
                  {"name": "create_node", "arguments": {"type": "image_generate"}},
                  {"name": "create_node", "arguments": {"type": []}}]
        for call in values:
            self.answer["toolCalls"] = [call]
            self.assert_rejected(422, lambda: self.run_engine())
        self.assertEqual(len(self.projects), 1)
        self.assertEqual(self.workflow, self.original_workflow)

    def test_raster_effects_are_not_fabricated_as_editable_strokes(self):
        target = next(item for item in self.workflow["nodes"] if item["id"] == "target-1")
        target["output"].update(imageSemantics="raster_base", editableStrokes=False)
        self.answer["toolCalls"] = [{"name": "adjust_strokes", "arguments": {"strokeIds": ["stroke-1"], "opacityScale": .5}}]
        self.assert_rejected(422, lambda: self.run_engine())

    def test_text_mode_needs_selected_region_for_new_marks(self):
        co_design._SETTINGS["local_openai"]["vision"] = False
        self.answer["toolCalls"] = [{"name": "add_stroke", "arguments": {"type": "wear", "rect": {"x": .2, "y": .7, "w": .5, "h": .2}, "color": "#938a77", "opacity": .5, "pattern": "wear"}}]
        self.assert_rejected(422, lambda: self.run_engine())
        self.answer["toolCalls"][0]["arguments"]["regionId"] = "hem"
        self.assertEqual(self.run_engine()["kind"], "assistant_candidate")

    def test_native_tool_calls_and_no_automatic_retry(self):
        self.raw_response = {"choices": [{"message": {"content": None, "tool_calls": [{"function": {"name": "adjust_strokes", "arguments": json.dumps({"strokeIds": ["stroke-1"], "opacityScale": .5})}}]}}]}
        self.assertEqual(self.run_engine()["kind"], "assistant_candidate")
        self.assertIn("tools", self.calls[-1]["payload"])
        self.raw_response = {"choices": [{"message": {"content": "not json"}}]}
        self.assert_rejected(502, lambda: self.run_engine())
        self.assertEqual(len(self.calls), 2)

    def test_cloud_requires_confirmation_and_redacts_echoed_key(self):
        co_design._ACTIVE = "deepseek"
        co_design._SETTINGS["deepseek"] = {"baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-flash", "apiKey": "test-only-secret", "vision": False}
        self.node["type"] = "intent_assist"
        self.answer = {"message": "test-only-secret", "items": [{"label": "意图", "value": "test-only-secret"}]}
        self.assert_rejected(409, lambda: self.run_engine())
        self.assertFalse(self.calls)
        result = self.run_engine({"confirmedExternal": True})
        self.assertNotIn("test-only-secret", json.dumps(result))
        self.assertEqual(self.calls[0]["payload"]["thinking"], {"type": "disabled"})
        self.assertFalse(self.calls[0]["local"])

    def test_geometric_edit_and_protection_add_are_real(self):
        self.answer["toolCalls"] = [
            {"name": "protect_region", "arguments": {"rect": {"x": .5, "y": .3, "w": .1, "h": .2}}},
            {"name": "adjust_strokes", "arguments": {"strokeIds": ["stroke-1"], "dx": .1, "dy": .1, "scale": .7}}]
        preview, adopted = self.preview_adopt()
        target = next(item for item in adopted["nodes"] if item["id"] == "target-1")
        shape = target["output"]["brushStrokes"][0]["shapes"][0]
        self.assertAlmostEqual(shape["cx"], .5); self.assertAlmostEqual(shape["cy"], .5)
        self.assertAlmostEqual(shape["rx"], .105)
        self.assertEqual(len(target["output"]["protectedRects"]), 2)

    def test_tampered_candidate_cannot_reuse_previous_validation(self):
        preview = self.run_engine()
        path = self.core.DATA / preview["candidateImageUrl"].removeprefix("/data/")
        Image.new("RGB", (160, 200), "red").save(path)
        self.assert_rejected(409, lambda: self.run_engine({"assistantAction": "adopt", "runId": preview["runId"]}))

    def test_noop_and_fully_protected_edits_are_not_reported_as_success(self):
        self.answer["toolCalls"] = [{"name": "adjust_strokes", "arguments": {"strokeIds": ["stroke-1"], "opacityScale": 1}}]
        self.assert_rejected(422, lambda: self.run_engine())

    def test_changed_intent_invalidates_prior_plan(self):
        plan = self.run_engine({"assistantAction": "plan"})
        self.node["params"]["intent"] = "改为不要血迹"
        self.assert_rejected(409, lambda: self.run_engine({"assistantAction": "preview", "runId": plan["runId"]}))

    def test_coordinate_changing_local_tool_uses_new_raster_reference(self):
        def flatten(core, project, args, folder):
            path = folder / "flattened.png"; Image.new("RGBA", (80, 120), (90, 80, 70, 220)).save(path)
            previous = project["protectedRects"]
            project.update(reference={"url": core.data_url(path)}, brushStrokes=[], damageItems=[], protectedRects=[])
            return {"project": project, "output": {"imageUrl": core.data_url(path), "coordinateSpace": "rectified_visible_surface",
                    "protectionMapping": {"status": "requires_reselection", "previousRegions": previous}},
                    "validation": {"passed": True, "sourceUnchanged": True}, "message": "真实几何测试转换"}
        self.core.node_assistant_tools = {"garment_flatten": flatten}
        self.answer["toolCalls"] = [{"name": "run_local_tool", "arguments": {"name": "garment_flatten", "arguments": {}}}]
        preview, adopted = self.preview_adopt()
        self.assertEqual(preview["validation"]["kind"], "local_garment_tool")
        self.assertIsNone(preview["validation"]["protectedRegionsUnchanged"])
        target = next(item for item in adopted["nodes"] if item["id"] == "target-1")
        self.assertEqual(target["output"]["imageSemantics"], "raster_base")
        self.assertEqual((target["output"]["width"], target["output"]["height"]), (80, 120))
        self.assertEqual(target["output"]["brushStrokes"], [])
        self.assertEqual(target["output"]["protectedRects"], [])
        self.assertTrue(target["output"]["reference"]["url"].startswith("/data/uploads/"))

    def test_model_denying_received_images_does_not_complete_visual_review(self):
        self.node["type"] = "design_review"
        self.answer = {"message": "未收到任何图片，请上传。", "checks": [{"label": "图片", "status": "unknown", "detail": "图像未发送"}]}
        self.assert_rejected(502, lambda: self.run_engine())


if __name__ == "__main__":
    unittest.main(verbosity=2)
