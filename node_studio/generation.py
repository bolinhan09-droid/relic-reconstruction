"""Node-only image jobs using existing transports and result validation.

Workers receive captured non-secret settings and an in-memory credential. They
never retry a charged request and never persist that credential.
"""
from __future__ import annotations

import copy
import uuid

from fastapi import HTTPException

from .store import fail


def _settings(view, provider):
    try:
        public, secret = view.cloud_provider.credentials(provider)
    except (ValueError, view.cloud_provider.CloudError) as exc:
        fail(str(exc))
    return {key: public.get(key) for key in ("provider", "model", "quality", "region", "workspaceId", "baseUrl")}, secret


def _idle(core):
    active = [core.read_json(path) for path in (core.DATA / "jobs").glob("*/job.json")]
    if any(job and job.get("status") in {"queued", "running"} for job in active):
        fail("已有图像任务正在执行，请等待完成后再生成", 409)


def region_job(core, view, project, provider):
    settings, secret = _settings(view, provider)
    original = core.load_rgb(core.local_image(project))
    if core.editable_union(project, original.size).getbbox() is None:
        fail("可编辑范围全部被保护区覆盖，请调整选区")
    with core.LOCK:
        _idle(core)
        if core.get_project(project["id"])["revision"] != project["revision"]:
            fail("方案版本已经变化，请保存后再生成", 409)
        identifier = "job-node-region-" + uuid.uuid4().hex[:16]
        job = {"id": identifier, "projectId": project["id"], "projectRevision": project["revision"],
               "mode": "cloud_image_edit", "artifactKind": "costume", "provider": settings["provider"],
               "model": settings["model"], "quality": settings["quality"], "status": "queued", "progress": 0,
               "message": "局部图像任务已排队", "createdAt": core.now(), "updatedAt": core.now(),
               "steps": [], "validation": {"kind": "pixel_protection", "passed": None, "semanticAI": False}}
        core.write_json(core.DATA / "jobs" / identifier / "job.json", job)
        try:
            core.EXECUTOR.submit(core.generate_cloud, identifier, copy.deepcopy(project), settings, secret, "costume")
        except Exception:
            core.update_job(identifier, status="failed", message="任务未能启动，未调用图像接口。", completedAt=core.now())
        return job


def _blend_worker(core, identifier, project, settings, secret, paths, task):
    import manual_workflow as manual
    import quick_draft
    provider = core.cloud_provider
    folder = core.DATA / "jobs" / identifier
    try:
        source_path, raw_source, original = manual._source(core, project)
        working = original.copy()
        working.thumbnail((2048, 2048))
        images = [manual._png(working)]
        for path in paths:
            image = core.load_rgb(path)
            image.thumbnail((2048, 2048))
            images.append(manual._png(image))
        prompt = (task["prompt"] + "\n第一张是真实服装当前版本；后续图片按候选顺序提供外观参考。"
                  "只按指定权重与作用范围参考战损，不叠加重影，不替换第一张的人物身份、姿态、构图、衣服轮廓或背景。"
                  "权重表达用户偏好，不宣称数学准确的图像语义插值。\n")
        core.write_json(folder / "configuration.json", {**settings, "mode": "node_multi_reference_blend",
                        "prompt": prompt, "requestCount": 1, "automaticRetry": False, "inputImageCount": len(images),
                        "weights": task["weights"], "effectScope": task["effectScope"], "physicalSimulation": False,
                        "preciseSemanticInterpolation": False, "pixelProtectionVerified": False})
        core.write_json(folder / "project-snapshot.json", project)
        core.update_job(identifier, status="running", progress=.15, message="正在按候选偏好生成融合方案，本次只提交一个请求")
        content, metadata = provider.edit(images, prompt, None, settings, secret)
        if len(content) > quick_draft.MAX_OUTPUT_BYTES:
            raise provider.CloudError("融合结果超过图片大小上限；未再次调用接口。")
        generated = manual._decode(content)
        (folder / "api-output.png").write_bytes(manual._png(generated))
        final, receipt = quick_draft._aligned(generated, original)
        with core.LOCK:
            quick_draft._source_still_current(core, project, source_path, raw_source)
            result = quick_draft._save_result(core, folder, project, final, receipt)
            core.update_job(identifier, **result, usage=provider.safe_usage(metadata.get("usage", {})))
    except Exception as exc:
        message = str(exc) if isinstance(exc, provider.CloudError) else str(exc.detail) if isinstance(exc, HTTPException) else "融合任务未完成；平台没有自动重试，请检查图像接口。"
        core.update_job(identifier, status="failed", message=message, completedAt=core.now())


def blend_job(core, view, project, provider, task, paths):
    import quick_draft
    settings, secret = _settings(view, provider)
    if settings["provider"] == "qwen" and str(settings["model"]).startswith("qwen-image-3.0") and len(paths) + 1 > 3:
        fail("当前千问模型最多接收 3 张图；请选择两个候选，或改用支持更多参考图的图像模型。未发送请求。")
    with core.LOCK:
        _idle(core)
        identifier = "job-node-blend-" + uuid.uuid4().hex[:16]
        job = quick_draft._job(core, project, identifier, "node_multi_reference_blend", settings["provider"], settings["model"], settings["quality"])
        job["message"] = "多参考融合任务已排队；需要人工检查结果"
        job["preciseSemanticInterpolation"] = False
        core.write_json(core.DATA / "jobs" / identifier / "job.json", job)
        try:
            core.EXECUTOR.submit(_blend_worker, core, identifier, copy.deepcopy(project), settings, secret, paths, task)
        except Exception:
            core.update_job(identifier, status="failed", message="任务未能启动，未调用图像接口。", completedAt=core.now())
        return job
