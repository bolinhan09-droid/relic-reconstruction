"""Resolve saved textual outputs along one route, independently of its image.

Text is data: resolving it never runs an assistant or an image provider. Keep
this small contract aligned with web/node-studio/core/text-input.js.
"""
from __future__ import annotations

import copy

from .graph import preceding_ids, host_for

MAX_TEXT = 16000


def intent_text(output):
    """Read new text artifacts and upgrade old structured intent results."""
    if not isinstance(output, dict):
        return ""
    for key in ("text", "intent", "prompt"):
        if isinstance(output.get(key), str) and output[key].strip():
            return output[key].strip()[:MAX_TEXT]
    lines = []
    for item in output.get("items", []) if isinstance(output.get("items"), list) else []:
        if isinstance(item, dict):
            label = str(item.get("label") or "").strip()
            value = str(item.get("value") or item.get("detail") or "").strip()
            if value:
                lines.append((label + "：" if label else "") + value)
        elif isinstance(item, str) and item.strip():
            lines.append(item.strip())
    return "\n".join(lines)[:MAX_TEXT]


def text_input(workflow, node):
    by_id = {entry["id"]: entry for entry in workflow["nodes"]}
    host = host_for(workflow, node["id"])
    route = preceding_ids(workflow, node["id"]) + ([host["id"]] if host else [])
    # An input further along a lane starts a new scope, like image resolution.
    start = max((i for i, identifier in enumerate(route)
                 if by_id[identifier]["type"] in {"garment_input", "image_reference"}), default=0)
    route = route[start:]
    entries, seen = [], set()

    def append(identifier, include_self=True):
        if identifier in seen:
            return
        seen.add(identifier)
        entry = by_id.get(identifier)
        if not entry:
            return
        if include_self:
            entries.append(entry)
        for slot in ("top", "bottom"):
            for child in entry.get("attachments", {}).get(slot, []):
                if child != node["id"]:
                    append(child)

    for identifier in route:
        append(identifier)
    append(node["id"], False)  # assistants plugged into this receiving node
    sources, last_task = [], None
    for entry in entries:
        output = entry.get("output") or {}
        text, kind = "", ""
        if entry["type"] == "intent_assist" and output.get("kind") == "intent":
            text, kind = intent_text(output), "intent"
        elif output.get("kind") == "generation_task" and isinstance(output.get("task"), dict):
            last_task = copy.deepcopy(output["task"])
            text = str(last_task.get("prompt") or last_task.get("intent") or "").strip()[:MAX_TEXT]
            kind = "generation_task"
            sources = [source for source in sources if source["kind"] != "generation_task"]
        if text:
            sources.append({"nodeId": entry["id"], "label": entry.get("label") or entry["type"],
                            "kind": kind, "text": text, "versionId": output.get("versionId") or output.get("textVersionId") or "",
                            "stale": entry.get("status") == "stale"})
    chunks = []
    for source in sources:
        text = source["text"]
        if any(text in other["text"] for other in sources if other is not source and len(other["text"]) > len(text)):
            continue
        if text not in chunks:
            chunks.append(text)
    inherited = "\n\n".join(chunks)
    extra = node.get("params", {}).get("intent") or node.get("params", {}).get("prompt") or ""
    extra = extra.strip()[:MAX_TEXT] if isinstance(extra, str) else ""
    # Older UIs copied the whole inherited prompt into params.intent. Keep old
    # projects working without duplicating that text on every subsequent run.
    combined = inherited
    if extra and extra not in inherited:
        combined += ("\n\n本次补充：" if inherited else "") + extra
    return {"sources": sources, "text": inherited, "additionalText": extra,
            "combinedText": combined, "task": last_task,
            "stale": any(source["stale"] for source in sources)}
