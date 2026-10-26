"""Explicit bridges from a saved node to existing, real application tools.

Connecting/saving nodes never calls a model. Rule assistants identify their
provenance. Every generation delegates to the existing job pipeline and keeps
that pipeline's revision, pixel-protection and credential handling.
"""
from __future__ import annotations

import copy
import json
import math
import uuid
from pathlib import Path

from PIL import Image, ImageOps

from .catalog import BY_TYPE
from .graph import preceding_ids, branches_for, merge_for, merge_candidates, host_for
from .store import bounded_copy, fail, now, safe_id
from .text_inputs import text_input


def _nodes(workflow):
    return {node["id"]: node for node in workflow["nodes"]}


def _owner(workflow, identifier):
    for node in workflow["nodes"]:
        if identifier in node.get("attachments", {}).get("top", []) + node.get("attachments", {}).get("bottom", []):
            return node["id"]
    return None


def preceding_nodes(workflow, node):
    by_id = _nodes(workflow)
    return [by_id[identifier] for identifier in preceding_ids(workflow, node["id"])]


def input_node(workflow, node=None):
    """Return the nearest route input, never an unrelated project's garment."""
    by_id = _nodes(workflow)
    if node is None:
        return by_id.get(next(iter(workflow.get("order", [])), None))
    host = host_for(workflow, node["id"])
    scope = preceding_nodes(workflow, node) + ([host] if host else []) + [node]
    return next((entry for entry in reversed(scope) if entry["type"] in {"garment_input", "image_reference"}), None)


def garment_asset(workflow, node=None):
    garment = input_node(workflow, node)
    if not garment or garment["type"] != "garment_input":
        fail("当前路线需要真实服装输入；参考图不能作为实物或尺寸依据")
    params = (garment or {}).get("params", {})
    asset = params.get("front") or params.get("reference") or params.get("asset")
    if not asset and isinstance(params.get("references"), list) and params["references"]:
        asset = params["references"][0]
    if not asset and node is None:
        asset = next((entry for entry in workflow.get("assets", []) if entry.get("url")), None)
    if not isinstance(asset, dict) or not isinstance(asset.get("url"), str):
        fail("请先在服装输入中上传真实衣服正面照片")
    return bounded_copy(asset)


def reference_asset(node):
    params = node.get("params", {})
    references = params.get("references", [])
    index = params.get("activeReferenceIndex", 0)
    if (not isinstance(references, list) or not references or len(references) > 20
            or isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(references)):
        fail("请上传参考图片，并选择本路线使用的图片")
    asset = references[index]
    if not isinstance(asset, dict) or not isinstance(asset.get("url"), str):
        fail("参考素材须为上传记录")
    return bounded_copy(asset)


def local_image_path(core, url):
    if not isinstance(url, str) or any(char in url for char in ("?", "#", "\\")):
        fail("图片须来自本机平台中已上传或已生成的文件")
    for prefix, root in (("/data/", core.DATA), ("/resources/", core.RESOURCES)):
        if not url.startswith(prefix):
            continue
        root = Path(root).resolve()
        target = (root / url[len(prefix):]).resolve()
        if not target.is_relative_to(root) or not target.is_file() or target.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            break
        return target
    fail("本机图片引用已失效，请重新上传或选择已有结果")


def current_base(core, workflow, node):
    inherited = None
    scope = preceding_nodes(workflow, node)
    host = host_for(workflow, node["id"])
    if host:
        scope += [host]
    if node["type"] in {"garment_input", "image_reference"}:
        scope += [node]
    for preceding in scope:
        output = preceding.get("output") or {}
        if preceding["type"] in {"branch_create", "branch_merge", "intent_assist", "design_advice", "design_review"}:
            continue
        if preceding["type"] in {"garment_input", "image_reference"}:
            role = "garment" if preceding["type"] == "garment_input" else "reference"
            asset = garment_asset(workflow, preceding) if role == "garment" else reference_asset(preceding)
            local_image_path(core, asset["url"])
            inherited = {"imageUrl": asset["url"], "originalImageUrl": asset["url"],
                         "sourceRole": role, "sourceNodeId": preceding["id"]}
            inherited["garmentSource" if role == "garment" else "referenceSource"] = asset
            # An adopted assistant result on an input is usable, but only
            # while its binding still belongs to the currently selected photo.
            bound_url = output.get("originalImageUrl") or output.get("sourceImageUrl") or output.get("imageUrl")
            if bound_url != asset["url"]:
                continue
        if output.get("imageUrl"):
            local_image_path(core, output["imageUrl"])
            inherited = inherited or {"imageUrl": output["imageUrl"],
                "originalImageUrl": output.get("originalImageUrl") or output["imageUrl"],
                "sourceRole": "detached"}
            for key in ("imageUrl", "projectId", "view", "mappingId", "parts", "task"):
                if output.get(key) is not None:
                    inherited[key] = copy.deepcopy(output[key])
            inherited["sourceNodeId"] = preceding["id"]
    # A detached completed card can be reopened and extended without losing
    # its saved result. It does not inherit material claims from another root.
    if inherited is None and not scope and (node.get("output") or {}).get("imageUrl"):
        output = node["output"]
        local_image_path(core, output["imageUrl"])
        inherited = {key: copy.deepcopy(output[key]) for key in ("imageUrl", "projectId", "view", "mappingId", "parts", "task") if key in output}
        inherited.update(originalImageUrl=output.get("originalImageUrl") or output["imageUrl"],
                         sourceRole="detached", sourceNodeId=node["id"])
    if inherited is None:
        fail("当前路线没有图片，请连接服装输入或图片参考")
    return inherited


def context_for(workflow, node):
    result = copy.deepcopy(workflow.get("context", {}))
    result.setdefault("scene", {})
    result.setdefault("production", {})
    by_id = _nodes(workflow)
    relevant = preceding_nodes(workflow, node) + [node]
    # Project-start side conditions apply to later workspaces; a node's local
    # attachment is visited last and overrides that scope only.
    for entry in relevant:
        entries = [entry]
        for children in entry.get("attachments", {}).values():
            entries.extend(by_id[identifier] for identifier in children)
        for attached in entries:
            if attached["type"] == "scene_context":
                result["scene"].update(attached.get("params", {}))
            elif attached["type"] == "character_research":
                research = attached.get("params", {})
                character, scene = research.get("selectedCharacter"), research.get("selectedScene")
                if isinstance(character, dict) and isinstance(scene, dict) and scene.get("id"):
                    # An adopted scene belongs to the photo that was identified.
                    # Browsing new candidates must not silently re-label a different garment.
                    origin = input_node(workflow, attached)
                    current_url = ((reference_asset(origin) if origin["type"] == "image_reference"
                                    else garment_asset(workflow, origin)).get("url") if origin else None)
                    for prior in preceding_nodes(workflow, attached):
                        current_url = (prior.get("output") or {}).get("imageUrl") or current_url
                    owner_id = _owner(workflow, attached["id"])
                    if owner_id:
                        current_url = (_nodes(workflow)[owner_id].get("output") or {}).get("imageUrl") or current_url
                    adopted_url = research.get("adoptedSourceImageUrl")
                    if adopted_url and adopted_url != current_url:
                        continue
                    source_ids = scene.get("sourceIds", [])
                    source_ids = source_ids if isinstance(source_ids, list) else []
                    adopted = research.get("adoptedSources", [])
                    adopted = adopted if isinstance(adopted, list) else []
                    sources = [entry for entry in adopted
                               if isinstance(entry, dict) and entry.get("id") in source_ids]
                    result["scene"].update({
                        "character": character.get("name", ""), "ip": character.get("ip", ""),
                        "scene": scene.get("title", ""), "canonNotes": scene.get("summary", ""),
                        "designDirection": scene.get("designDirection", ""),
                        "canonStatus": scene.get("evidenceStatus", "unconfirmed"),
                        "sources": [entry.get("url") for entry in sources if entry.get("url")],
                        "researchSourceNodeId": attached["id"],
                        "researchSourceImageUrl": adopted_url,
                        "factBoundary": "来源支持角色背景；痕迹分布属于视觉设计推演，不代表原作确证。",
                    })
            elif attached["type"] == "production_context":
                result["production"].update(attached.get("params", {}))
    return result


def _image_as_upload(core, url, title):
    source = local_image_path(core, url)
    if url.startswith("/data/uploads/") and source.name == "image.png":
        identifier = source.parent.name
        safe_id(identifier)
        with Image.open(source) as image:
            size = image.size
        return {"id": identifier, "url": url, "width": size[0], "height": size[1], "originalName": title, "uploaded": True}
    # Generated results become a new immutable source, never overwrite the
    # user's garment input or a project owned by an earlier node.
    identifier = "upload-" + uuid.uuid4().hex[:16]
    folder = Path(core.DATA) / "uploads" / identifier
    folder.mkdir(parents=True, exist_ok=False)
    with Image.open(source) as image:
        if image.width * image.height > 24_000_000:
            fail("图片尺寸超过平台上限")
        image = ImageOps.exif_transpose(image).convert("RGBA")
        image.save(folder / "image.png")
    asset = {"id": identifier, "url": f"/data/uploads/{identifier}/image.png", "width": image.width,
             "height": image.height, "originalName": title, "uploaded": True, "sourceUrl": url, "createdAt": now()}
    core.write_json(folder / "upload.json", asset)
    return asset


def _text(value, maximum=4000):
    if value is None:
        return ""
    if isinstance(value, str):
        return value[:maximum]
    return json.dumps(value, ensure_ascii=False)[:maximum]


def _prompt(node, context, inherited_intent=None):
    params = node.get("params", {})
    scene, production = context.get("scene", {}), context.get("production", {})
    intent = inherited_intent if inherited_intent is not None else _text(params.get("intent") or params.get("prompt") or params.get("idea"))
    lines = ["保持真实服装廓形、人物身份、姿态、背景及关键装饰，只探索衣物战损外观。",
             "用户想法：" + (intent or "先提出一版清楚可辨、不过度堆叠的衣物战损方案。")]
    if scene:
        lines += ["用户指定的角色与场景：" + _text(scene),
                  "只有附带出处且已确认的信息才视为角色事实；其他内容属于用户选择的视觉推演。"]
    if production:
        lines.append("制作条件（未知项不作保证）：" + _text(production))
    if node["type"] == "region_generate":
        lines.append("只修改保存的局部选区，未选择区域和保护区域保持原图。")
    if node["type"] == "blend_create":
        lines.append("以指定基准保留真实衣物结构，按候选权重参考指定痕迹，不用透明叠图制造重影。")
    return "\n".join(lines)


def _task(core, workflow, node):
    params, context = node["params"], context_for(workflow, node)
    base = current_base(core, workflow, node)
    brief = text_input(workflow, node)
    if brief["stale"]:
        fail("上游文字已修改，请先更新对应节点的输出")
    task = {"type": node["type"], "intent": brief["combinedText"],
            "prompt": _prompt(node, context, brief["combinedText"]), "textSources": brief["sources"], "context": context, "preparedAt": now(),
            "apiRequest": False, "semanticAI": False}
    if node["type"] == "region_generate":
        regions = params.get("regions", [])
        if not isinstance(regions, list) or not regions or len(regions) > 20:
            fail("请先框选 1–20 个需要 AI 修改的区域")
        task["regions"] = [core.rect(region.get("rect", region)) for region in regions]
    if node["type"] == "blend_create":
        candidates = params.get("candidateIds", [])
        weights = params.get("weights", [])
        merge = merge_for(workflow, node)
        if merge:
            available = merge_candidates(workflow, merge)
            allowed = {candidate["nodeId"] for candidate in available}
            if not candidates:
                if len(available) > 3:
                    fail("合拢中有多个方案，请先选择其中 2–3 个进行融合")
                candidates = [candidate["nodeId"] for candidate in available]
                weights = [1 / len(candidates)] * len(candidates) if candidates else []
                params.update(candidateIds=candidates, weights=weights)
            if any(identifier not in allowed for identifier in candidates):
                fail("融合候选已不属于当前合拢，请从当前探索路线重新选择")
        else:
            # Earlier versions kept comparison candidates on the detached
            # shelf. Preserve those explicit references while preventing a
            # live sibling route from leaking into an unrelated branch.
            available = set(preceding_ids(workflow, node["id"])) | set(workflow.get("stash", []))
            if any(identifier not in available for identifier in candidates):
                fail("融合候选须来自当前路线的上游，其他路线请通过方案合拢连接")
        if not isinstance(candidates, list) or not 2 <= len(candidates) <= 3 or len(set(candidates)) != len(candidates):
            fail("融合创作请选择 2–3 个不同的已输出候选")
        if not isinstance(weights, list) or len(weights) != len(candidates):
            fail("每个融合候选须有对应权重")
        if any(isinstance(weight, bool) or not isinstance(weight, (float, int)) or not math.isfinite(weight) or not 0 <= weight <= 1 for weight in weights) or sum(weights) <= 0:
            fail("融合权重须为 0–1，且总和大于零")
        by_id = _nodes(workflow)
        images = []
        for identifier in candidates:
            candidate = by_id.get(identifier, {}).get("output") or {}
            if not candidate.get("imageUrl"):
                fail("融合候选尚无图片输出，请先运行并采用候选")
            local_image_path(core, candidate["imageUrl"])
            images.append(candidate["imageUrl"])
        base_id = params.get("baseNodeId") or candidates[0]
        if base_id not in candidates:
            fail("融合基准须为已选择的候选之一")
        task.update(candidateIds=candidates, candidateImages=images,
                    weights=[round(weight / sum(weights), 6) for weight in weights],
                    baseNodeId=base_id, effectScope=params.get("effectScope", "all"),
                    preciseSemanticInterpolation=False)
        features = params.get("featureSources", {})
        if not isinstance(features, dict) or set(features) - {"blood", "slash", "wear", "burn"} or any(value and value not in candidates for value in features.values()):
            fail("特征来源须为当前参与融合的候选")
        task["featureSources"] = copy.deepcopy(features)
        task["prompt"] += "\n融合偏好：" + _text({key: task[key] for key in ("candidateIds", "weights", "effectScope")})
        if features:
            task["prompt"] += "\n独立特征来源（优先于总体权重）：" + _text(features)
    return {**base, "kind": "generation_task", "task": task, "prompt": task["prompt"],
            "intent": task["intent"], "message": "任务已准备，尚未调用模型；连接图像生成节点后点击生成。",
            "apiRequest": False, "semanticAI": False}


def ensure_project(core, workflow, node, base, task=None):
    own_project_id = node.get("params", {}).get("projectId") or (node.get("output") or {}).get("projectId")
    # A generation is a fresh immutable attempt. Reusing its previous project
    # would silently keep an old prompt after upstream intent changes. Editing
    # workspaces may reopen their own saved project until inputs become stale.
    if own_project_id and node["type"] != "image_generate" and node.get("status") != "stale":
        return core.get_project(safe_id(own_project_id))
    context = context_for(workflow, node)
    production = context.get("production", {})
    source_project = None
    if base.get("projectId"):
        source_project = core.get_project(safe_id(base["projectId"]))
    payload = copy.deepcopy(source_project or {})
    for key in ("id", "revision", "version", "createdAt", "updatedAt", "previewUrl", "manualReview", "reviewedJobRevision"):
        payload.pop(key, None)
    reference = _image_as_upload(core, base["imageUrl"], workflow["title"])
    # A derived raster base must not silently apply strokes from a different
    # source twice. Editable inherited strokes stay when using the same source.
    if not source_project or (source_project.get("reference") or {}).get("url") != reference["url"]:
        payload.update(brushStrokes=[], damageItems=[], protectedRects=[], brushAllowedRegions=[])
        payload.pop("surfaceOptions", None)
    payload.update(title=workflow["title"] + " · " + node["label"], uploadId=reference["id"], reference=reference,
                   customDamageIdea=(task or {}).get("prompt") or _prompt(node, context),
                   reversibleRequired=production.get("reversibleRequired", "unknown"),
                   material=production.get("materialKind", "unknown"),
                   nodeStudioOrigin={"workflowId": workflow["id"], "nodeId": node["id"],
                                     "originalImageUrl": base.get("originalImageUrl") or base["imageUrl"],
                                     "sourceRole": base.get("sourceRole", "unknown"),
                                     "inputImageUrl": base["imageUrl"], "context": context})
    if task and task.get("regions"):
        payload["damageItems"] = [{"id": f"node-region-{i+1}", "type": "blood", "rect": region,
                                   "intensity": .65, "notes": task.get("intent", "局部外观修改")}
                                  for i, region in enumerate(task["regions"])]
    references = []
    by_id = _nodes(workflow)
    for entry in preceding_nodes(workflow, node) + [node]:
        for identifier in entry.get("attachments", {}).get("top", []):
            attachment = by_id[identifier]
            if attachment["type"] == "image_reference":
                references += attachment["params"].get("references", [])
    if references:
        reference_url = references[0].get("url") if isinstance(references[0], dict) else None
        if reference_url:
            local_image_path(core, reference_url)
            payload["conceptReference"] = {"url": reference_url}
    created = core.create_project(payload)
    # API convenience fields such as previewUrl are not persisted project
    # content; workers compare exact snapshots to detect concurrent edits.
    return core.get_project(created["id"])


class _CloudOverride:
    def __init__(self, original, params):
        self.original, self.params = original, params

    def __getattr__(self, name):
        return getattr(self.original, name)

    def credentials(self, provider=None):
        settings, secret = self.original.credentials(provider)
        changes = {key: self.params[key] for key in ("model", "quality") if self.params.get(key)}
        if changes:
            with self.original._LOCK:
                _, checked = self.original._candidate({"provider": settings["provider"], **changes})
            settings = {**settings, **{key: checked[key] for key in changes}}
        return settings, secret


class _CoreView:
    def __init__(self, core, params):
        self._core = core
        self.cloud_provider = _CloudOverride(core.cloud_provider, params)

    def __getattr__(self, name):
        return getattr(self._core, name)


def _generate(core, workflow, node, payload, request):
    params = node["params"]
    provider = params.get("provider") or payload.get("provider") or core.cloud_provider.public_settings().get("provider")
    local = provider == "local_openai" or params.get("mode") == "local"
    if not local and payload.get("confirmedExternal") is not True:
        fail("请明确确认调用在线图像接口；连接节点或保存配置不会自动生成，也不会扣费", 409)
    core.require_local_origin(request)
    base = current_base(core, workflow, node)
    preceding = preceding_nodes(workflow, node)
    last_merge = max((index for index, entry in enumerate(preceding) if entry["type"] == "branch_merge"), default=-1)
    last_task = max((index for index, entry in enumerate(preceding) if (entry.get("output") or {}).get("task")), default=-1)
    if last_merge > last_task:
        fail("当前合拢包含多个方案，请先接入融合创作并准备融合任务，再生成图片")
    brief = text_input(workflow, node)
    if brief["stale"]:
        fail("上游文字已修改，请先更新对应节点的输出，再生成图片", 409)
    if not brief["combinedText"] and params.get("mode") == "brush":
        brief["combinedText"] = "保留已保存笔触的位置与形态，将痕迹自然融合到服装的光影和材质中"
    if not brief["combinedText"]:
        fail("请连接想法整理的文字输出、准备创作任务，或填写本次补充")
    task = copy.deepcopy(brief["task"] or {"type": "quick_create"})
    task.update(prompt=_prompt(node, context_for(workflow, node), brief["combinedText"]),
                intent=brief["combinedText"], textSources=brief["sources"])
    if task and task.get("type") == "blend_create":
        index = task["candidateIds"].index(task["baseNodeId"])
        base["imageUrl"] = task["candidateImages"][index]
        candidate_output = _nodes(workflow)[task["baseNodeId"]].get("output") or {}
        if candidate_output.get("projectId"):
            base["projectId"] = candidate_output["projectId"]
        else:
            base.pop("projectId", None)
    project = ensure_project(core, workflow, node, base, task)
    source_id = task.get("baseNodeId") if task.get("type") == "blend_create" else base.get("sourceNodeId")
    source_output = (_nodes(workflow).get(source_id) or {}).get("output") or {}
    source_snapshot = source_output.get("projectSnapshot") or source_output.get("originalProjectSnapshot")
    source_snapshot = source_snapshot or project
    source_marks = source_output.get("brushStrokes") or source_output.get("sourceBrushStrokes") or source_snapshot.get("brushStrokes", [])
    generation_source = {"imageUrl": base["imageUrl"], "sourceNodeId": source_id,
                         "brushStrokes": copy.deepcopy(source_marks), "projectSnapshot": copy.deepcopy(source_snapshot)}
    view = _CoreView(core, params)
    from quick_draft import create_draft_job
    from brush_workflow import create_brush_job
    mode = params.get("mode", "draft")
    if task and task.get("type") == "blend_create":
        if mode == "local":
            fail("本机 SD1.5 区域接口不支持多图融合，请选择支持多参考图的图像接口")
        from .generation import blend_job
        paths = [local_image_path(core, url) for url in task["candidateImages"]]
        job = blend_job(core, view, project, provider, task, paths)
    elif mode == "local":
        if not project.get("damageItems"):
            fail("本机 SD1.5 路径需要先保存局部战损区域；整体初稿可使用本机兼容图像接口")
        job = core.create_job(project["id"], {"mode": "base_experiment", "projectRevision": project["revision"]}, request)
    elif mode == "brush":
        if not project.get("brushStrokes"):
            fail("当前方案没有已保存的精修笔触；请先完成绘制，或改选整体初稿")
        job = create_brush_job(view, project["id"], {"projectRevision": project["revision"], "provider": provider}, request)
    elif task and task.get("type") == "region_generate":
        from .generation import region_job
        job = region_job(core, view, project, provider)
    else:
        job = create_draft_job(view, project["id"], {"projectRevision": project["revision"], "provider": provider}, request)
    # A repeated attempt must not replace the displayed image with its upstream
    # input while queued, or lose the last successful image if the request fails.
    displayed = copy.deepcopy(node.get("output") or {})
    if not displayed.get("imageUrl"):
        displayed = copy.deepcopy(base)
    for key in ("candidateImageUrl", "candidateReference", "candidateBasedOnOlderInput", "requiresExplicitAdoption"):
        displayed.pop(key, None)
    # Display and provenance have different owners during an in-flight attempt:
    # keep the prior result intact, while capturing the source actually submitted.
    previous_output = copy.deepcopy(displayed.get("generationPreviousOutput") or displayed)
    for key in ("generationSource", "generationPreviousOutput"):
        previous_output.pop(key, None)
    return {**displayed, "kind": "generation_job", "projectId": project["id"], "projectRevision": project["revision"],
            "generationPreviousOutput": previous_output, "generationSource": generation_source,
            "jobId": job["id"], "jobStatus": job["status"], "jobUrl": f"/api/jobs/{job['id']}",
            "message": job.get("message", "任务已排队"), "apiRequest": not local,
            "status": "running", "contextSnapshot": context_for(workflow, node), "usage": job.get("usage")}


def _review(core, workflow, node):
    base, context = current_base(core, workflow, node), context_for(workflow, node)
    checks = [{"id": "real_garment", "label": "真实服装输入", "status": "present", "detail": "已保存本机图片，未判断服装或人物内容。"}]
    scene, production = context.get("scene", {}), context.get("production", {})
    for identifier, label, present, detail in [
        ("scene", "角色与场景", bool(scene.get("scene") or scene.get("character")), "未联网核实剧情；只检查是否填写。"),
        ("material", "材料依据", production.get("materialKind") not in (None, "unknown", ""), "照片不能确认纤维成分、可洗性或耐热性。"),
        ("protected", "保留范围", bool(scene.get("protectedNotes")), "需要用户对照照片确认徽记、扣件和关键结构。"),
        ("scale", "实际尺寸", bool(production.get("scaleConfirmed")), "制作模板前需要真实平铺定位与尺度。"),
    ]:
        checks.append({"id": identifier, "label": label, "status": "provided" if present else "needs_confirmation", "detail": detail})
    return {**base, "kind": "review", "title": "资料与制作条件检查", "checks": checks,
            "provider": "local_rules", "semanticAI": False, "visualInspection": False,
            "message": "本地条件核查：没有调用视觉 AI，不代表已判断还原度、自然程度或制作可行性。"}


def _guide(core, workflow, node):
    base, context = current_base(core, workflow, node), context_for(workflow, node)
    garment_asset(workflow, node)
    production = context.get("production", {})
    project = core.get_project(base["projectId"]) if base.get("projectId") else {"damageItems": [], "brushStrokes": []}
    steps = core.instructions(project)
    return {**base, "kind": "guide", "title": "制作辅助与小样记录", "provider": "local_craft_rules",
            "semanticAI": False, "physicalSimulation": False, "materialKind": production.get("materialKind", "unknown"),
            "steps": steps, "generalSteps": [
                {"title": "定位", "detail": "对照已确认效果与衣服部件，先用纸样标出范围，避开承重缝线、扣件和不可改区域。"},
                {"title": "做小样", "detail": "在同材质余料或可拆布片上分层试色；记录颜料、稀释比例、工具、喷洒距离与干燥后的变化。"},
                {"title": "逐步增加", "detail": "飞溅可先用牙刷或小喷壶在试样上控制方向与密度；浸染采用少量多次点染，干燥后再比较。"},
                {"title": "模拟磨损与焦边", "detail": "先用可拆贴片、抽丝与颜料表现；不从生成图片推断裁剪量、真实燃烧或结构强度。"},
                {"title": "确认再制作", "detail": "检查渗色、手感、固定、清洗与穿着活动；未知材料的可恢复性保持未确认。"}],
            "message": "这是依据已保存信息整理的规则建议，不是生成图片的材料效果预测。"}


def run_node(core, workflow, node, payload, request):
    kind, params = node["type"], node["params"]
    if kind in {"intent_assist", "design_advice", "design_review", "agent_execute"}:
        from .assistant_engine import run_assistant
        return run_assistant(core, workflow, node, payload, request)
    if kind in {"garment_split", "garment_flatten"}:
        from .garment_jobs import adopt_artifact
        return adopt_artifact(core, workflow, node, payload)
    if BY_TYPE[kind]["capability"] == "planned":
        return {"kind": "not_implemented", "implemented": False, "message": "该概念入口已保留，当前尚未接入真实运行能力。", "status": "planned"}
    if kind == "garment_input":
        asset = garment_asset(workflow, node)
        local_image_path(core, asset["url"])
        return {"kind": "garment", "imageUrl": asset["url"], "originalImageUrl": asset["url"],
                "front": asset, "back": params.get("back"), "flat": params.get("flat"), "view": "worn", "sourceRole": "garment",
                "message": "真实服装原图已保留；未执行自动识别或生成。", "apiRequest": False}
    if kind == "image_reference":
        references = params.get("references", [])
        if not isinstance(references, list) or len(references) > 20:
            fail("最多保留 20 张参考图片")
        if not references:
            return {"kind": "reference", "references": [], "activeReferenceIndex": 0,
                    "sourceRole": "reference", "apiRequest": False}
        for asset in references:
            if not isinstance(asset, dict):
                fail("参考素材须为上传记录")
            local_image_path(core, asset.get("url"))
        active = reference_asset(node)
        return {"kind": "reference", "imageUrl": active["url"], "originalImageUrl": active["url"], "references": references,
                "activeReferenceIndex": params.get("activeReferenceIndex", 0), "sourceRole": "reference",
                "message": "参考已保存，不作为真实衣物或尺寸依据。", "apiRequest": False}
    if kind in {"scene_context", "production_context", "character_research"}:
        return {**current_base(core, workflow, node), "kind": "context", "context": copy.deepcopy(params),
                "message": "设定已保存；既有图片保持原版，新操作采用当前条件。", "semanticAI": False}
    if kind == "branch_create":
        return {**current_base(core, workflow, node), "kind": "branches",
                "branches": [{"id": branch["id"], "label": branch["label"], "nodeCount": len(branch["order"])}
                             for branch in branches_for(workflow, node["id"])],
                "message": "各路线从同一份上游方案开始，修改互不覆盖。", "apiRequest": False}
    if kind == "branch_merge":
        candidates = merge_candidates(workflow, node)
        all_ids = {candidate["nodeId"] for candidate in merge_candidates(workflow, node, all_candidates=True)}
        if any(identifier not in all_ids for identifier in params.get("selectedCandidateIds", [])):
            fail("部分合拢候选已被新的路线结果替代，请重新选择")
        if len(candidates) < 2:
            fail("请先在至少两条路线保存图片结果，再合拢方案")
        for candidate in candidates:
            local_image_path(core, candidate["imageUrl"])
        return {"kind": "candidate_set", "candidates": candidates, "mergeNodeId": node["id"],
                "candidateIds": [candidate["nodeId"] for candidate in candidates],
                "baseImageUrl": current_base(core, workflow, node)["imageUrl"],
                "message": "多个方案已收集；接入融合创作后选择偏好，不会自动拼图或调用模型。", "apiRequest": False}
    if kind in {"quick_create", "region_generate", "blend_create"}:
        result = _task(core, workflow, node)
        if kind == "blend_create" and payload.get("blendAction") == "editable":
            from .blend_tools import blend_editable
            return blend_editable(core, workflow, node, result["task"])
        return result
    if kind == "image_generate":
        return _generate(core, workflow, node, payload, request)
    if kind in {"precision_edit", "flatten_map"}:
        base = current_base(core, workflow, node)
        if kind == "flatten_map":
            garment_asset(workflow, node)
        project = ensure_project(core, workflow, node, base)
        workspace = {"precision_edit": "brush", "garment_split": "regions", "flatten_map": "mapping"}[kind]
        return {**base, "kind": "workspace", "projectId": project["id"], "projectRevision": project["revision"],
                "workspace": workspace, "editorUrl": f"/?project={project['id']}#studio",
                "message": "已建立独立工作区，请在工作区完成修改并保存；尚未自动生成或自动展平。",
                "status": "ready", "apiRequest": False}
    if kind in {"gesture_simulation", "battle_simulation"}:
        return {**current_base(core, workflow, node), "kind": "experiment_workspace",
                "workspace": "gesture" if kind == "gesture_simulation" else "battle", "status": "ready",
                "experimental": True, "implemented": True, "physicalSimulation": False,
                "cameraRecognition": False, "apiRequest": False, "semanticAI": False,
                "cameraRecognitionAvailable": kind == "gesture_simulation", "meshHitRecordingAvailable": kind == "battle_simulation",
                "message": ("进入手势工作区，可点击开启本机手部识别，或使用鼠标触控创作。" if kind == "gesture_simulation"
                            else "进入三维服装实验台，旋转模型并挥刀记录实际表面命中；代理衣服尚未与照片配准。")}
    if kind == "production_guide":
        return _guide(core, workflow, node)
    if kind == "stencil_export":
        from .making_bridge import generate_kit
        return generate_kit(core, workflow, node)
    fail("节点执行器尚未登记", 501)
