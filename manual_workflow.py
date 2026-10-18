"""Offline handoff to a user-operated image website and validated image import.

This module never contacts an API, logs into an account, or identifies the
external generator from an uploaded image. Pixel protection is local only.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import re
import uuid
import warnings
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageChops, ImageDraw, ImageOps

KINDS = {"costume", "concept"}
MAX_PIXELS = 24_000_000


def _kind(value: str) -> str:
    if value not in KINDS:
        raise HTTPException(422, "结果类型须为 costume（服装效果）或 concept（概念参考）")
    return value


def _revision(value) -> int:
    if isinstance(value, bool) or not re.fullmatch(r"[1-9][0-9]{0,9}", str(value)):
        raise HTTPException(422, "请填写导出交接包时的方案版本号")
    return int(value)


def _json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")


def _png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _decode(content: bytes) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as source:
                if source.format not in {"PNG", "JPEG", "WEBP"}:
                    raise ValueError("format")
                if min(source.size) < 32 or source.width * source.height > MAX_PIXELS:
                    raise ValueError("dimensions")
                if getattr(source, "n_frames", 1) != 1:
                    raise ValueError("animation")
                source.verify()
            with Image.open(io.BytesIO(content)) as source:
                image = ImageOps.exif_transpose(source).convert("RGBA")
                image.load()
        white = Image.new("RGBA", image.size, "white")
        white.alpha_composite(image)
        return white.convert("RGB")
    except (ValueError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(422, "请选择有效的单张 PNG、JPEG 或 WebP，尺寸至少 32×32，不超过 2400 万像素") from exc


def _source(core, project: dict) -> tuple[Path, bytes, Image.Image]:
    path = core.local_image(project)
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise HTTPException(422, "原服装照片无法读取，请重新上传") from exc
    if len(content) > core.MAX_UPLOAD:
        raise HTTPException(413, "原服装照片不应超过 20 MB")
    return path, content, _decode(content)


def _concept_source(core, project: dict):
    reference = project.get("conceptReference")
    if not reference:
        return None
    url = reference.get("url") if isinstance(reference, dict) else reference
    if not isinstance(url, str):
        raise HTTPException(422, "概念参考引用格式不正确")
    if url.startswith("/resources/"):
        base, relative = core.RESOURCES, url[len("/resources/"):]
    elif url.startswith("/data/uploads/"):
        base, relative = core.DATA / "uploads", url[len("/data/uploads/"):]
    elif re.fullmatch(r"/data/jobs/[A-Za-z0-9_-]{1,100}/result\.png", url):
        base, relative = core.DATA / "jobs", url[len("/data/jobs/"):]
    else:
        raise HTTPException(422, "概念参考须为平台内已上传或已保存的图片")
    candidate = (base / relative).resolve()
    if not candidate.is_relative_to(base.resolve()) or not candidate.is_file():
        raise HTTPException(422, "概念参考已丢失或引用失效，请重新选择")
    try:
        content = candidate.read_bytes()
    except OSError as exc:
        raise HTTPException(422, "概念参考无法读取") from exc
    if len(content) > core.MAX_UPLOAD:
        raise HTTPException(413, "概念参考不应超过 20 MB")
    return _decode(content)


def _mask(core, project: dict, size: tuple[int, int]) -> Image.Image:
    items = core.damage_items(project.get("damageItems", []))
    protected = core.protected_rects(project.get("protectedRects", []))
    mask = Image.new("L", size, 0)
    for item in items:
        mask = ImageChops.lighter(mask, core.mask_for(item, protected, size))
    return mask


def _annotation(core, project: dict, original: Image.Image) -> Image.Image:
    output = original.copy()
    draw = ImageDraw.Draw(output)
    stroke = max(2, min(output.size) // 250)
    for index, item in enumerate(project.get("damageItems", []), 1):
        box = core.pixel_rect(item["rect"], *output.size)
        draw.rectangle((box[0], box[1], box[2] - 1, box[3] - 1), outline="#dc7060", width=stroke)
        draw.text((box[0] + stroke, box[1] + stroke), str(index).zfill(2), fill="#dc7060", font=core.font(max(14, stroke * 6)))
    for entry in project.get("protectedRects", []):
        box = core.pixel_rect(entry, *output.size)
        draw.rectangle((box[0], box[1], box[2] - 1, box[3] - 1), outline="#32a584", width=stroke)
    return output


def _readable(value) -> str:
    if isinstance(value, list):
        return "\n".join("- " + _readable(entry) for entry in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value or "未填写")


def _prompt(core, project: dict, kind: str, size: tuple[int, int], has_concept: bool) -> str:
    scene = core.scenario_for(project)
    character = next((c for c in core.catalog().get("characters", []) if c.get("id") == project.get("characterId")), {})
    facts = scene.get("verifiedClaims") or scene.get("verified_claims") or scene.get("canonFacts") or []
    sources = scene.get("sources") or scene.get("source_urls") or []
    lines = [
        "请为《遗迹重构》制作一张视觉方案图。不要输出讲解、标注框、水印或文字。",
        f"当前项目：{project.get('title', '未命名方案')}；角色：{character.get('name', '以参考图为准')}；版本：{project['revision']}。",
        f"请保持主图尺寸 {size[0]}×{size[1]}，相同视角、构图、镜头与服装比例；不要擅自裁切。",
    ]
    if kind == "costume":
        lines += [
            "第一张服装原图是必须保留的底图：只在编号战损区域内添加下面的痕迹。",
            "未标记区域及绿色保护区域保持原样，保留服装轮廓、颜色、徽章、扣件、刺绣、关键结构、背景与人物。",
            "可编辑区域二值图中白色允许修改，黑色保留。透明编辑蒙版中透明允许修改，不透明保留。标注图只用于识别位置，不能把框画进结果。",
            "即使网页模型不能精确遵守蒙版，也不要重构整件衣服；平台导回后只采用可编辑区域内的像素。",
        ]
        if has_concept:
            lines.append("第二张概念参考仅提供痕迹外观方向；不要把它的人物、背景、服装结构或视角替换到第一张实物服装上。")
    else:
        lines += [
            "制作一张完整的二维战损概念参考，以原服装的轮廓、配色、主要标识为基础；不生成3D模型或裁缝纸样。",
            "参考中的角色特征需保留；若只有平铺服装图，优先保持服装展示，不自行重构角色面部或体态。",
            "标注区域与强度用于表达设计方向；概念图不会按局部蒙版作像素保护，也不会自动替换实物底图。",
        ]
    lines += ["", "【剧情背景：已有资料所支持的事实】", _readable(facts),
              "情境：" + str(scene.get("title") or "用户自主设定"),
              "概述：" + str(scene.get("canonical_summary") or scene.get("summary") or "未填写"),
              "来源（平台已录入，未在本交接流程实时搜索或重新核实）：", _readable(sources),
              "", "【设计推演：不宣称以下痕迹是原作明确设定】",
              str(scene.get("damageEvidence") or "伤痕位置、形态、血液来源和程度为用户选择的效果推演，不是原作事实。")]
    for index, item in enumerate(project.get("damageItems", []), 1):
        rectangle = item["rect"]
        lines.append(f"{index:02d}. {core.TYPES[item['type']]}：位置 x={rectangle['x']:.3f}, y={rectangle['y']:.3f}, w={rectangle['w']:.3f}, h={rectangle['h']:.3f}；视觉编辑程度 {item['intensity']:.0%}；说明：{item.get('notes') or '以少量自然痕迹为主'}。")
    lines += ["用户补充：" + str(project.get("customDamageIdea") or "无"),
              "视觉编辑程度只表达轻重偏好，不代表破损面积比例、材料物理损伤或颜料用量。",
              "实际面料：" + str(project.get("material") or project.get("uploadMaterial") or core.garment_for(project).get("material") or "未知，须小样确认"),
              "这是外观预览，不推测布料的真实烧灼、渗色、强度、手感、可洗性或操作安全，也不替代材料小样。"]
    return "\n".join(lines) + "\n"


def build_handoff(core, project_id: str, kind: str = "costume") -> Response:
    kind = _kind(kind)
    with core.LOCK:
        project = copy.deepcopy(core.get_project(project_id))
        _, raw_source, original = _source(core, project)
        mask = _mask(core, project, original.size)
        if kind == "costume" and mask.getbbox() is None:
            raise HTTPException(422, "请先保存至少一处不被保护区域完全覆盖的战损区域")
        concept = _concept_source(core, project)
        prompt = _prompt(core, project, kind, original.size, concept is not None)
        transparent = Image.new("RGBA", original.size, (0, 0, 0, 255))
        transparent.putalpha(ImageOps.invert(mask))
        manifest = {"schemaVersion": "manual-handoff-1", "projectId": project_id, "projectRevision": project["revision"],
                    "artifactKind": kind, "createdAt": core.now(), "sourceSize": list(original.size),
                    "sourceSha256": hashlib.sha256(raw_source).hexdigest(), "project": project,
                    "semanticAI": False, "automaticAccountAccess": False, "apiRequest": False,
                    "maskMeaning": "editable-mask: white editable / black retained; transparent-mask: transparent editable / opaque retained",
                    "boundary": "网页结果能否遵守位置需人工确认；服装导回仅在本地保证非编辑区像素保留，概念图无此保证。"}
        readme = ("1. 解压后在 ChatGPT 网页手动上传 01_服装原图.png，按需要上传 02_概念参考.png、区域标注与蒙版。\n"
                  "2. 复制提示词.txt 发给图像生成功能。平台不会登录账号或发起 API 请求；网页可用额度以你的账号实际提示为准。\n"
                  "3. 下载生成的单张图片，回到平台按相同类型导入，并使用交接记录里的项目版本号。\n"
                  "4. 若导出后修改过项目，请重新导出并生成；旧版本结果将被拒绝。\n"
                  "5. 服装结果只合成可编辑区域，导回时尺寸不一致会明确记录缩放；必须检查区域边界、角色还原和整体视觉。\n"
                  "6. 概念图独立保存，需你明确采用后才成为后续参考。所有结果都不预测实际材料表现；先做小样。\n")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("01_服装原图.png", _png(original))
            if concept is not None:
                archive.writestr("02_概念参考.png", _png(concept))
            archive.writestr("03_区域标注.png", _png(_annotation(core, project, original)))
            archive.writestr("04_可编辑区域.png", _png(mask))
            archive.writestr("05_透明编辑蒙版.png", _png(transparent))
            archive.writestr("提示词.txt", prompt.encode("utf-8-sig"))
            archive.writestr("交接记录.json", _json_bytes(manifest))
            archive.writestr("操作说明.txt", readme.encode("utf-8-sig"))
    return Response(output.getvalue(), media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{project_id}-revision-{project["revision"]}-{kind}-handoff.zip"',
        "X-Project-Revision": str(project["revision"]), "X-Artifact-Kind": kind,
        "Cache-Control": "no-store"})


async def import_result(core, project_id: str, file: UploadFile, project_revision, kind: str = "costume") -> dict:
    try:
        kind, revision = _kind(kind), _revision(project_revision)
        with core.LOCK:
            snapshot = copy.deepcopy(core.get_project(project_id))
            if snapshot["revision"] != revision:
                raise HTTPException(409, "方案已修改；请使用原交接版本，或重新导出当前版本后生成，不能将旧图认作新版本")
            source_path, raw_source, original = _source(core, snapshot)
            _concept_source(core, snapshot)
            editable = _mask(core, snapshot, original.size)
            if kind == "costume" and editable.getbbox() is None:
                raise HTTPException(422, "当前方案没有可编辑区域，请先保存战损位置")
        content = await file.read(core.MAX_UPLOAD + 1)
        if len(content) > core.MAX_UPLOAD:
            raise HTTPException(413, "导入图片不应超过 20 MB")
        generated = _decode(content)
        imported_size = generated.size
        if kind == "costume":
            resized = generated.size != original.size
            if resized:
                generated = generated.resize(original.size, Image.Resampling.LANCZOS)
            final = Image.composite(generated, original, editable)
            difference = ImageChops.difference(original, final)
            intact = Image.composite(difference, Image.new("RGB", original.size), ImageOps.invert(editable)).getbbox() is None
            if not intact:
                raise HTTPException(500, "非编辑区域像素保护检查未通过，未保存结果")
            validation = {"kind": "pixel_protection", "passed": True, "outsideMaskUnchanged": True,
                          "protectedRegionsUnchanged": True, "semanticAI": False,
                          "message": "已在本地将网页图片合成到允许区域，非编辑区域（含保护区）与原图像素一致。未验证生成来源、痕迹质量或角色还原。"}
        else:
            final, resized = generated, False
            validation = {"kind": "concept_manual_review", "passed": None, "semanticAI": False,
                          "message": "概念图独立保存，尚未人工确认；没有局部像素保护，不自动成为服装底图。"}
        with core.LOCK:
            current = core.get_project(project_id)
            if current["revision"] != revision or current != snapshot:
                raise HTTPException(409, "读取图片期间方案已修改，请重新导出并生成；结果未保存")
            _, latest_source, _ = _source(core, current)
            if latest_source != raw_source or core.local_image(current).resolve() != source_path.resolve():
                raise HTTPException(409, "原服装图片已变化，请重新导出并生成；结果未保存")
            job_id = "job-manual-" + uuid.uuid4().hex[:16]
            folder = core.DATA / "jobs" / job_id
            result_url = core.data_url(folder / "result.png")
            receipt = {"inputSize": list(imported_size), "sourceSize": list(original.size), "outputSize": list(final.size),
                       "resizedToSource": resized, "compositedLocally": kind == "costume",
                       "editableMaskApplied": kind == "costume", "externalProviderVerified": False,
                       "message": ("网页图片尺寸与原图不同，已缩放到原图尺寸后按允许区域合成，请检查痕迹比例与边界。" if resized
                                   else "服装图按允许区域合成，非编辑区保留原图。" if kind == "costume"
                                   else "概念图按导入尺寸保存，不进行像素保护。")}
            job = {"id": job_id, "projectId": project_id, "projectRevision": revision, "artifactKind": kind,
                   "mode": "manual_external_import", "provider": "manual_external_import", "model": None,
                   "generatedBy": "manual_external_image", "externalProviderVerified": False,
                   "status": "succeeded", "progress": 1., "message": "手动图片已导入，请人工检查效果与角色还原",
                   "createdAt": core.now(), "updatedAt": core.now(), "completedAt": core.now(), "steps": [],
                   "previewUrl": result_url, "outputUrl": result_url, "result": {"url": result_url},
                   "validation": validation, "importReceipt": receipt, "semanticAI": False}
            if kind == "concept":
                job["resultingReference"] = {"url": result_url, "width": final.width, "height": final.height,
                                             "generated": True, "jobId": job_id, "source": "manual_external_import",
                                             "externalProviderVerified": False}
            folder.mkdir(parents=True, exist_ok=False)
            (folder / "original.png").write_bytes(_png(original))
            (folder / "imported-image.png").write_bytes(_png(_decode(content)))
            (folder / "mask.png").write_bytes(_png(editable))
            (folder / "result.png").write_bytes(_png(final))
            core.write_json(folder / "project-snapshot.json", snapshot)
            core.write_json(folder / "validation.json", validation)
            core.write_json(folder / "operation-guide.json", core.instructions(snapshot))
            core.write_json(folder / "configuration.json", {
                "mode": "manual_external_import", "artifactKind": kind, "provider": "manual_external_import",
                "model": None, "externalProviderVerified": False, "automaticAccountAccess": False,
                "apiRequest": False, "sourceSha256": hashlib.sha256(raw_source).hexdigest(),
                "importedSha256": hashlib.sha256(content).hexdigest(), "projectRevision": revision,
                "originalFileName": Path(file.filename or "imported-image").name[:200], "importReceipt": receipt})
            core.write_json(folder / "job.json", job)
            return job
    finally:
        await file.close()


def _require_local(core, request: Request):
    guard = getattr(core, "require_local_origin", None)
    if callable(guard):
        return guard(request, require_json=False)
    # Standalone registration must not weaken the local write boundary.
    if not request.client or request.client.host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(403, "手动导入仅允许本机访问")
    if urlsplit("http://" + request.headers.get("host", "")).hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(403, "访问地址须为本机平台")
    origin = request.headers.get("origin")
    if origin and origin != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "不能从其他网页跨站导入图片")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "不能从其他网页跨站导入图片")


def register_manual_routes(app, core=None):
    if core is None:
        import importlib
        core = importlib.import_module("app")

    @app.get("/api/projects/{project_id}/handoff")
    def manual_handoff(project_id: str, kind: str = "costume"):
        return build_handoff(core, project_id, kind)

    @app.post("/api/projects/{project_id}/import-result")
    async def manual_import(request: Request, project_id: str, file: UploadFile = File(...),
                            projectRevision: str = Form(...), kind: str = Form("costume")):
        try:
            _require_local(core, request)
        except Exception:
            await file.close()
            raise
        return await import_result(core, project_id, file, projectRevision, kind)

