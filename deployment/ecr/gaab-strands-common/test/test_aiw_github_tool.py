# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from gaab_strands_common.aiw_github_tool import filter_gateway_github_mcp_tools, is_github_mcp_tool


class _Tool:
    def __init__(self, name: str):
        self.name = name


def test_is_github_mcp_tool():
    assert is_github_mcp_tool(_Tool("github___github_create_pull"))
    assert is_github_mcp_tool(_Tool("github___github_update_issue"))
    assert is_github_mcp_tool(_Tool("github_create_pull"))
    assert is_github_mcp_tool(_Tool("github_merge_pull"))
    assert not is_github_mcp_tool(_Tool("discord_post_message"))


def test_filter_gateway_github_mcp_tools():
    github = _Tool("github___github_get_issue")
    update = _Tool("github___github_update_issue")
    other = _Tool("jira_get_issue")
    filtered = filter_gateway_github_mcp_tools([github, update, other])
    assert filtered == [other]
