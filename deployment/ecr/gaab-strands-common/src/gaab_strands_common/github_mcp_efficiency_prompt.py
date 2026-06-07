# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Runtime system-prompt augmentation for GitHub MCP tool efficiency."""

from __future__ import annotations

import logging
from typing import Any, Iterable, List

logger = logging.getLogger(__name__)


def _tool_name(tool: Any) -> str:
    if hasattr(tool, "tool_name") and tool.tool_name:
        return str(tool.tool_name)
    if hasattr(tool, "name") and tool.name:
        return str(tool.name)
    if hasattr(tool, "__name__"):
        return str(tool.__name__)
    return tool.__class__.__name__


def list_github_mcp_tool_names(tools: Iterable[Any]) -> List[str]:
    names: List[str] = []
    seen: set[str] = set()
    for tool in tools:
        name = _tool_name(tool).strip()
        lower = name.lower()
        if not name or name in seen:
            continue
        if "github" in lower and ("get_" in lower or "create_" in lower or "list_" in lower):
            seen.add(name)
            names.append(name)
    return names


def augment_system_prompt_with_github_efficiency(base_prompt: str, tools: Iterable[Any]) -> str:
    """
    Append exploration limits so agents commit incrementally instead of looping on file reads.
    Applies to any workspace with GitHub MCP tools loaded (e.g. backend-api-developer).
    """
    github_names = list_github_mcp_tool_names(tools)
    if not github_names:
        return base_prompt

    lines = [
        "",
        "## GITHUB MCP EFFICIENCY (mandatory — prevents timeouts)",
        "GitHub tools are connected. Follow these rules on every ticket:",
        "",
        "1. **Fetch once:** Call github_get_issue exactly once at the start. Do not re-fetch the issue.",
        "2. **Branch SHA:** Use github_get_ref(heads/<branch>) for commit SHAs. Never pass file blob sha from github_get_file_content into github_create_ref.",
        "3. **Read budget:** After at most **8** github_get_file_content calls, stop exploring and make your first commit (OpenAPI first when requireOpenApiFirst applies).",
        "4. **No duplicate paths:** Never read the same path twice in one session. Take notes from the first read.",
        "5. **Targeted paths:** Read only files named in the ticket or obviously required (e.g. openapi.yaml, one handler module). Avoid directory listing unless the ticket is unclear.",
        "6. **Incremental delivery:** Prefer small commits (openapi → handler → tests) and open the PR as soon as a vertical slice works. Do not read the entire repo before writing.",
        "7. **Truncated files:** Tool responses may truncate very large files. Request a narrower path instead of re-fetching the whole file.",
        "8. **Hard limits (enforced):** The platform blocks duplicate file reads and more than one github_get_issue per run. Exceeding the file-read budget returns GITHUB_EXPLORATION_BUDGET_EXCEEDED — commit immediately instead of retrying.",
        "",
        "Connected GitHub tools:",
    ]
    for name in github_names:
        lines.append(f"- {name}")

    suffix = "\n".join(lines)
    logger.info("Augmented system prompt with GitHub MCP efficiency (%d tool(s))", len(github_names))
    return base_prompt.rstrip() + suffix
