# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Shrink MCP tool payloads before they enter the LLM context (GitHub file/issue responses).
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Roughly ~12k tokens of file text; keeps multi-file turns within Bedrock limits.
MAX_FILE_CONTENT_CHARS = 48_000
MAX_DIRECTORY_ENTRIES = 60

_GITHUB_OP_SUFFIX = re.compile(r"(?:^|___)(github_[a-z_]+)$", re.IGNORECASE)


def _github_operation(tool_name: str) -> str | None:
    name = (tool_name or "").strip().lower()
    if not name:
        return None
    if "___" in name:
        suffix = name.rsplit("___", 1)[-1]
        if suffix.startswith("github_"):
            return suffix
    if name.startswith("github_"):
        return name
    match = _GITHUB_OP_SUFFIX.search(name)
    return match.group(1).lower() if match else None


def _parse_json_payload(result: Any) -> Any | None:
    if isinstance(result, (dict, list)):
        return result
    if not isinstance(result, str):
        return None
    text = result.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _unwrap_mcp_tool_payload(result: Any) -> tuple[Any, Any | None]:
    """
    MCP tools may return {content: [{text: "<json>"}]} instead of raw JSON strings.
    Returns (original_for_dump, parsed_payload).
    """
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        texts: list[str] = []
        for item in result["content"]:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                texts.append(item["text"])
        if len(texts) == 1:
            parsed = _parse_json_payload(texts[0])
            if parsed is not None:
                return result, parsed
    parsed = _parse_json_payload(result)
    return result, parsed


def _decode_github_file_content(content: str, encoding: str | None) -> tuple[str, bool]:
    enc = (encoding or "base64").lower()
    if enc != "base64":
        return content, False
    try:
        raw = base64.b64decode(content, validate=False)
        decoded = raw.decode("utf-8")
        return decoded, False
    except (UnicodeDecodeError, binascii.Error, ValueError):
        try:
            raw = base64.b64decode(content, validate=False)
            return raw.decode("utf-8", errors="replace"), True
        except Exception:
            return content, True


def _slim_directory_entry(item: dict[str, Any]) -> dict[str, Any]:
    entry_type = "dir" if item.get("type") == "dir" else "file"
    out: dict[str, Any] = {
        "name": item.get("name"),
        "path": item.get("path"),
        "type": entry_type,
    }
    if entry_type == "file" and item.get("size") is not None:
        out["size"] = item.get("size")
    return out


def _sanitize_github_file_content_payload(data: Any) -> Any:
    if isinstance(data, list):
        entries = [_slim_directory_entry(item) for item in data if isinstance(item, dict)]
        if len(entries) > MAX_DIRECTORY_ENTRIES:
            kept = entries[:MAX_DIRECTORY_ENTRIES]
            return {
                "type": "directory",
                "truncated": True,
                "entryCount": len(entries),
                "entries": kept,
            }
        return {"type": "directory", "truncated": False, "entries": entries}

    if not isinstance(data, dict):
        return data

    content = data.get("content")
    if not isinstance(content, str):
        return {
            "type": "file",
            "path": data.get("path"),
            "name": data.get("name"),
            "size": data.get("size"),
            "sha": data.get("sha"),
            "note": "No inline content (large file or submodule). Use a narrower path or raw download URL out of band.",
        }

    decoded, decode_error = _decode_github_file_content(content, data.get("encoding"))
    truncated = False
    if len(decoded) > MAX_FILE_CONTENT_CHARS:
        decoded = decoded[:MAX_FILE_CONTENT_CHARS]
        truncated = True

    out: dict[str, Any] = {
        "type": "file",
        "path": data.get("path"),
        "name": data.get("name"),
        "size": data.get("size"),
        "sha": data.get("sha"),
        "encoding": "utf-8",
        "content": decoded,
        "truncated": truncated,
    }
    if decode_error:
        out["decodeWarning"] = "File content could not be fully decoded as UTF-8."
    if truncated:
        out["note"] = (
            f"Content truncated to {MAX_FILE_CONTENT_CHARS} characters. "
            "Request a smaller path or specific section instead of re-fetching the whole file."
        )
    out["blobShaNotBranchSha"] = (
        "The sha field is the file blob SHA. Use github_get_ref(heads/<branch>) for github_create_ref."
    )
    return out


def _sanitize_github_ref_payload(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    obj = data.get("object") if isinstance(data.get("object"), dict) else {}
    return {
        "ref": data.get("ref"),
        "commitSha": obj.get("sha"),
        "note": "Use commitSha for github_create_ref. Never use file blob sha from github_get_file_content.",
    }


def _sanitize_github_issue_comments_payload(data: Any) -> Any:
    if not isinstance(data, list):
        return data
    comments: list[dict[str, Any]] = []
    for item in data[:20]:
        if not isinstance(item, dict):
            continue
        comments.append(
            {
                "id": item.get("id"),
                "user": (item.get("user") or {}).get("login") if isinstance(item.get("user"), dict) else None,
                "body": item.get("body"),
                "created_at": item.get("created_at"),
            }
        )
    out: dict[str, Any] = {"comments": comments, "truncated": len(data) > len(comments)}
    if out["truncated"]:
        out["total"] = len(data)
    return out


def _sanitize_github_issue_payload(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    labels = data.get("labels")
    label_names: list[str] = []
    if isinstance(labels, list):
        for label in labels:
            if isinstance(label, dict) and label.get("name"):
                label_names.append(str(label["name"]))
            elif isinstance(label, str):
                label_names.append(label)
    return {
        "number": data.get("number"),
        "title": data.get("title"),
        "body": data.get("body"),
        "state": data.get("state"),
        "labels": label_names,
    }


def _dump_sanitized(original: Any, sanitized: Any) -> Any:
    if isinstance(original, str):
        return json.dumps(sanitized, ensure_ascii=False)
    return sanitized


def sanitize_tool_result(tool_name: str, result: Any) -> Any:
    """
    Return a smaller tool result for known noisy MCP GitHub operations.
    Unknown tools pass through unchanged.
    """
    if result is None:
        return result

    operation = _github_operation(tool_name)
    if not operation:
        return result

    original, parsed = _unwrap_mcp_tool_payload(result)
    if parsed is None:
        return result

    sanitized: Any | None = None
    if operation == "github_get_file_content":
        sanitized = _sanitize_github_file_content_payload(parsed)
    elif operation == "github_get_issue":
        sanitized = _sanitize_github_issue_payload(parsed)
    elif operation == "github_get_ref":
        sanitized = _sanitize_github_ref_payload(parsed)
    elif operation == "github_list_issue_comments":
        sanitized = _sanitize_github_issue_comments_payload(parsed)

    if sanitized is None:
        return result

    logger.debug("Sanitized MCP tool result for %s (%s)", tool_name, operation)
    if isinstance(original, dict) and isinstance(original.get("content"), list) and len(original["content"]) == 1:
        if isinstance(original["content"][0], dict):
            updated = dict(original)
            content0 = dict(original["content"][0])
            content0["text"] = json.dumps(sanitized, ensure_ascii=False)
            updated["content"] = [content0]
            return updated
    return _dump_sanitized(original, sanitized)
