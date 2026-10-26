"""Delete one local work and only assets proved unused by other saved work.

The reference graph includes workflow history, legacy project records, completed
jobs and assistant runs. Unreadable metadata makes collection conservative.
Model files, settings, arbitrary URL paths and unknown caches are never swept.
"""
from __future__ import annotations

import json
import os
import re
import stat
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path

from .store import fail, safe_id

_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
_ACTIVE = {"queued", "running", "starting", "processing"}
_ASSET_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".dxf", ".pdf", ".zip"}
_MAX_FILES = 100_000
_MAX_JSON_BYTES = 24 * 1024 * 1024
_JOB_PREFIXES = ("jobs/", "surface-jobs/", "flatlay-jobs/", "node-studio/garment-jobs/")


def _reparse(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _checked(root, path):
    """Check lexical containment and every existing ancestor before resolution."""
    root, path = Path(root).absolute(), Path(path).absolute()
    try:
        relative = path.relative_to(root)
    except ValueError:
        fail("清理路径不属于当前工作区", 422)
    if ".." in relative.parts or path == root:
        fail("不能清理工作区根目录", 422)
    current = root
    if _reparse(current):
        fail("工作区使用了链接目录，未执行文件清理", 409)
    for part in relative.parts:
        current = current / part
        if current.exists() or current.is_symlink():
            if _reparse(current):
                fail("清理目标含链接目录或文件，原文件已保留", 409)
    if not path.resolve().is_relative_to(root.resolve()):
        fail("清理目标超出工作区", 422)
    return path


def _files(root, folder):
    """Do not traverse symlinks or Windows junctions, including nested ones."""
    _checked(root, folder)
    result, stack = [], [folder]
    while stack:
        current = stack.pop()
        for path in current.iterdir():
            _checked(root, path)
            if path.is_dir():
                stack.append(path)
            elif path.is_file():
                result.append(path)
            if len(result) + len(stack) > _MAX_FILES:
                fail("作品记录较多，本次没有自动清理素材", 409)
    return result


@dataclass
class Unit:
    key: str
    files: list = field(default_factory=list)
    records: list = field(default_factory=list)
    references: set = field(default_factory=set)
    unsafe: bool = False


def _unit_key(parts):
    if len(parts) >= 2 and parts[0] in {"uploads", "projects", "jobs", "surface-jobs", "flatlay-jobs", "garment-tools"} and _ID.fullmatch(parts[1]):
        return "/".join(parts[:2]).casefold()
    if len(parts) >= 3 and parts[0] == "node-studio":
        kind, identifier = parts[1], parts[2]
        if kind == "garment-jobs" and identifier.endswith(".json"):
            identifier = identifier[:-5]
        if kind in {"workflows", "assistant-runs", "exports", "garment-jobs"} and _ID.fullmatch(identifier):
            return "/".join(["node-studio", kind, identifier]).casefold()
    return None


def _references(value):
    result = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"projectId", "uploadId", "targetUploadId", "jobId", "analysisId", "flatlayJobId"} and isinstance(item, str) and _ID.fullmatch(item):
                prefix = {"projectId": "projects", "uploadId": "uploads", "targetUploadId": "uploads",
                          "jobId": "jobs", "analysisId": "surface-jobs", "flatlayJobId": "flatlay-jobs"}[key]
                if key == "jobId" and item.startswith("garment-"):
                    prefix = "node-studio/garment-jobs"
                result.add((prefix + "/" + item).casefold())
            result.update(_references(item))
    elif isinstance(value, list):
        for item in value:
            result.update(_references(item))
    elif isinstance(value, str) and value.startswith("/data/"):
        relative = value[6:]
        if not any(char in relative for char in ("\\", "?", "#", "\x00", "%")):
            parts = relative.split("/")
            if all(part not in {"", ".", ".."} for part in parts):
                key = _unit_key(parts)
                if key:
                    result.add(key)
    return result


def _owns(value, workflow_id):
    if not isinstance(value, dict):
        return False
    origin, binding = value.get("nodeStudioOrigin"), value.get("binding")
    return (value.get("workflowId") == workflow_id
            or isinstance(origin, dict) and origin.get("workflowId") == workflow_id
            or isinstance(binding, dict) and binding.get("workflowId") == workflow_id)


def _inventory(root):
    units, uncertain = {}, False
    bases = [root / name for name in ("uploads", "projects", "jobs", "surface-jobs", "flatlay-jobs", "garment-tools")]
    bases += [root / "node-studio" / name for name in ("workflows", "assistant-runs", "exports", "garment-jobs")]
    total = 0
    for base in bases:
        if not base.exists():
            continue
        try:
            _checked(root, base)
        except Exception:
            uncertain = True
            continue
        for path in base.iterdir():
            key = _unit_key(path.relative_to(root).parts)
            if not key:
                continue
            unit = units.setdefault(key, Unit(key))
            try:
                _checked(root, path)
                files = _files(root, path) if path.is_dir() else [path]
                for file in files:
                    total += 1
                    if total > _MAX_FILES:
                        fail("工作区文件过多，本次没有自动清理素材", 409)
                    unit.files.append(file)
                    if file.suffix.lower() != ".json":
                        continue
                    if file.stat().st_size > _MAX_JSON_BYTES:
                        uncertain = True
                        continue
                    try:
                        value = json.loads(file.read_text(encoding="utf-8"))
                        unit.records.append(value)
                        unit.references.update(_references(value))
                    except (OSError, ValueError, RecursionError):
                        uncertain = True
            except Exception:
                unit.unsafe = True
                uncertain = True
    return units, uncertain


def _reachable(units, seeds):
    visited, pending = set(), list(seeds)
    while pending:
        key = pending.pop()
        if key in visited or key not in units:
            continue
        visited.add(key)
        pending.extend(units[key].references - visited)
    return visited


def _locked(store, core):
    stack = ExitStack()
    stack.enter_context(store.lock)
    if getattr(core, "LOCK", None) is not None:
        stack.enter_context(core.LOCK)
    # Creation takes store.lock before the garment-job lock too.
    from .garment_jobs import _LOCK
    stack.enter_context(_LOCK)
    return stack


def _plan(store, core, identifier):
    workflow = store.get(safe_id(identifier))
    root = Path(core.DATA).absolute()
    folder = _checked(root, store._folder(identifier))
    target = ("node-studio/workflows/" + identifier).casefold()
    units, uncertain = _inventory(root)
    if target not in units or units[target].unsafe:
        fail("作品文件无法安全读取，原文件已保留", 409)
    # Never remove files while a worker could still consume or recreate them.
    active = [record for key, unit in units.items()
              if key.startswith(_JOB_PREFIXES)
              for record in unit.records if isinstance(record, dict) and isinstance(record.get("status"), str) and record["status"] in _ACTIVE]
    if active:
        fail("仍有任务正在运行，请等待完成后再删除作品", 409)
    owned = {key for key, unit in units.items() if any(_owns(record, identifier) for record in unit.records)}
    owned.add(target)
    export_key = ("node-studio/exports/" + identifier).casefold()
    if export_key in units:
        owned.add(export_key)
    # Generation jobs are owned through their actual project association.
    owned_projects = {key.split("/", 1)[1] for key in owned if key.startswith("projects/")}
    for key, unit in units.items():
        if key.startswith(_JOB_PREFIXES) and any(isinstance(record, dict) and record.get("projectId") in owned_projects for record in unit.records):
            owned.add(key)
    candidates = _reachable(units, owned)
    keep_roots = set(units) - candidates
    # A legacy project remains independently usable even if this workflow used
    # its output; referencing it does not establish ownership.
    keep_roots.update(key for key in candidates if key.startswith("projects/") and key not in owned)
    keep_roots.update(key for key in units if key.startswith("node-studio/workflows/") and key != target)
    retained = _reachable(units, keep_roots)
    removable = ({target} if uncertain else candidates - retained) | {target}
    removable = {key for key in removable if not units[key].unsafe}
    delete_files = sorted({file for key in removable for file in units[key].files}, key=lambda path: (path.name != "workflow.json", str(path)))
    optional_files = {file for key in candidates - {target} for file in units[key].files}
    retained_files = optional_files - set(delete_files)
    size = sum(file.stat().st_size for file in delete_files)
    return {"workflow": workflow, "root": root, "folder": folder, "units": units,
            "deleteFiles": delete_files, "optionalFiles": optional_files, "retainedFiles": retained_files,
            "estimatedBytes": size, "assetCount": sum(file.suffix.lower() in _ASSET_SUFFIXES for file in delete_files),
            "conservative": uncertain}


def deletion_preview(store, core, identifier):
    with _locked(store, core):
        plan = _plan(store, core, identifier)
        return {"id": identifier, "title": plan["workflow"]["title"], "revision": plan["workflow"]["revision"],
                "estimatedBytes": plan["estimatedBytes"], "assetCount": plan["assetCount"],
                "retainedFiles": len(plan["retainedFiles"]), "conservative": plan["conservative"]}


def delete_workflow(store, core, identifier, expected_revision, delete_unused_assets=True):
    with _locked(store, core):
        plan = _plan(store, core, identifier)
        if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or plan["workflow"]["revision"] != expected_revision:
            fail("作品已经更新，请重新打开删除确认", 409)
        if not isinstance(delete_unused_assets, bool):
            fail("素材清理选项无效")
        root, folder = plan["root"], plan["folder"]
        files = plan["deleteFiles"] if delete_unused_assets else _files(root, folder)
        # Validate the complete deletion set before removing its first file.
        for file in files:
            _checked(root, file)
        primary = folder / "workflow.json"
        ordered = [primary] + [file for file in files if file != primary]
        freed, count, failed = 0, 0, set()
        for file in ordered:
            try:
                _checked(root, file)
                size = file.stat().st_size
                file.unlink()
                freed += size
                count += 1
            except OSError:
                if file == primary:
                    fail("作品正在被占用，未删除，请关闭该作品后重试", 409)
                failed.add(file)
        # Only remove verified empty directories, never recursive arbitrary paths.
        parents = {parent for file in files for parent in file.parents
                   if parent != root and parent.is_relative_to(root)}
        for parent in sorted(parents, key=lambda path: len(path.parts), reverse=True):
            try:
                _checked(root, parent)
                parent.rmdir()
            except OSError:
                pass
        kept = (plan["optionalFiles"] - set(files)) | plan["retainedFiles"] | failed
        return {"id": identifier, "deleted": True, "freedBytes": freed,
                "deletedFiles": count, "retainedFiles": len(kept), "conservative": plan["conservative"]}
