# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

from gaab_strands_common.aiw_google_gmail_tool import (
    filter_gateway_gmail_mcp_tools,
    gateway_workload_from_mcp_servers,
)


def test_gateway_workload_from_mcp_url():
    servers = [
        {
            "type": "gateway",
            "url": "https://gaab-mcp-05578852-t8twlpykvz.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
        }
    ]
    assert gateway_workload_from_mcp_servers(servers) == "gaab-mcp-05578852"


def test_filter_gateway_gmail_mcp_tools():
    gmail_tool = MagicMock()
    gmail_tool.tool_name = "gmail_list_messages"
    other = MagicMock()
    other.tool_name = "calendar_list_events"
    filtered = filter_gateway_gmail_mcp_tools([gmail_tool, other])
    assert filtered == [other]
