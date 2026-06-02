# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Discord publish alias for AIW tenants.

AgentCore Gateway exposes Discord as MCP tools with long names like
``custom-e240c3f1-297___discord_post_message``. Bedrock Converse often rejects
those names (modelStreamErrorException: invalid ToolUse sequence). We hide the
gateway MCP tool and expose a short ``discord_post_message`` alias that delegates
to the underlying MCP tool via Strands' MCPAgentTool (stream/call_tool), not a
callable wrapper.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional, Tuple

logger = logging.getLogger(__name__)

DISCORD_ALIAS_NAME = "discord_post_message"


def _mcp_tool_name(t: Any) -> str:
    return (getattr(t, "tool_name", None) or getattr(t, "name", None) or "").strip()


def is_discord_mcp_tool(t: Any) -> bool:
    return "discord_post_message" in _mcp_tool_name(t).lower()


def filter_gateway_discord_mcp_tools(mcp_tools: List[Any]) -> List[Any]:
    """Drop gateway Discord MCP tools; the agent uses the short alias instead."""
    kept: List[Any] = []
    for t in mcp_tools:
        if is_discord_mcp_tool(t):
            logger.info("Skipping gateway MCP tool %s (using %s alias)", _mcp_tool_name(t), DISCORD_ALIAS_NAME)
            continue
        kept.append(t)
    return kept


def _discord_alias_from_mcp_tool(underlying: Any) -> Any:
    """
    Re-expose the gateway Discord MCP tool under a Bedrock-safe short name.

    MCPAgentTool is not callable; the agent invokes it through ``stream()``.
    """
    mcp_tool = getattr(underlying, "mcp_tool", None)
    mcp_client = getattr(underlying, "mcp_client", None)
    if mcp_tool is None or mcp_client is None:
        raise TypeError(
            f"Discord MCP tool {_mcp_tool_name(underlying)!r} is not an MCPAgentTool "
            "(missing mcp_tool/mcp_client)"
        )

    from strands.tools.mcp.mcp_agent_tool import MCPAgentTool

    return MCPAgentTool(
        mcp_tool,
        mcp_client,
        name_override=DISCORD_ALIAS_NAME,
        timeout=getattr(underlying, "timeout", None),
    )


def load_aiw_discord_alias_tools(mcp_tools: List[Any]) -> List[Any]:
    """Return a Bedrock-safe ``discord_post_message`` tool when gateway Discord MCP exists."""
    for t in mcp_tools:
        if not is_discord_mcp_tool(t):
            continue
        source_name = _mcp_tool_name(t)
        logger.info("Loading Discord alias %s (delegates to %s)", DISCORD_ALIAS_NAME, source_name)
        return [_discord_alias_from_mcp_tool(t)]
    return []


def split_discord_mcp_tools(mcp_tools: List[Any]) -> Tuple[List[Any], List[Any]]:
    """Return (alias_tools, filtered_mcp_tools)."""
    aliases = load_aiw_discord_alias_tools(mcp_tools)
    filtered = filter_gateway_discord_mcp_tools(mcp_tools)
    return aliases, filtered
