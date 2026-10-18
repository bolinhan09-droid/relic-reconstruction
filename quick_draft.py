"""Whole-photo visual drafts, distinct from verified local region composites.

No automatic retry, no automatic adoption, no claim of segmentation or pixel
protection. A successful job means an image was saved, not approved for making.
"""
from __future__ import annotations

import copy
import hashlib
import io
import uuid
import zipfile
from pathlib import Path

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from PIL import Image

import manual_workflow as manual

SETTING_FIELDS = ("provider", "model", "quality", "region", "workspaceId", "baseUrl")
MAX_OUTPUT_BYTES = 48 * 1024 * 1024


def draft_prompt(core, project: dict, size: tuple[int, int], has_reference: bool) -> str:
    lines = [
        "编辑第一张真实 Cos 服装照片，提出一版完整的衣物战损外观初稿。生成单张图片，不输出说明、拼图、框、编号或文字。",
        f"保持原图 {size[0]}×{size[1]} 的构图、视角、朝向和宽高比例，不裁切、不换背景。",
        "默认程度为中等且醒目：正常观看整套服装时能清楚看见战损，但保留角色服装的原有廓形、主配色、关键图案、徽章、扣件和层次。",
        "血迹为衣物表面的戏剧假血：干燥暗红、哑光，有节制地分布，不湿亮、不滴落流淌，不把衣服整片涂红。",
        "刀割痕应为清楚可辨的裂口，少量自然毛边，布料断口具有方向和层次；不要只画浅线，不重构整件衣服。",
        "由你根据第一张服装的结构提出痕迹位置、范围与搭配。初稿没有局部蒙版，不把任何区域称为已经识别或精确保护。",
        "若原图有人，保持人物身份、脸部、皮肤、姿态与服装穿戴关系；不在人体上增加伤口或流血。若是平铺服装，不添加人物。",
    ]
    if has_reference:
        lines.append("第二张二维参考仅提供用户选择的痕迹与外观方向，不把其中的人物、背景、体型、服装结构或镜头替换到第一张实物照片。")
    if project.get("scenarioId"):
        scene = core.scenario_for(project)
        facts = scene.get("verifiedClaims") or scene.get("canonFacts") or []
        lines += ["用户已选择的情境：" + str(scene.get("title") or "用户选择的故事情境"),
                  "已有资料支持的背景：" + manual._readable(facts),
                  "痕迹位置与程度属于视觉设计推演，不宣称是原作明确描写。"]
    else:
        lines.append("用户尚未指定剧情或角色背景。以照片为准，不自动套用乌尔比安或任何其他角色的故事，不自行宣称原作事实。")
    lines += ["用户补充的视觉偏好：" + str(project.get("customDamageIdea") or "未补充，按以上默认方向提案。")[:4000],
              "这是整体外观初稿，不是材料物理模拟、可执行裁剪纸样或制作验收。面料渗色、破口强度、手感、恢复及清洗表现不能从图像判断。"]
    return "\n".join(lines) + "\n"


def _validation() -> dict:
    return {"kind": "draft_review", "passed": None, "semanticAI": False,
            "pixelProtectionVerified": False, "outsideMaskUnchanged": None,
            "protectedRegionsUnchanged": None, "physicalSimulation": False,
            "message": "整体初稿已保存，尚未验收。没有局部蒙版或像素保护；角色、人物、服装结构与痕迹自然程度均须人工检查，不代表制作完成。"}


def _aligned(generated: Image.Image, original: Image.Image) -> tuple[Image.Image, dict]:
    deviation = abs((generated.width / generated.height) / (original.width / original.height) - 1)
    if deviation > .05:
        raise HTTPException(422, "初稿宽高比与原图差异超过 5%，无法可靠对照。请生成同一构图与比例的单张图片后再导回。")
    resized = generated.size != original.size
    final = generated.resize(original.size, Image.Resampling.LANCZOS) if resized else generated.copy()
    receipt = {"inputSize": list(generated.size), "sourceSize": list(original.size),
               "outputSize": list(final.size), "aspectRatioDeviation": deviation,
               "resizedToSource": resized, "compositedLocally": False, "editableMaskApplied": False,
               "pixelProtectionVerified": False,
               "message": ("初稿比例在容差内，已缩放到原图尺寸便于对照；没有恢复或保护任何局部像素。" if resized
                           else "初稿与原图尺寸一致；没有局部像素保护，需人工对照检查。")}
    return final, receipt


def _source_still_current(core, project: dict, source_path: Path, raw_source: bytes):
    current = core.get_project(project["id"])
    if current.get("revision") != project.get("revision") or current != project:
        raise HTTPException(409, "方案已经修改，不能把先前版本的初稿认作当前结果。请重新生成或恢复对应方案。")
    current_path, current_raw, _ = manual._source(core, current)
    if current_path.resolve() != source_path.resolve() or current_raw != raw_source:
        raise HTTPException(409, "服装原图已变化，初稿不能保存为当前结果。请重新生成。")


def _job(core, project: dict, job_id: str, mode: str, provider: str, model=None, quality=None) -> dict:
    return {"id": job_id, "projectId": project["id"], "projectRevision": project["revision"],
            "artifactKind": "draft", "mode": mode, "provider": provider, "model": model, "quality": quality,
            "generatedBy": "manual_external_image" if mode == "manual_draft_import" else provider + "_image_api",
            "status": "queued", "progress": 0., "message": "整体初稿已排队", "steps": [],
            "createdAt": core.now(), "updatedAt": core.now(), "validation": _validation(),
            "physicalSimulation": False, "semanticAI": False}


def _save_result(core, folder: Path, project: dict, final: Image.Image, receipt: dict) -> dict:
    (folder / "result.png").write_bytes(manual._png(final))
    validation = _validation()
    core.write_json(folder / "validation.json", validation)
    url = core.data_url(folder / "result.png")
    return {"status": "succeeded", "progress": 1., "completedAt": core.now(),
            "message": "整体初稿已返回，请先比较外观，再选择需要精细调整的部位。", "outputUrl": url,
            "previewUrl": url, "result": {"url": url, "width": final.width, "height": final.height},
            "validation": validation, "importReceipt": receipt,
            "resultingReference": {"url": url, "width": final.width, "height": final.height,
                                   "generated": True, "jobId": folder.name, "artifactKind": "draft", "requiresExplicitAdoption": True}}


def build_draft_handoff(core, project_id: str) -> Response:
    with core.LOCK:
        project = copy.deepcopy(core.get_project(project_id))
        _, raw_source, original = manual._source(core, project)
        reference = manual._concept_source(core, project)
        prompt = draft_prompt(core, project, original.size, reference is not None)
    instructions = (f"项目：{project['id']}\n方案版本：{project['revision']}\n"
                    f"原图 SHA256：{hashlib.sha256(raw_source).hexdigest()}\n\n"
                    "1. 解压，在 ChatGPT 网页上传 01_服装原图.png，可选上传 02_二维参考.png。复制提示词.txt 后生成一张图。\n"
                    "2. 本包不含区域蒙版；由模型提案整体战损分布。平台不会登录账号、调用 API 或消耗 API 额度，网页额度以你的账号提示为准。\n"
                    "3. 下载图片后在平台导回整体初稿。必须对应以上项目版本；修改方案后应重新下载生成包并生图。\n"
                    "4. 导回时宽高比与原图差异超过 5% 会被拒绝；其他尺寸差异会缩放并记录。没有局部像素保护。\n"
                    "5. 初稿只供视觉比较，不自动替换原图，不代表材料效果、已完成制作或人工验收。看图选择部位后再进入精细调整。\n")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("01_服装原图.png", manual._png(original))
        if reference is not None:
            archive.writestr("02_二维参考.png", manual._png(reference))
        archive.writestr("提示词.txt", prompt.encode("utf-8-sig"))
        archive.writestr("操作说明.txt", instructions.encode("utf-8-sig"))
    return Response(output.getvalue(), media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{project_id}-revision-{project["revision"]}-draft-handoff.zip"',
        "X-Project-Revision": str(project["revision"]), "X-Artifact-Kind": "draft", "Cache-Control": "no-store"})


async def import_draft(core, project_id: str, file: UploadFile, project_revision) -> dict:
    try:
        revision = manual._revision(project_revision)
        with core.LOCK:
            project = copy.deepcopy(core.get_project(project_id))
            if project["revision"] != revision:
                raise HTTPException(409, "方案版本已经变化，请重新下载生成包并生图；不能把旧初稿认作新版本。")
            source_path, raw_source, original = manual._source(core, project)
            manual._concept_source(core, project)
        content = await file.read(core.MAX_UPLOAD + 1)
        if len(content) > core.MAX_UPLOAD:
            raise HTTPException(413, "导回初稿不应超过 20 MB")
        generated = manual._decode(content)
        final, receipt = _aligned(generated, original)
        receipt["externalProviderVerified"] = False
        with core.LOCK:
            _source_still_current(core, project, source_path, raw_source)
            job_id = "job-draft-manual-" + uuid.uuid4().hex[:16]
            folder = core.DATA / "jobs" / job_id
            folder.mkdir(parents=True, exist_ok=False)
            (folder / "original.png").write_bytes(manual._png(original))
            (folder / "imported-image.png").write_bytes(manual._png(generated))
            core.write_json(folder / "project-snapshot.json", project)
            core.write_json(folder / "configuration.json", {"artifactKind": "draft", "mode": "manual_draft_import",
                "provider": "manual_external_import", "model": None, "automaticAccountAccess": False,
                "apiRequest": False, "externalProviderVerified": False, "sourceSha256": hashlib.sha256(raw_source).hexdigest(),
                "importedSha256": hashlib.sha256(content).hexdigest(), "projectRevision": revision,
                "originalFileName": Path(file.filename or "draft-image").name[:200], "importReceipt": receipt,
                "physicalSimulation": False, "pixelProtectionVerified": False})
            job = _job(core, project, job_id, "manual_draft_import", "manual_external_import")
            job.update(_save_result(core, folder, project, final, receipt), externalProviderVerified=False, updatedAt=core.now())
            core.write_json(folder / "job.json", job)
            return job
    finally:
        await file.close()


def _generate_draft(core, job_id: str, project: dict, settings: dict, key: str,
                    source_path: Path, raw_source: bytes, original: Image.Image, reference):
    folder = core.DATA / "jobs" / job_id
    provider = core.cloud_provider
    try:
        core.update_job(job_id, status="running", progress=.08, message="正在整理服装照片，生成整体战损初稿")
        working = original.copy()
        working.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
        images = [manual._png(working)]
        if reference is not None:
            reference = reference.copy()
            reference.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            images.append(manual._png(reference))
        prompt = draft_prompt(core, project, original.size, reference is not None)
        configuration = {**settings, "artifactKind": "draft", "mode": "cloud_costume_draft", "prompt": prompt,
                         "requestCount": 1, "inputImageCount": len(images), "serverMask": False,
                         "automaticRetry": False, "pixelProtectionVerified": False, "physicalSimulation": False,
                         "projectRevision": project["revision"], "sourceSha256": hashlib.sha256(raw_source).hexdigest()}
        core.write_json(folder / "configuration.json", configuration)
        core.write_json(folder / "project-snapshot.json", project)
        (folder / "original.png").write_bytes(manual._png(original))
        core.update_job(job_id, progress=.15, message="图像服务正在生成初稿，本次仅提交一个生成请求")
        content, metadata = provider.edit(images, prompt, None, settings, key)
        if len(content) > MAX_OUTPUT_BYTES:
            raise provider.CloudError("接口初稿图片超过平台大小限制，未再次调用接口。")
        generated = manual._decode(content)
        (folder / "api-output.png").write_bytes(manual._png(generated))
        safe_metadata = {name: metadata.get(name) for name in ("provider", "model", "quality", "requestId", "usage", "baseUrl")
                         if name in metadata}
        core.write_json(folder / "generation-source.json", {**safe_metadata, "artifactKind": "draft", "generatedAt": core.now(),
                        "requestCount": 1, "serverMask": False, "physicalSimulation": False})
        final, receipt = _aligned(generated, original)
        with core.LOCK:
            _source_still_current(core, project, source_path, raw_source)
            updates = _save_result(core, folder, project, final, receipt)
            core.update_job(job_id, **updates, usage=provider.safe_usage(metadata.get("usage", {})))
    except Exception as exc:
        if isinstance(exc, provider.CloudError):
            message = str(exc)
        elif isinstance(exc, HTTPException):
            message = str(exc.detail)
        else:
            message = "整体初稿未完成，请检查图片与图像服务设置；平台未自动重试。"
        core.update_job(job_id, status="failed", message=message, error=message, completedAt=core.now(),
                        validation=_validation())


def create_draft_job(core, project_id: str, payload: dict, request: Request) -> dict:
    core.require_local_origin(request)
    if not isinstance(payload, dict):
        raise HTTPException(422, "请提交当前方案版本")
    revision = manual._revision(payload.get("projectRevision"))
    with core.LOCK:
        project = copy.deepcopy(core.get_project(project_id))
        if project["revision"] != revision:
            raise HTTPException(409, "方案已经修改，请先保存并刷新当前版本再生成初稿")
        source_path, raw_source, original = manual._source(core, project)
        reference = manual._concept_source(core, project)
        active = [core.read_json(path) for path in (core.DATA / "jobs").glob("*/job.json")]
        if any(job and job.get("status") in ("queued", "running") for job in active):
            raise HTTPException(409, "已有图像任务正在执行，请等待完成后再生成")
        try:
            public, key = core.cloud_provider.credentials(payload.get("provider"))
        except (ValueError, core.cloud_provider.CloudError) as exc:
            raise HTTPException(422, str(exc)) from None
        settings = {name: public.get(name) for name in SETTING_FIELDS}
        job_id = "job-draft-" + uuid.uuid4().hex[:16]
        job = _job(core, project, job_id, "cloud_costume_draft", settings["provider"], settings["model"], settings["quality"])
        core.write_json(core.DATA / "jobs" / job_id / "job.json", job)
        try:
            core.EXECUTOR.submit(_generate_draft, core, job_id, project, settings, key, source_path, raw_source, original, reference)
        except Exception:
            core.update_job(job_id, status="failed", message="初稿任务未能启动，未调用图像服务，请稍后再试。", completedAt=core.now())
        return job


def register_draft_routes(app, core):
    @app.post("/api/projects/{project_id}/draft-jobs")
    def draft_jobs(request: Request, project_id: str, payload: dict):
        return create_draft_job(core, project_id, payload, request)

    @app.get("/api/projects/{project_id}/draft-handoff")
    def draft_handoff(project_id: str):
        return build_draft_handoff(core, project_id)

    @app.post("/api/projects/{project_id}/import-draft")
    async def draft_import(request: Request, project_id: str, file: UploadFile = File(...),
                           projectRevision: str = Form(...)):
        try:
            manual._require_local(core, request)
        except Exception:
            await file.close()
            raise
        return await import_draft(core, project_id, file, projectRevision)
