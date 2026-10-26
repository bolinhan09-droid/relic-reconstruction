"""Non-blocking local garment jobs; results are candidates until explicitly adopted."""
from __future__ import annotations
import copy
import hashlib
import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from fastapi import HTTPException, Request
from PIL import Image, ImageOps
from .store import bounded_copy, fail, now, safe_id

_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="garment-tools")
_CAPACITY = threading.BoundedSemaphore(4)
_LOCK = threading.RLock()
_LIVE = set()


def _folder(core):
    path = Path(core.DATA) / "node-studio" / "garment-jobs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write(core, job):
    path = _folder(core) / (safe_id(job["id"]) + ".json")
    temporary = path.with_suffix(".tmp")
    with _LOCK:
        temporary.write_text(json.dumps(job, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        temporary.replace(path)


def get_job(core, identifier):
    with _LOCK:
        path = _folder(core) / (safe_id(identifier) + ".json")
        if not path.is_file(): fail("本机服装任务不存在", 404)
        job = json.loads(path.read_text(encoding="utf-8"))
        if job["status"] in {"queued", "running"} and identifier not in _LIVE:
            job.update(status="interrupted", message="上次运行已中断，请重新执行；原图仍保留。")
        return job


def _source(core, workflow, node):
    from .adapters import current_base, local_image_path
    base = current_base(core, workflow, node)
    source_node = next((item for item in workflow['nodes'] if item['id'] == base.get('sourceNodeId')), None)
    output = (source_node or {}).get('output') or {}
    raster = output.get('imageSemantics') == 'raster_base' or output.get('rasterized') is True or output.get('editableStrokes') is False
    project = None
    if not raster:
        project = copy.deepcopy(output.get('projectSnapshot'))
        project_id = output.get('projectId')
        live = core.get_project(project_id) if project_id else None
        if project is None:
            project = copy.deepcopy(live)
        if project is None and output.get('imageSemantics') == 'editable_preview':
            project = {'reference': copy.deepcopy(output.get('reference') or {'url': base['imageUrl']})}
        if project is not None:
            for key in ('brushStrokes', 'protectedRects', 'damageItems', 'surfaceOptions'):
                if key in output:
                    project[key] = copy.deepcopy(output[key])
    else:
        live = None
    editable = bool(project is not None and (output.get('imageSemantics') == 'editable_preview'
                    or project.get('brushStrokes') or output.get('projectSnapshot')))
    reference_url = (project.get('reference') or {}).get('url') if editable else None
    path = (local_image_path(core, reference_url) if reference_url else core.local_image(project)) if editable else local_image_path(core, base['imageUrl'])
    file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    # Store the state binding separately from the rendered input. This prevents
    # stale edits hiding behind an unchanged original photograph URL, and a
    # raster result cannot accidentally inherit an older node's brush strokes.
    binding = {'sourceNodeId': base.get('sourceNodeId'), 'sourceImageUrl': base['imageUrl'],
               'sourceFileHash': file_hash, 'output': output,
               'editableProject': project if editable else None,
               'liveProject': live}
    fingerprint = hashlib.sha256(json.dumps(binding, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    return base, file_hash, fingerprint, path, project if editable else None


def _snapshot_input(core, path, project, folder):
    with Image.open(path) as opened:
        image = ImageOps.exif_transpose(opened).convert('RGBA')
    if project and project.get('brushStrokes'):
        import brush_workflow
        _, paint = brush_workflow._raster(project, image.size, with_paint=True, source=image.convert('RGB'))
        image.alpha_composite(paint)
    folder.mkdir(parents=True, exist_ok=False)
    target = folder / 'input.png'
    image.save(target)
    return core.data_url(target), hashlib.sha256(target.read_bytes()).hexdigest()


def _worker(core, job):
    try:
        from . import garment_tools
        job.update(status="running", message="正在本机处理服装图片…", startedAt=now()); _write(core, job)
        operation = {"segment": garment_tools.segment, "flatten": garment_tools.flatten, "foreground": garment_tools.foreground}[job["operation"]]
        from .adapters import local_image_path
        snapshot = local_image_path(core, job['inputImageUrl'])
        if hashlib.sha256(snapshot.read_bytes()).hexdigest() != job['inputHash']:
            fail('任务输入快照已变化，请重新运行', 409)
        artifact = operation(core, job["inputImageUrl"], job["params"])
        job.update(status="completed", artifact=artifact, message="候选已生成，请比较后选择采用。", completedAt=now())
    except HTTPException as error:
        job.update(status="failed", message=str(error.detail))
    except Exception:
        job.update(status="failed", message="本机模型处理未完成，请检查模型状态或调整选区后重试。")
    finally:
        try:
            _write(core, job)
        finally:
            with _LOCK: _LIVE.discard(job["id"])
            _CAPACITY.release()


def create_job(core, store, payload):
    from .adapters import local_image_path
    workflow = store.get(safe_id(payload.get("workflowId")))
    revision = payload.get('expectedRevision')
    if isinstance(revision, bool) or not isinstance(revision, int) or revision != workflow["revision"]: fail("作品已有更新，请保存后再处理", 409)
    node = next((item for item in workflow["nodes"] if item["id"] == payload.get("nodeId")), None)
    if not node or node["type"] not in {"garment_split", "garment_flatten"}: fail("请选择分割或展平节点")
    operation = payload.get("operation")
    if operation not in ({"segment", "foreground"} if node["type"] == "garment_split" else {"flatten"}): fail("这个节点不支持所选操作")
    params = bounded_copy(payload.get("params", {}))
    if not isinstance(params, dict): fail('请提交服装处理参数对象')
    base, digest, binding, source_path, project = _source(core, workflow, node)
    local_image_path(core, base["imageUrl"])
    if not _CAPACITY.acquire(blocking=False): fail("本机已有多个处理任务，请等待当前任务结束", 429)
    job = {"id": "garment-" + uuid.uuid4().hex[:16], "workflowId": workflow["id"], "nodeId": node["id"],
           "operation": operation, "params": params, "sourceImageUrl": base["imageUrl"], "sourceHash": digest,
           'sourceBinding': binding,
           "status": "queued", "createdAt": now(), "message": "已加入本机处理队列。"}
    with _LOCK: _LIVE.add(job["id"])
    try:
        job['inputImageUrl'], job['inputHash'] = _snapshot_input(core, source_path, project, _folder(core) / job['id'])
        _write(core, job); _POOL.submit(_worker, core, copy.deepcopy(job))
    except Exception:
        with _LOCK: _LIVE.discard(job["id"])
        _CAPACITY.release(); raise
    return job


def adopt_artifact(core, workflow, node, payload):
    from .adapters import local_image_path
    job = get_job(core, payload.get("jobId"))
    if job["workflowId"] != workflow["id"] or job["nodeId"] != node["id"]: fail("候选不属于当前节点")
    if job["status"] != "completed": fail("请等候选处理完成后再采用")
    base, digest, binding, _, _ = _source(core, workflow, node)
    if digest != job["sourceHash"] or base["imageUrl"] != job["sourceImageUrl"] or binding != job.get('sourceBinding'): fail("上游图片或笔触已变化，请重新处理当前版本", 409)
    artifact = copy.deepcopy(job["artifact"])
    for key in ("imageUrl", "maskUrl", "croppedUrl", "previewUrl"):
        if artifact.get(key): local_image_path(core, artifact[key])
    old = node.get("output") or {}
    parts = old.get("parts", []) if old.get("sourceBinding") == binding else []
    new_parts = artifact.get("parts", [])
    parts = parts + [part for part in new_parts if part["id"] not in {item["id"] for item in parts}]
    chosen = next((part for part in parts if part.get("id") == payload.get("partId")), None)
    if payload.get('partId') and chosen is None: fail('所选部件不属于当前照片，请重新选择')
    url = (chosen or artifact).get("imageUrl")
    if payload.get("crop") is True: url = (chosen or artifact).get("croppedUrl") or url
    chosen_path = local_image_path(core, url)
    with Image.open(chosen_path) as image:
        width, height = image.size
    result = {**artifact, "kind": "garment", "imageUrl": url, "reference": {"url": url},
              "originalImageUrl": base.get("originalImageUrl"), "sourceImageUrl": base["imageUrl"],
              "sourceHash": digest, 'sourceBinding': binding, "parts": parts, "activePartId": (chosen or (new_parts[0] if new_parts else {})).get("id"),
              'width': width, 'height': height,
              "projectId": None, "projectSnapshot": None, "brushStrokes": [], "damageItems": [],
              "sourceBrushStrokes": [], "protectedRects": [], "rasterized": True, "editableStrokes": False,
              "imageSemantics": "raster_base", "coordinateSpace": "flat_reference" if node["type"] == "garment_flatten" else "cropped_part" if payload.get("crop") else "source_photo",
              "view": "flat_reference" if node["type"] == "garment_flatten" else "part", "jobId": job["id"], "apiRequest": False,
              "message": "已采用这份服装结果；可以继续接入精修、映射或协作节点。"}
    return result


def register_garment_job_routes(app, core):
    from . import garment_tools
    core.node_assistant_tools = garment_tools.assistant_tools()
    @app.get("/api/node-garments/capabilities")
    def capabilities(): return garment_tools.capabilities(core)
    @app.post("/api/node-garments/jobs")
    def start(payload: dict, request: Request):
        core.require_local_origin(request)
        store = app.state.node_studio_store
        with store.lock:
            return create_job(core, store, bounded_copy(payload))
    @app.get("/api/node-garments/jobs/{job_id}")
    def status(job_id: str): return get_job(core, job_id)

    @app.on_event("startup")
    def recover_interrupted_garment_jobs():
        # get_job already reports these as interrupted. Persist that state too,
        # so disk-based task guards and cleanup do not block forever after a
        # crash. Never interrupt a worker belonging to this running process.
        with _LOCK:
            root = Path(core.DATA).resolve()
            for path in (Path(core.DATA) / "node-studio" / "garment-jobs").glob("*.json"):
                if path.is_symlink() or not path.resolve().is_relative_to(root):
                    continue
                try:
                    job = json.loads(path.read_text(encoding="utf-8"))
                    if (isinstance(job, dict) and isinstance(job.get("status"), str) and job["status"] in {"queued", "running"}
                            and job.get("id") == path.stem and job["id"] not in _LIVE):
                        job.update(status="interrupted", message="上次本机任务已中断，可重新处理",
                                   updatedAt=now())
                        _write(core, job)
                except (OSError, ValueError, HTTPException):
                    # Unreadable records remain untouched; cleanup will keep
                    # their potentially shared assets conservatively.
                    continue
