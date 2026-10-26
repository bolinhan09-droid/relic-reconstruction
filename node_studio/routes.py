"""HTTP boundary for node workspaces. All execution is explicit and revisioned."""
from __future__ import annotations

import copy
import uuid

from fastapi import Request

from .adapters import run_node
from .catalog import catalog
from .store import WorkflowStore, bounded_copy, fail, now, validate_workflow


def register_node_studio_routes(app, core):
    store = WorkflowStore(core.DATA)
    # State is available to isolated API tests without reaching module globals.
    app.state.node_studio_store = store

    @app.get("/api/node-studio/catalog")
    def node_studio_catalog():
        return catalog()

    @app.get("/api/node-studio/workflows")
    def node_studio_workflows():
        return {"workflows": store.list()}

    @app.post("/api/node-studio/workflows")
    def create_node_workflow(payload: dict, request: Request):
        core.require_local_origin(request)
        return {"workflow": store.create(payload.get("workflow", payload))}

    @app.get("/api/node-studio/workflows/{workflow_id}")
    def get_node_workflow(workflow_id: str):
        return {"workflow": store.get(workflow_id)}

    @app.put("/api/node-studio/workflows/{workflow_id}")
    def save_node_workflow(workflow_id: str, payload: dict, request: Request):
        core.require_local_origin(request)
        if not isinstance(payload.get("workflow"), dict):
            fail("请同时提交 workflow 与 expectedRevision")
        return {"workflow": store.save(workflow_id, payload["workflow"], payload.get("expectedRevision"))}

    @app.get("/api/node-studio/workflows/{workflow_id}/history")
    def node_workflow_history(workflow_id: str):
        return {"history": store.history(workflow_id)}

    # Keep existing history links downloadable as complete editable JSON even
    # though the on-disk document now shares immutable geometry chunks.
    @app.get("/data/node-studio/workflows/{workflow_id}/history/{filename}")
    def node_workflow_history_document(workflow_id: str, filename: str):
        return store.get_history(workflow_id, filename)

    @app.get("/data/node-studio/workflows/{workflow_id}/workflow.json")
    def node_workflow_document(workflow_id: str):
        return store.get(workflow_id)

    @app.get("/api/node-studio/workflows/{workflow_id}/deletion")
    def node_workflow_deletion_preview(workflow_id: str):
        from .deletion import deletion_preview
        return deletion_preview(store, core, workflow_id)

    @app.delete("/api/node-studio/workflows/{workflow_id}")
    def delete_node_workflow(workflow_id: str, payload: dict, request: Request):
        core.require_local_origin(request)
        from .deletion import delete_workflow
        return delete_workflow(store, core, workflow_id, payload.get("expectedRevision"),
                               payload.get("deleteUnusedAssets", True))

    @app.get("/api/node-studio/workflows/{workflow_id}/nodes/{node_id}/making-input")
    def making_input_status(workflow_id: str, node_id: str):
        from .making_bridge import inspect_input
        with store.lock:
            workflow = store.get(workflow_id)
            node = next((entry for entry in workflow["nodes"] if entry["id"] == node_id), None)
            if node is None:
                fail("节点不存在", 404)
            if node["type"] != "stencil_export":
                fail("请在模板制作节点检查制作输入")
            return inspect_input(core, workflow, node)

    @app.post("/api/node-studio/workflows/{workflow_id}/nodes/{node_id}/run")
    def run_node_workflow(workflow_id: str, node_id: str, payload: dict, request: Request):
        core.require_local_origin(request)
        payload = bounded_copy(payload)
        with store.lock:
            workflow = store.get(workflow_id)
            expected = payload.get("expectedRevision")
            if isinstance(expected, bool) or not isinstance(expected, int) or workflow["revision"] != expected:
                fail("工作流已经更新，请先保存并载入当前版本后再执行", 409)
            node = next((entry for entry in workflow["nodes"] if entry["id"] == node_id), None)
            if node is None:
                fail("节点不存在", 404)
            if "params" in payload:
                if not isinstance(payload["params"], dict):
                    fail("节点设置须为对象")
                node["params"].update(copy.deepcopy(payload["params"]))
            workflow = validate_workflow(workflow)
            node = next(entry for entry in workflow["nodes"] if entry["id"] == node_id)
            result = run_node(core, workflow, node, payload, request)
            patch = result.pop("workflowPatch", None)
            if patch:
                from .assistant_engine import apply_workflow_patch
                workflow = apply_workflow_patch(workflow, patch)
                node = next(entry for entry in workflow["nodes"] if entry["id"] == node_id)
            node["status"] = result.get("status", "completed")
            node.pop("staleReason", None)
            if result.get("kind") != "not_implemented":
                if node.get("output") and node["output"] != result:
                    node.setdefault("versions", []).append({"id": uuid.uuid4().hex[:16],
                        "output": copy.deepcopy(node["output"]), "savedAt": now(), "source": "backend_run"})
                    node["versions"] = node["versions"][-30:]
                node["output"] = result
            else:
                node["message"] = result["message"]
            workflow["selectedNodeId"] = node_id
            saved = store.save(workflow_id, workflow, expected)
            saved_node = next(entry for entry in saved["nodes"] if entry["id"] == node_id)
            return {"workflow": saved, "node": saved_node, "result": result}

    return store
