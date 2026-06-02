# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Inject loaded publish-tool names into the agent system prompt (AIW Publisher fix)."""

from __future__ import annotations

import logging
from typing import Any, Iterable, List

logger = logging.getLogger(__name__)

_PUBLISH_NAME_MARKERS = (
    "discord_post_message",
    "post_message",
    "create_post",
    "create_channel_message",
    "send_message",
    "publish",
    "webhook",
)


def _tool_name(tool: Any) -> str:
    if hasattr(tool, "tool_name") and tool.tool_name:
        return str(tool.tool_name)
    if hasattr(tool, "name") and tool.name:
        return str(tool.name)
    if hasattr(tool, "__name__"):
        return str(tool.__name__)
    return tool.__class__.__name__


def is_publish_tool_name(name: str) -> bool:
    lower = name.lower()
    return any(marker in lower for marker in _PUBLISH_NAME_MARKERS)


def list_publish_tool_names(tools: Iterable[Any]) -> List[str]:
    names: List[str] = []
    seen: set[str] = set()
    for tool in tools:
        name = _tool_name(tool).strip()
        if not name or name in seen:
            continue
        if is_publish_tool_name(name):
            seen.add(name)
            names.append(name)
    return names


def augment_system_prompt_with_publish_tools(base_prompt: str, tools: Iterable[Any]) -> str:
    """
    Append an authoritative list of connected publish tools so Publisher-style agents
    do not claim 'no integrations' when MCP tools (e.g. Discord) are loaded.
    """
    publish_names = list_publish_tool_names(tools)
    if not publish_names:
        return base_prompt

    lines = [
        "",
        "## CONNECTED PUBLISH TOOLS (authoritative — integrations ARE connected)",
        "The following outbound publish tools are loaded for this workspace. Use them for live posts.",
        "Do NOT say no publish integrations are connected while any tool below is available.",
        "Do NOT use the environment tool to discover integrations.",
        "",
    ]
    for name in publish_names:
        lines.append(f"- {name}")
    lines.extend(
        [
            "",
            "When the user asks to post to Discord, call the tool named `discord_post_message` with a `content` argument.",
        ]
    )
    suffix = "\n".join(lines)
    logger.info("Augmented system prompt with %d publish tool(s): %s", len(publish_names), publish_names)
    return base_prompt.rstrip() + suffix
