# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest
from gaab_strands_common.models import AgentBuilderParams, BedrockLlmParams, LlmParams, UseCaseConfig
from gaab_strands_common.tools_manager import ToolsManager


class _Tool:
    def __init__(self, name: str):
        self.name = name


@pytest.fixture
def tools_manager():
    config = UseCaseConfig(
        UseCaseName="Test",
        UseCaseType="AgentBuilder",
        AgentBuilderParams=AgentBuilderParams(SystemPrompt="Test"),
        LlmParams=LlmParams(
            ModelProvider="Bedrock",
            BedrockLlmParams=BedrockLlmParams(
                ModelId="anthropic.claude-3-sonnet-20240229-v1:0",
                BedrockInferenceType="QUICK_START",
            ),
        ),
    )
    with (
        patch("gaab_strands_common.tools_manager.StrandsToolsRegistry"),
        patch("gaab_strands_common.tools_manager.MCPToolsLoader") as mcp_loader_cls,
    ):
        manager = ToolsManager("us-east-1", config)
        manager.mcp_loader = mcp_loader_cls.return_value
        yield manager


def test_load_all_tools_drops_gateway_github_when_direct_github_loads(tools_manager):
    gateway_github = _Tool("github___github_create_pull")
    gateway_jira = _Tool("jira_get_issue")
    direct_github = _Tool("github_create_pull")

    tools_manager.mcp_loader.load_tools.return_value = [gateway_github, gateway_jira]
    tools_manager._resolve_aiw_tenant_id = MagicMock(return_value="tenant-123")

    with (
        patch.object(tools_manager, "_load_strands_tools", return_value=[]),
        patch.object(tools_manager, "_load_custom_tools", return_value=[]),
        patch(
            "gaab_strands_common.tools_manager.load_aiw_gmail_tools",
            return_value=[],
        ),
        patch(
            "gaab_strands_common.tools_manager.load_aiw_figma_tools",
            return_value=[],
        ),
        patch(
            "gaab_strands_common.tools_manager.load_aiw_github_tools",
            return_value=[direct_github],
        ),
        patch("gaab_strands_common.tools_manager.wrap_tool_with_events", side_effect=lambda t: t),
    ):
        loaded = tools_manager.load_all_tools([{"use_case_id": "gw", "url": "http://gw", "type": "gateway"}], [], [])

    names = [getattr(t, "name", "") for t in loaded]
    assert "github_create_pull" in names
    assert "jira_get_issue" in names
    assert "github___github_create_pull" not in names


def test_load_all_tools_keeps_gateway_github_when_direct_github_unavailable(tools_manager):
    gateway_github = _Tool("github___github_create_pull")

    tools_manager.mcp_loader.load_tools.return_value = [gateway_github]
    tools_manager._resolve_aiw_tenant_id = MagicMock(return_value="tenant-123")

    with (
        patch.object(tools_manager, "_load_strands_tools", return_value=[]),
        patch.object(tools_manager, "_load_custom_tools", return_value=[]),
        patch(
            "gaab_strands_common.tools_manager.load_aiw_gmail_tools",
            return_value=[],
        ),
        patch(
            "gaab_strands_common.tools_manager.load_aiw_figma_tools",
            return_value=[],
        ),
        patch(
            "gaab_strands_common.tools_manager.load_aiw_github_tools",
            return_value=[],
        ),
        patch("gaab_strands_common.tools_manager.wrap_tool_with_events", side_effect=lambda t: t),
    ):
        loaded = tools_manager.load_all_tools([{"use_case_id": "gw", "url": "http://gw", "type": "gateway"}], [], [])

    names = [getattr(t, "name", "") for t in loaded]
    assert "github___github_create_pull" in names
