# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Hard per-invocation limits for GitHub MCP exploration (prevents Bedrock context blow-up).
"""

from __future__ import annotations

import json
import os
from typing import Any


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
    return None


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


class GithubExplorationBudget:
    """Session-scoped counters reset at the start of each agent invocation."""

    _file_reads = 0
    _issue_fetches = 0
    _paths_seen: set[str] = set()

    @classmethod
    def clear(cls) -> None:
        cls._file_reads = 0
        cls._issue_fetches = 0
        cls._paths_seen = set()

    @classmethod
    def max_file_reads(cls) -> int:
        return _env_int("GITHUB_MCP_MAX_FILE_READS", 8)

    @classmethod
    def max_issue_fetches(cls) -> int:
        return _env_int("GITHUB_MCP_MAX_ISSUE_FETCHES", 1)

    @classmethod
    def _extract_tool_input(cls, args: tuple, kwargs: dict) -> dict[str, Any]:
        if isinstance(kwargs.get("input"), dict):
            return dict(kwargs["input"])
        if isinstance(kwargs.get("tool_input"), dict):
            return dict(kwargs["tool_input"])
        if args:
            first = args[0]
            if isinstance(first, dict):
                nested = first.get("input") or first.get("arguments") or first.get("parameters")
                if isinstance(nested, dict):
                    return dict(nested)
                return dict(first)
        return {k: v for k, v in kwargs.items() if k not in {"agent", "_agent", "self"}}

    @classmethod
    def _blocked(cls, message: str) -> str:
        return json.dumps(
            {
                "error": "GITHUB_EXPLORATION_BUDGET_EXCEEDED",
                "message": message,
                "fileReadsUsed": cls._file_reads,
                "fileReadsLimit": cls.max_file_reads(),
                "issueFetchesUsed": cls._issue_fetches,
                "issueFetchesLimit": cls.max_issue_fetches(),
            },
            ensure_ascii=False,
        )

    @classmethod
    def check_before_call(cls, tool_name: str, args: tuple, kwargs: dict) -> str | None:
        operation = _github_operation(tool_name)
        if not operation:
            return None

        tool_input = cls._extract_tool_input(args, kwargs)

        if operation == "github_get_issue":
            if cls._issue_fetches >= cls.max_issue_fetches():
                return cls._blocked(
                    "github_get_issue may only be called once per agent run. "
                    "Use the issue body you already fetched and proceed to openapi.yaml or your first commit."
                )
            cls._issue_fetches += 1
            return None

        if operation == "github_get_file_content":
            path = str(tool_input.get("path") or "").strip()
            ref = str(tool_input.get("ref") or "main").strip() or "main"
            if not path:
                return None

            key = f"{path}@{ref}"
            if key in cls._paths_seen:
                return cls._blocked(
                    f"Duplicate read of {path} (ref={ref}). Use notes from the first read or commit incremental changes."
                )
            if cls._file_reads >= cls.max_file_reads():
                return cls._blocked(
                    f"File read budget exhausted ({cls.max_file_reads()} reads). "
                    "Stop exploring and make your first commit (OpenAPI first when requireOpenApiFirst applies)."
                )
            cls._paths_seen.add(key)
            cls._file_reads += 1
            return None

        return None


def check_github_exploration_budget(tool_name: str, args: tuple, kwargs: dict) -> str | None:
    return GithubExplorationBudget.check_before_call(tool_name, args, kwargs)
