# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from gaab_strands_common.publish_tools_prompt import (
    augment_system_prompt_with_publish_tools,
    is_publish_tool_name,
    list_publish_tool_names,
)


class _FakeTool:
    def __init__(self, name: str):
        self.name = name


def test_is_publish_tool_name():
    assert is_publish_tool_name("custom-e240c3f1-297___discord_post_message")
    assert not is_publish_tool_name("current_time")


def test_augment_system_prompt_adds_discord_tool():
    tools = [_FakeTool("custom-e240c3f1-297___discord_post_message"), _FakeTool("current_time")]
    out = augment_system_prompt_with_publish_tools("You are a publisher.", tools)
    assert "CONNECTED PUBLISH TOOLS" in out
    assert "custom-e240c3f1-297___discord_post_message" in out
    assert "Do NOT say no publish integrations" in out


def test_augment_system_prompt_no_tools_unchanged():
    base = "You are a publisher."
    assert augment_system_prompt_with_publish_tools(base, []) == base


def test_list_publish_tool_names():
    names = list_publish_tool_names(
        [_FakeTool("a___discord_post_message"), _FakeTool("current_time")]
    )
    assert names == ["a___discord_post_message"]
