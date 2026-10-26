"""Deletion API, reference retention and real byte accounting; synthetic only."""
from __future__ import annotations
import copy
import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, HTTPException
from PIL import Image
from node_studio import deletion
from node_studio.routes import register_node_studio_routes
from node_studio.store import WorkflowStore
from tools.check_node_studio_backend import LocalRouteClient


class DeletionTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[1] / "work" / "deletion-checks"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="v011-", dir=parent)
        self.root = Path(self.temporary.name)
        self.core = SimpleNamespace(DATA=self.root, LOCK=threading.RLock(), require_local_origin=lambda request: None)
        self.app = FastAPI()
        self.store = register_node_studio_routes(self.app, self.core)
        self.client = LocalRouteClient(self.app)
        self.asset = self.image("uploads/upload-main/image.png", "gray")
        self.workflow = self.store.create(self.document(self.asset))

    def tearDown(self):
        self.temporary.cleanup()

    def image(self, relative, color):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (120, 180), color).save(path)
        return "/data/" + relative

    def write(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def document(self, url):
        return {"title": "Deletion fixture", "nodes": [{"id": "input", "type": "garment_input",
                "params": {"front": {"url": url}}, "attachments": {}, "output": None}], "order": ["input"]}

    def owned_project(self, identifier="project-owned", reference=None):
        return self.write(f"projects/{identifier}/project.json", {
            "id": identifier, "reference": {"url": reference or self.asset},
            "nodeStudioOrigin": {"workflowId": self.workflow["id"], "nodeId": "input"}})

    def preview(self):
        return deletion.deletion_preview(self.store, self.core, self.workflow["id"])

    def remove(self):
        return deletion.delete_workflow(self.store, self.core, self.workflow["id"], self.workflow["revision"], True)

    def sizes(self):
        return {path: path.stat().st_size for path in self.root.rglob("*") if path.is_file()}

    def test_real_cleanup_all_owned_artifacts_and_exact_bytes(self):
        self.owned_project()
        generated = self.image("jobs/job-owned/result.png", "red")
        self.write("jobs/job-owned/job.json", {"id": "job-owned", "projectId": "project-owned", "status": "completed"})
        self.write("surface-jobs/surface-owned/job.json", {"id": "surface-owned", "projectId": "project-owned", "status": "succeeded", "sourceUrl": self.asset})
        self.image("surface-jobs/surface-owned/foreground-mask.png", "white")
        self.write("flatlay-jobs/flatlay-owned/job.json", {"id": "flatlay-owned", "projectId": "project-owned", "status": "succeeded"})
        self.image("flatlay-jobs/flatlay-owned/model-output/flatlay.png", "gray")
        artifact = self.image("garment-tools/tool-owned/mask.png", "white")
        self.write("node-studio/garment-jobs/garment-owned.json",
                   {"id": "garment-owned", "workflowId": self.workflow["id"], "status": "completed", "artifact": {"maskUrl": artifact}})
        self.image("node-studio/garment-jobs/garment-owned/input.png", "gray")
        self.write("node-studio/assistant-runs/run-owned/run.json",
                   {"binding": {"workflowId": self.workflow["id"]}, "candidateOutput": {"imageUrl": generated}})
        self.image("node-studio/assistant-runs/run-owned/preview.png", "red")
        self.write(f"node-studio/exports/{self.workflow['id']}/node/calibration.json", {"scale": 1})
        unrelated = self.image("uploads/upload-unrelated/image.png", "blue")
        before = self.sizes()
        estimate = self.preview()
        self.assertGreater(estimate["assetCount"], 3)
        result = self.remove()
        after = self.sizes()
        self.assertTrue(result["deleted"])
        self.assertEqual(result["freedBytes"], sum(before.values()) - sum(after.values()))
        self.assertEqual(result["deletedFiles"], len(before) - len(after))
        self.assertEqual(result["freedBytes"], estimate["estimatedBytes"])
        self.assertTrue((self.root / unrelated.removeprefix("/data/")).exists())
        self.assertFalse((self.root / "uploads/upload-main").exists())
        self.assertFalse((self.root / "projects/project-owned").exists())
        self.assertFalse((self.root / "garment-tools/tool-owned").exists())
        self.assertFalse((self.root / "surface-jobs/surface-owned").exists())
        self.assertFalse((self.root / "flatlay-jobs/flatlay-owned").exists())

    def test_other_workflow_history_retains_shared_upload(self):
        second = self.store.create(self.document(self.asset))
        changed = copy.deepcopy(second)
        changed["nodes"][0]["params"]["front"]["url"] = self.image("uploads/upload-second/image.png", "green")
        self.store.save(second["id"], changed, second["revision"])
        result = self.remove()
        self.assertTrue((self.root / "uploads/upload-main/image.png").exists())
        self.assertGreater(result["retainedFiles"], 0)
        self.assertEqual(self.store.get(second["id"])["revision"], 2)

    def test_legacy_project_keeps_shared_project_transitively(self):
        self.owned_project()
        preview_url = self.image("projects/project-owned/preview.png", "red")
        self.write("projects/project-legacy/project.json", {"id": "project-legacy", "reference": {"url": preview_url}})
        self.remove()
        self.assertTrue((self.root / "projects/project-owned/project.json").exists())
        self.assertTrue((self.root / "uploads/upload-main/image.png").exists())
        self.assertTrue((self.root / "projects/project-legacy/project.json").exists())

    def test_stale_revision_deletes_nothing(self):
        before = self.sizes()
        with self.assertRaises(HTTPException) as error:
            deletion.delete_workflow(self.store, self.core, self.workflow["id"], 0, True)
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(before, self.sizes())

    def test_active_job_prevents_any_deletion(self):
        self.owned_project()
        self.write("jobs/job-active/job.json", {"id": "job-active", "projectId": "project-owned", "status": "running"})
        before = self.sizes()
        with self.assertRaises(HTTPException) as error:
            self.remove()
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(before, self.sizes())

    def test_surface_and_flatlay_active_jobs_block_deletion(self):
        self.owned_project()
        for family, identifier in (("surface-jobs", "surface-live"), ("flatlay-jobs", "flatlay-live")):
            with self.subTest(family=family):
                record = self.write(f"{family}/{identifier}/job.json", {
                    "id": identifier, "projectId": "project-owned", "status": "running", "sourceUrl": self.asset})
                before = self.sizes()
                with self.assertRaises(HTTPException) as error:
                    self.remove()
                self.assertEqual(error.exception.status_code, 409)
                self.assertEqual(before, self.sizes())
                record.unlink()

    def test_surface_and_flatlay_typed_references_preserve_dependencies(self):
        self.owned_project()
        self.write("surface-jobs/surface-shared/job.json", {"id": "surface-shared",
            "projectId": "project-owned", "sourceUrl": self.asset, "status": "succeeded"})
        self.write("flatlay-jobs/flatlay-shared/job.json", {"id": "flatlay-shared",
            "projectId": "project-owned", "status": "succeeded"})
        self.write("projects/project-independent/project.json", {"id": "project-independent",
            "surfaceOptions": {"analysisId": "surface-shared"}, "mapping": {"flatlayJobId": "flatlay-shared"}})
        self.remove()
        self.assertTrue((self.root / "surface-jobs/surface-shared/job.json").exists())
        self.assertTrue((self.root / "flatlay-jobs/flatlay-shared/job.json").exists())
        self.assertTrue((self.root / "projects/project-owned/project.json").exists())
        self.assertTrue((self.root / "uploads/upload-main/image.png").exists())

    def test_restart_recovers_all_four_job_families_and_allows_deletion(self):
        import app as actual_core
        from node_studio import garment_jobs
        self.owned_project()
        for family, identifier in (("jobs", "job-old"), ("surface-jobs", "surface-old"), ("flatlay-jobs", "flatlay-old")):
            self.write(f"{family}/{identifier}/job.json", {"id": identifier, "projectId": "project-owned",
                "status": "running", "sourceUrl": self.asset})
        self.write("node-studio/garment-jobs/garment-old.json", {
            "id": "garment-old", "workflowId": self.workflow["id"], "status": "running", "sourceImageUrl": self.asset})
        recovery_names = {"recover_interrupted_jobs", "interrupted", "interrupted_flatlay_jobs", "recover_interrupted_garment_jobs"}
        callbacks = [callback for callback in actual_core.app.router.on_startup if callback.__name__ in recovery_names]
        self.assertEqual(len(callbacks), 4)
        with patch.object(actual_core, "DATA", self.root):
            for callback in callbacks:
                callback()
        self.assertEqual(json.loads((self.root / "node-studio/garment-jobs/garment-old.json").read_text(encoding="utf-8"))["status"], "interrupted")
        result = self.remove()
        self.assertTrue(result["deleted"])
        self.assertFalse((self.root / "uploads/upload-main/image.png").exists())

    def test_startup_never_interrupts_live_garment_worker(self):
        from node_studio import garment_jobs
        garment_jobs.register_garment_job_routes(self.app, self.core)
        self.write("node-studio/garment-jobs/garment-live.json", {
            "id": "garment-live", "workflowId": self.workflow["id"], "status": "running", "sourceImageUrl": self.asset})
        with garment_jobs._LOCK:
            garment_jobs._LIVE.add("garment-live")
        try:
            next(callback for callback in self.app.router.on_startup if callback.__name__ == "recover_interrupted_garment_jobs")()
            self.assertEqual(json.loads((self.root / "node-studio/garment-jobs/garment-live.json").read_text(encoding="utf-8"))["status"], "running")
            with self.assertRaises(HTTPException) as error:
                self.remove()
            self.assertEqual(error.exception.status_code, 409)
        finally:
            with garment_jobs._LOCK:
                garment_jobs._LIVE.discard("garment-live")

    def test_paths_and_linked_assets_are_never_followed(self):
        with self.assertRaises(HTTPException):
            deletion.delete_workflow(self.store, self.core, "../escape", 1, True)
        real_reparse = deletion._reparse
        blocked = self.root / "uploads/upload-main/image.png"
        with patch.object(deletion, "_reparse", lambda path: Path(path) == blocked or real_reparse(path)):
            preview = self.preview()
            self.assertTrue(preview["conservative"])
            result = self.remove()
        self.assertTrue(blocked.exists())
        self.assertTrue(result["conservative"])

    def test_unreadable_other_metadata_preserves_optional_assets(self):
        broken = self.root / "projects/project-broken/project.json"
        broken.parent.mkdir(parents=True)
        broken.write_text("{malformed", encoding="utf-8")
        self.owned_project()
        result = self.remove()
        self.assertTrue(result["conservative"])
        self.assertTrue((self.root / "uploads/upload-main/image.png").exists())
        self.assertTrue((self.root / "projects/project-owned/project.json").exists())

    def test_old_save_cannot_resurrect_a_deleted_workflow(self):
        self.remove()
        with self.assertRaises(HTTPException) as error:
            self.store.save(self.workflow["id"], self.workflow, self.workflow["revision"])
        self.assertEqual(error.exception.status_code, 404)
        self.assertFalse((self.store._folder(self.workflow["id"]) / "workflow.json").exists())

    def test_delete_and_save_are_serialized(self):
        begin = threading.Barrier(2)
        def save():
            begin.wait()
            try:
                self.store.save(self.workflow["id"], self.workflow, 1)
                return "saved"
            except HTTPException as error:
                return error.status_code
        def remove():
            begin.wait()
            try:
                self.remove()
                return "deleted"
            except HTTPException as error:
                return error.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            future = pool.submit(save)
            outcome = remove(), future.result()
        self.assertIn(outcome, [("deleted", 404), (409, "saved")])
        if outcome[0] == "deleted":
            self.assertFalse((self.store._folder(self.workflow["id"]) / "workflow.json").exists())

    def test_registered_http_preview_and_delete(self):
        url = "/api/node-studio/workflows/" + self.workflow["id"]
        preview = self.client._request("GET", url + "/deletion").json()
        self.assertEqual(preview["revision"], 1)
        response = self.client._request("DELETE", url, json={"expectedRevision": preview["revision"], "deleteUnusedAssets": True})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["deleted"])
        self.assertGreater(response.json()["freedBytes"], 0)
        self.assertEqual(self.client._request("GET", url).status_code, 404)

    def test_no_asset_cleanup_option_really_retains_images(self):
        result = deletion.delete_workflow(self.store, self.core, self.workflow["id"], 1, False)
        self.assertTrue(result["deleted"])
        self.assertTrue((self.root / "uploads/upload-main/image.png").exists())
        self.assertGreater(result["retainedFiles"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
