# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

from gaab_strands_common.aiw_discord_tool import (
    DISCORD_ALIAS_NAME,
    load_aiw_discord_alias_tools,
    split_discord_mcp_tools,
)


class TestAiwDiscordTool:
    def test_load_alias_uses_mcp_agent_tool_rename(self):
        mcp_tool = Mock()
        mcp_tool.name = "discord_post_message"
        mcp_client = Mock()
        underlying = Mock()
        underlying.tool_name = "custom-abc___discord_post_message"
        underlying.mcp_tool = mcp_tool
        underlying.mcp_client = mcp_client
        underlying.timeout = None

        alias = Mock()
        alias.tool_name = DISCORD_ALIAS_NAME
        with patch("strands.tools.mcp.mcp_agent_tool.MCPAgentTool", return_value=alias) as mcp_cls:
            aliases = load_aiw_discord_alias_tools([underlying])

        assert aliases == [alias]
        mcp_cls.assert_called_once_with(
            mcp_tool,
            mcp_client,
            name_override=DISCORD_ALIAS_NAME,
            timeout=None,
        )

    def test_split_removes_gateway_discord_mcp_tool(self):
        underlying = Mock()
        underlying.tool_name = "custom-abc___discord_post_message"
        underlying.mcp_tool = Mock()
        underlying.mcp_client = Mock()
        other = Mock()
        other.tool_name = "other_tool"

        alias = Mock()
        alias.tool_name = DISCORD_ALIAS_NAME
        with patch("strands.tools.mcp.mcp_agent_tool.MCPAgentTool", return_value=alias):
            aliases, kept = split_discord_mcp_tools([underlying, other])

        assert len(aliases) == 1
        assert aliases[0] is alias
        assert len(kept) == 1
        assert kept[0] is other
