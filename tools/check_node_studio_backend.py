"""Meaningful isolated node-workflow API checks; synthetic images, no paid calls."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI, HTTPException
from starlette.requests import Request
from PIL import Image

from node_studio.catalog import NODES
from node_studio.fabrication import export_stencil
from node_studio.routes import register_node_studio_routes
from node_studio.store import WorkflowStore, validate_workflow


class LocalRouteClient:
    """Invoke the registered HTTP boundary without opening Windows sockets.

    Sandbox Windows socketpair may block an asyncio loop's self-pipe. Request
    origin checks, path parameters and route handlers are real; network/parser
    behaviour is separately covered by the browser integration run.
    """
    def __init__(self, server, **_kwargs):
        self.server = server

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def _request(self, method, path, json=None, headers=None):
        import inspect
        from types import SimpleNamespace
        route = next(route for route in self.server.routes if method in getattr(route, "methods", set()) and route.path_regex.fullmatch(path))
        kwargs = route.path_regex.fullmatch(path).groupdict()
        incoming = {"host": "127.0.0.1:17870", "content-type": "application/json", **(headers or {})}
        request = Request({"type": "http", "method": method, "path": path, "root_path": "", "scheme": "http",
                           "query_string": b"", "headers": [(key.encode(), value.encode()) for key, value in incoming.items()],
                           "server": ("127.0.0.1", 17870), "client": ("127.0.0.1", 12345)})
        signature = inspect.signature(route.endpoint)
        if "request" in signature.parameters:
            kwargs["request"] = request
        if "payload" in signature.parameters:
            kwargs["payload"] = copy.deepcopy(json)
        try:
            value = route.endpoint(**kwargs)
            return SimpleNamespace(status_code=200, text=str(value), json=lambda: copy.deepcopy(value))
        except HTTPException as exc:
            return SimpleNamespace(status_code=exc.status_code, text=str(exc.detail), json=lambda: {"detail": exc.detail})

    def post(self, path, **kwargs):
        return self._request("POST", path, **kwargs)

    def put(self, path, **kwargs):
        return self._request("PUT", path, **kwargs)


def node(identifier, kind, params=None, output=None):
    return {"id": identifier, "type": kind, "label": kind, "params": params or {},
            "attachments": {"top": [], "bottom": []}, "status": "idle", "output": output}


def workflow(asset):
    return {"schemaVersion": 1, "title": "Synthetic garment", "nodes": [
        node("input", "garment_input", {"front": asset, "back": None, "flat": asset}),
        node("scene", "scene_context", {"character": "Test", "scene": "测试情境", "bloodColor": "#558855"}),
        node("quick", "quick_create", {"intent": "在披风添加少量方向明确的飞溅"}),
        node("image", "image_generate", {"provider": "openai", "mode": "draft"})],
        "order": ["input", "quick", "image"], "stash": ["scene"], "selectedNodeId": "input", "assets": [asset], "context": {}}


def rejects(status, method, *args, **kwargs):
    try:
        method(*args, **kwargs)
    except HTTPException as exc:
        assert exc.status_code == status, (status, exc.status_code, exc.detail)
        return
    raise AssertionError("Expected rejection")


def main():
    import app as core
    checks = []
    assert len(NODES) == 23 and len({entry["type"] for entry in NODES}) == 23
    checks.append("23 unique catalog nodes with separate flatten and mapping")
    scratch_parent = Path(core.DATA) / "runtime"
    scratch_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="node-studio-check-", dir=scratch_parent) as scratch:
        data = Path(scratch)
        for directory in ("uploads", "projects", "jobs", "runtime"):
            (data / directory).mkdir(parents=True, exist_ok=True)
        folder = data / "uploads" / "upload-test"
        folder.mkdir()
        Image.new("RGB", (120, 180), "#627879").save(folder / "image.png")
        original_hash = hashlib.sha256((folder / "image.png").read_bytes()).hexdigest()
        asset = {"id": "upload-test", "url": "/data/uploads/upload-test/image.png", "width": 120, "height": 180}
        sample = workflow(asset)

        store = WorkflowStore(data)
        first = store.create(sample)
        assert first["revision"] == 1 and store.get(first["id"]) == first
        assert store.list()[0]["id"] == first["id"]
        checks.append("atomic create/read/list with null outputs")
        second = store.save(first["id"], {**first, "title": "new title"}, 1)
        assert second["revision"] == 2 and len(store.history(first["id"])) == 2
        rejects(409, store.save, first["id"], first, 1)
        assert store.get(first["id"])["title"] == "new title"
        checks.append("optimistic revisions prevent stale overwrite")

        modified = copy.deepcopy(second)
        modified["nodes"][2]["output"] = {"kind": "generation_task", "imageUrl": asset["url"]}
        modified["nodes"][3]["output"] = {"kind": "garment", "imageUrl": asset["url"]}
        modified["nodes"][2]["status"] = modified["nodes"][3]["status"] = "completed"
        third = store.save(first["id"], modified, 2)
        changed = copy.deepcopy(third)
        changed["nodes"][2]["params"]["intent"] = "改为袖口"
        fourth = store.save(first["id"], changed, 3)
        assert fourth["nodes"][2]["status"] == fourth["nodes"][3]["status"] == "stale"
        assert fourth["nodes"][3]["output"] == third["nodes"][3]["output"]
        assert json.loads((store._folder(first["id"]) / "history" / "revision-000003.json").read_text(encoding="utf-8"))["nodes"][2]["params"]["intent"] != "改为袖口"
        checks.append("upstream edits retain images and mark downstream stale")
        reordered = copy.deepcopy(fourth)
        reordered["order"] = ["input", "image", "quick"]
        fifth = store.save(first["id"], reordered, 4)
        assert fifth["nodes"][3]["status"] == "stale"
        checks.append("reorder marks prior outputs stale")

        independent = copy.deepcopy(sample)
        independent["nodes"].append(node("input2", "garment_input"))
        independent["routes"] = [{"id": "route-second", "label": "另一件服装", "order": ["input2"], "x": 40, "y": 500}]
        assert validate_workflow(independent)["routes"] == independent["routes"]
        invalid = copy.deepcopy(sample)
        invalid["order"] = ["quick", "input", "image"]
        rejects(422, validate_workflow, invalid)
        invalid = copy.deepcopy(sample)
        invalid["order"].append("missing")
        rejects(422, validate_workflow, invalid)
        checks.append("independent garments, starting type, missing references")

        invalid = copy.deepcopy(sample)
        invalid["nodes"][2]["params"]["sourceNodeId"] = "image"
        rejects(422, validate_workflow, invalid)
        invalid = copy.deepcopy(sample)
        invalid["stash"] = []
        invalid["nodes"][0]["attachments"]["top"] = ["scene"]
        invalid["nodes"][1]["params"]["sourceNodeId"] = "input"
        rejects(422, validate_workflow, invalid)
        invalid = copy.deepcopy(sample)
        invalid["stash"] = []
        invalid["nodes"][0]["attachments"]["bottom"] = ["scene"]
        rejects(422, validate_workflow, invalid)
        checks.append("candidate and side-attachment cycle detection; typed slots")
        invalid = copy.deepcopy(sample)
        invalid["nodes"][0]["params"]["apiKey"] = "do-not-persist"
        rejects(422, validate_workflow, invalid)
        invalid = copy.deepcopy(sample)
        invalid["context"]["value"] = float("nan")
        rejects(422, validate_workflow, invalid)
        rejects(422, store.get, "../escape")
        checks.append("no persisted keys, NaN or path traversal")

        concurrent = store.create(sample)
        def attempt(title):
            try:
                return store.save(concurrent["id"], {**concurrent, "title": title}, 1)["revision"]
            except HTTPException as exc:
                return exc.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(attempt, ["one", "two"])) == [2, 409]
        checks.append("concurrent saves cannot overwrite each other")

        with patch.object(core, "DATA", data):
            server = FastAPI()
            register_node_studio_routes(server, core)
            with LocalRouteClient(server) as client:
                result = client.post("/api/node-studio/workflows", json={"workflow": sample})
                assert result.status_code == 200, result.text
                saved = result.json()["workflow"]
                identifier = saved["id"]
                def run(nid, params=None, confirm=False):
                    nonlocal saved
                    response = client.post(f"/api/node-studio/workflows/{identifier}/nodes/{nid}/run",
                        json={"expectedRevision": saved["revision"], "params": params or {}, "confirmedExternal": confirm})
                    if response.status_code == 200:
                        saved = response.json()["workflow"]
                    return response
                output = run("input").json()["result"]
                assert output["originalImageUrl"] == asset["url"] and output["apiRequest"] is False
                task = run("quick")
                assert task.status_code == 200, task.text
                assert task.json()["result"]["task"]["apiRequest"] is False
                checks.append("API input and task preparation perform no model calls")

                import quick_draft
                calls = []
                def fake_job(*args, **kwargs):
                    calls.append(args[1])
                    return {"id": "job-isolated-test", "status": "queued", "message": "isolated job"}
                with patch.object(quick_draft, "create_draft_job", fake_job):
                    before = len(list((data / "projects").glob("*/project.json")))
                    denied = run("image")
                    assert denied.status_code == 409 and not calls
                    assert len(list((data / "projects").glob("*/project.json"))) == before
                    allowed = run("image", confirm=True)
                    assert allowed.status_code == 200, allowed.text
                    assert len(calls) == 1 and allowed.json()["result"]["jobId"] == "job-isolated-test"
                    old_project_id = calls[0]
                    previous_task = copy.deepcopy(next(entry for entry in saved["nodes"] if entry["id"] == "quick")["output"])
                    changed_task = run("quick", {"intent": "改为袖口轻微磨损，保留披风"})
                    assert changed_task.status_code == 200, changed_task.text
                    history = next(entry for entry in saved["nodes"] if entry["id"] == "quick")["versions"]
                    assert history[-1]["output"] == previous_task
                    generated_again = run("image", confirm=True)
                    assert generated_again.status_code == 200, generated_again.text
                    assert len(calls) == 2 and calls[1] != old_project_id
                    assert "改为袖口轻微磨损" in core.get_project(calls[1])["customDamageIdea"]
                    assert "改为袖口轻微磨损" not in core.get_project(old_project_id)["customDamageIdea"]
                    checks.append("backend reruns preserve node output versions and fork updated generation intent")
                checks.append("explicit external confirmation gates paid-job submission")
                assert hashlib.sha256((folder / "image.png").read_bytes()).hexdigest() == original_hash
                checks.append("project forks preserve uploaded original bytes")

                # Without an active visual model, review cannot claim inspection.
                saved["nodes"].extend([node("review", "design_review"), node("future", "battle_simulation")])
                saved["order"].extend(["review", "future"])
                response = client.put(f"/api/node-studio/workflows/{identifier}", json={"workflow": saved, "expectedRevision": saved["revision"]})
                assert response.status_code == 200, response.text
                saved = response.json()["workflow"]
                report = run("review")
                assert report.status_code == 200, report.text
                assert report.json()["result"]["semanticAI"] is False and report.json()["result"]["visualInspection"] is False
                future = run("future")
                assert future.status_code == 200 and future.json()["result"]["experimental"] is True
                assert future.json()["result"]["physicalSimulation"] is False and future.json()["result"]["cameraRecognition"] is False
                assert future.json()["result"]["meshHitRecordingAvailable"] is True
                checks.append("unavailable review cannot claim vision; 3D workspace does not claim photo registration")
                assert client.put(f"/api/node-studio/workflows/{identifier}", json={"workflow": saved, "expectedRevision": 1}).status_code == 409
                hostile = client.post("/api/node-studio/workflows", json={"workflow": sample}, headers={"origin": "https://outside.example"})
                assert hostile.status_code == 403
                checks.append("HTTP optimistic-lock and cross-origin boundaries")

                # Run the actual blend/region workers with an in-memory fake
                # transport; geometry validation and saved results remain real.
                class ImmediateExecutor:
                    def submit(self, callback, *args):
                        callback(*args)

                import cloud_provider
                chosen_model = cloud_provider.PROVIDERS["openai"]["models"][0]
                credentials = {"provider": "openai", "model": chosen_model, "quality": "medium",
                               "region": "", "workspaceId": "", "baseUrl": "https://api.openai.com/v1"}
                fake_secret = "isolated-test-value-never-persisted"
                transport_calls = []
                transport_details = []
                metadata_extra = {}
                def fake_edit(images, prompt, mask, settings, secret):
                    assert secret == fake_secret
                    transport_calls.append({"images": len(images), "mask": mask is not None, "quality": settings["quality"]})
                    transport_details.append({"prompt": prompt, "pixels": [Image.open(io.BytesIO(content)).convert("RGB").getpixel((0, 0)) for content in images]})
                    buffer = io.BytesIO()
                    Image.new("RGB", (120, 180), "#bd3322").save(buffer, format="PNG")
                    return buffer.getvalue(), {"provider": settings["provider"], "model": settings["model"], "quality": settings["quality"], "usage": {"input_tokens": 1}, **metadata_extra}

                with patch.object(core, "EXECUTOR", ImmediateExecutor()), patch.object(cloud_provider, "credentials", lambda _provider=None: (dict(credentials), fake_secret)), patch.object(cloud_provider, "edit", fake_edit):
                    fusion = workflow(asset)
                    fusion["nodes"] = [node("input", "garment_input", {"front": asset}),
                        *[node(f"candidate{i}", "precision_edit", output={"kind": "garment", "imageUrl": asset["url"]}) for i in range(3)],
                        node("blend", "blend_create", {"candidateIds": ["candidate0", "candidate1", "candidate2"], "baseNodeId": "candidate0", "weights": [.6, .3, .1], "effectScope": "blood"}),
                        node("image", "image_generate", {"provider": "openai", "mode": "draft", "model": chosen_model, "quality": "high"})]
                    fusion["order"] = ["input", "blend", "image"]
                    fusion["stash"] = ["candidate0", "candidate1", "candidate2"]
                    saved = client.post("/api/node-studio/workflows", json={"workflow": fusion}).json()["workflow"]
                    identifier = saved["id"]
                    prepared = run("blend")
                    assert prepared.status_code == 200, prepared.text
                    generated = run("image", confirm=True)
                    assert generated.status_code == 200, generated.text
                    blend_job = core.get_job(generated.json()["result"]["jobId"])
                    assert blend_job["status"] == "succeeded", blend_job
                    assert transport_calls[-1] == {"images": 4, "mask": False, "quality": "high"}
                    assert not blend_job["preciseSemanticInterpolation"]
                    checks.append("multi-reference blend worker sends every candidate and selected quality")
                    configuration_path = data / "jobs" / blend_job["id"] / "configuration.json"
                    assert fake_secret not in configuration_path.read_text(encoding="utf-8")

                    regional = workflow(asset)
                    regional["nodes"][2] = node("region", "region_generate", {"intent": "在圈选处添加磨损", "regions": [{"x": .25, "y": .25, "w": .5, "h": .5}]})
                    regional["nodes"][3]["params"]["model"] = chosen_model
                    regional["nodes"][3]["params"]["quality"] = "high"
                    regional["order"] = ["input", "region", "image"]
                    saved = client.post("/api/node-studio/workflows", json={"workflow": regional}).json()["workflow"]
                    identifier = saved["id"]
                    assert run("region").status_code == 200
                    generated = run("image", confirm=True)
                    assert generated.status_code == 200, generated.text
                    region_job = core.get_job(generated.json()["result"]["jobId"])
                    assert region_job["status"] == "succeeded", region_job
                    with Image.open(data / "jobs" / region_job["id"] / "result.png") as result_image:
                        assert result_image.getpixel((0, 0)) == (98, 120, 121)
                        assert result_image.getpixel((60, 90)) == (189, 51, 34)
                    assert transport_calls[-1] == {"images": 1, "mask": True, "quality": "high"}
                    checks.append("region worker preserves actual outside pixels and selected model parameters")

                    # The verified 8190 profile accepts two candidates, with the
                    # chosen base already occupying image 1. Distinct pixels make
                    # this assert actual upload order, not only prompt labels.
                    second_folder = data / "uploads" / "upload-blend-second"
                    second_folder.mkdir()
                    Image.new("RGB", (120, 180), (11, 22, 33)).save(second_folder / "image.png")
                    second_url = "/data/uploads/upload-blend-second/image.png"
                    credentials.update(provider="local_openai", model="sd-cpp-local", quality="auto", baseUrl="http://127.0.0.1:8190/v1")
                    metadata_extra.update(processingSize=[384, 512], originalSize=[120, 180], referenceSizes=[[120, 180], [120, 180]],
                                          resizeApproximation=True, serverMask=False, maskStrategy="none", researchOnly=True,
                                          license="Qwen Research License", localOnly=True, billing="local_runtime", imageEditingVerified=True,
                                          apiKey=fake_secret, untrustedProviderField="must-not-persist")
                    local_fusion = copy.deepcopy(fusion)
                    local_fusion["nodes"] = [entry for entry in local_fusion["nodes"] if entry["id"] != "candidate2"]
                    local_fusion["stash"] = ["candidate0", "candidate1"]
                    local_nodes = {entry["id"]: entry for entry in local_fusion["nodes"]}
                    local_nodes["candidate1"]["output"]["imageUrl"] = second_url
                    local_nodes["blend"]["params"].update(candidateIds=["candidate0", "candidate1"], baseNodeId="candidate1", weights=[.25, .75])
                    local_nodes["image"]["params"].update(provider="local_openai", model="sd-cpp-local", quality="auto")
                    created = client.post("/api/node-studio/workflows", json={"workflow": local_fusion})
                    assert created.status_code == 200, created.text
                    saved = created.json()["workflow"]; identifier = saved["id"]
                    assert run("blend").status_code == 200
                    before_calls = len(transport_calls)
                    generated = run("image")
                    assert generated.status_code == 200, generated.text
                    local_job = core.get_job(generated.json()["result"]["jobId"])
                    assert local_job["status"] == "succeeded", local_job
                    assert len(transport_calls) == before_calls + 1
                    assert transport_calls[-1] == {"images": 2, "mask": False, "quality": "auto"}
                    assert transport_details[-1]["pixels"] == [(11, 22, 33), (98, 120, 121)]
                    local_folder = data / "jobs" / local_job["id"]
                    config = core.read_json(local_folder / "configuration.json")
                    expected_inputs = [
                        {"imageIndex": 1, "candidateId": "candidate1", "weight": .75, "primary": True},
                        {"imageIndex": 2, "candidateId": "candidate0", "weight": .25, "primary": False}]
                    assert config["inputImageCount"] == 2 and config["duplicateBaseReferenceRemoved"] is True
                    assert config["inputCandidates"] == expected_inputs and config["weights"] == [.25, .75]
                    assert config["prompt"] == transport_details[-1]["prompt"]
                    assert "图片1：候选ID=candidate1，偏好权重=0.750000" in config["prompt"]
                    assert "图片2：候选ID=candidate0，偏好权重=0.250000" in config["prompt"]
                    checks.append("local 8190 two-candidate blend uploads chosen second base first with exact prompt/config weights")
                    source = core.read_json(local_folder / "generation-source.json")
                    for key, value in metadata_extra.items():
                        if key not in {"apiKey", "untrustedProviderField"}:
                            assert source[key] == value, (key, source)
                    assert source["provider"] == "local_openai" and source["model"] == "sd-cpp-local"
                    assert source["serverMask"] is False and source["physicalSimulation"] is False
                    assert source["requestCount"] == 1 and source["mode"] == "node_multi_reference_blend"
                    assert "apiKey" not in source and "untrustedProviderField" not in source
                    assert fake_secret not in (local_folder / "generation-source.json").read_text(encoding="utf-8")
                    checks.append("local blend source receipt preserves small-image and mask provenance while dropping unapproved metadata")

                    too_many = copy.deepcopy(fusion)
                    next(entry for entry in too_many["nodes"] if entry["id"] == "image")["params"].update(provider="local_openai", model="sd-cpp-local", quality="auto")
                    saved = client.post("/api/node-studio/workflows", json={"workflow": too_many}).json()["workflow"]
                    identifier = saved["id"]
                    assert run("blend").status_code == 200
                    before_calls = len(transport_calls)
                    before_jobs = set((data / "jobs").glob("*/job.json"))
                    denied = run("image")
                    assert denied.status_code == 422 and "两个候选" in denied.text, denied.text
                    assert len(transport_calls) == before_calls
                    assert set((data / "jobs").glob("*/job.json")) == before_jobs
                    checks.append("local 8190 three-candidate blend is rejected with HTTP 422 before job creation or transport")

        from node_studio.adapters import context_for
        researched = workflow(asset)
        research = node("research", "character_research", {
            "selectedCharacter": {"name": "Synthetic role", "ip": "Test IP"},
            "selectedScene": {"id": "battle", "title": "Adopted scene", "summary": "Source-backed context", "sourceIds": ["s1"], "evidenceStatus": "source_excerpt"},
            "adoptedSources": [{"id": "s1", "url": "https://example.org/adopted"}],
            "researchSources": [{"id": "s1", "url": "https://example.org/draft-only"}],
            "adoptedSourceImageUrl": asset["url"],
        })
        researched["nodes"].append(research)
        researched["nodes"][0]["attachments"]["top"].append("research")
        adopted_context = context_for(researched, researched["nodes"][2])["scene"]
        assert adopted_context["scene"] == "Adopted scene"
        assert adopted_context["sources"] == ["https://example.org/adopted"]
        researched["nodes"][0]["output"] = {"imageUrl": "/data/uploads/replaced/image.png"}
        assert "researchSourceNodeId" not in context_for(researched, researched["nodes"][2])["scene"]
        research["params"].pop("selectedScene")
        assert "researchSourceNodeId" not in context_for(researched, researched["nodes"][2])["scene"]
        checks.append("only adopted research sources affect scene context; replacing photo expires prior evidence")

        polygons = [[{"x": .2, "y": .2}, {"x": .8, "y": .2}, {"x": .8, "y": .8}, {"x": .2, "y": .8}]]
        calibrated = {"flatConfirmed": True, "scaleConfirmed": True, "widthMm": 200, "heightMm": 300, "bridgeMm": 2, "polygons": polygons}
        rejects(422, export_stencil, {**calibrated, "scaleConfirmed": False}, data / "bad-export")
        receipt = export_stencil(calibrated, data / "export")
        svg = (data / "export" / "stencil.svg").read_text(encoding="utf-8")
        dxf = (data / "export" / "stencil.dxf").read_text(encoding="ascii")
        assert 'width="200mm"' in svg and svg.count("<polygon") == 2
        assert "$INSUNITS\n70\n4" in dxf and dxf.count("LWPOLYLINE") == 2
        assert receipt["supportBridges"][0]["widthMm"] == 2 and not receipt["isSewingPattern"]
        checks.append("real SVG/DXF share metric geometry and support bridge; calibration gate")
        rejects(422, export_stencil, {**calibrated, "widthMm": float("inf")}, data / "invalid-export")
        checks.append("fabrication rejects nonfinite dimensions")

    print(json.dumps({"passed": len(checks), "checks": checks, "paidCalls": 0, "userImagesUsed": False}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
