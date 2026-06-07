# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import base64
import json

from gaab_strands_common.github_mcp_efficiency_prompt import augment_system_prompt_with_github_efficiency
from gaab_strands_common.github_mcp_exploration_budget import GithubExplorationBudget, check_github_exploration_budget
from gaab_strands_common.mcp_tool_result_sanitizer import sanitize_tool_result


class _FakeTool:
    def __init__(self, name: str):
        self.name = name


def test_sanitize_github_file_content_decodes_base64():
    content = base64.b64encode(b"openapi: 3.0.3\npaths: {}").decode("ascii")
    raw = {
        "name": "openapi.yaml",
        "path": "openapi.yaml",
        "sha": "abc123",
        "size": 20,
        "encoding": "base64",
        "content": content,
        "url": "https://api.github.com/should-be-stripped",
    }
    out = json.loads(sanitize_tool_result("github___github_get_file_content", json.dumps(raw)))
    assert out["type"] == "file"
    assert out["content"].startswith("openapi:")
    assert out["encoding"] == "utf-8"
    assert "url" not in out


def test_sanitize_github_file_content_truncates_large_files():
    big = "x" * 60_000
    content = base64.b64encode(big.encode("utf-8")).decode("ascii")
    raw = {"path": "big.txt", "encoding": "base64", "content": content, "sha": "sha"}
    out = json.loads(sanitize_tool_result("github_get_file_content", json.dumps(raw)))
    assert out["truncated"] is True
    assert len(out["content"]) == 48_000


def test_sanitize_github_directory_listing():
    raw = [{"name": "src", "path": "src", "type": "dir"}, {"name": "README.md", "path": "README.md", "type": "file", "size": 10}]
    out = json.loads(sanitize_tool_result("github___github_get_file_content", json.dumps(raw)))
    assert out["type"] == "directory"
    assert len(out["entries"]) == 2


def test_sanitize_github_issue_slim():
    raw = {
        "number": 3,
        "title": "Test",
        "body": "Do work",
        "state": "open",
        "labels": [{"name": "bug"}],
        "user": {"login": "octocat"},
        "comments_url": "https://example.com",
    }
    out = json.loads(sanitize_tool_result("github_get_issue", json.dumps(raw)))
    assert out["number"] == 3
    assert out["labels"] == ["bug"]
    assert "user" not in out


def test_sanitize_passes_through_unknown_tools():
    assert sanitize_tool_result("http_request", "ok") == "ok"


def test_sanitize_github_get_ref_slim():
    raw = {
        "ref": "refs/heads/main",
        "object": {"sha": "84cf218d730c2305bae7c13399be02f47213b936"},
        "url": "https://api.github.com/should-be-stripped",
    }
    out = json.loads(sanitize_tool_result("github___github_get_ref", json.dumps(raw)))
    assert out["commitSha"] == "84cf218d730c2305bae7c13399be02f47213b936"
    assert "url" not in out


def test_sanitize_mcp_content_wrapper():
    inner = base64.b64encode(b"hello").decode("ascii")
    wrapped = {
        "content": [
            {
                "text": json.dumps(
                    {
                        "path": "README.md",
                        "encoding": "base64",
                        "content": inner,
                        "sha": "abc",
                    }
                )
            }
        ]
    }
    out = sanitize_tool_result("github___github_get_file_content", wrapped)
    assert isinstance(out, dict)
    parsed = json.loads(out["content"][0]["text"])
    assert parsed["content"] == "hello"


def test_sanitize_tool_result_event_preserves_tool_use_id():
    issue = {
        "number": 5,
        "title": "Health check",
        "body": "Add GET /v1/meta/health",
        "state": "open",
        "labels": [{"name": "agent:backend-api-developer"}],
        "user": {"login": "octocat"},
    }
    event = {
        "type": "tool_result",
        "tool_result": {
            "toolUseId": "tooluse-abc-123",
            "status": "success",
            "content": [{"text": json.dumps(issue)}],
        },
    }
    out = sanitize_tool_result("github___github_get_issue", event)
    assert out["type"] == "tool_result"
    assert out["tool_result"]["toolUseId"] == "tooluse-abc-123"
    assert out["tool_result"]["status"] == "success"
    slim = json.loads(out["tool_result"]["content"][0]["text"])
    assert slim["number"] == 5
    assert slim["labels"] == ["agent:backend-api-developer"]
    assert "user" not in slim


def test_sanitize_strands_tool_result_event_instance_preserves_tool_use_id():
    from strands.types._events import ToolResultEvent

    issue = {"number": 5, "title": "Health check", "body": "x", "state": "open", "labels": []}
    event = ToolResultEvent(
        {
            "toolUseId": "tooluse-strands-456",
            "status": "success",
            "content": [{"text": json.dumps(issue)}],
        }
    )
    out = sanitize_tool_result("github___github_get_issue", event)
    assert out["tool_result"]["toolUseId"] == "tooluse-strands-456"
    slim = json.loads(out["tool_result"]["content"][0]["text"])
    assert slim["number"] == 5


def test_github_exploration_budget_blocks_duplicate_file_read():
    GithubExplorationBudget.clear()
    tool = "github___github_get_file_content"
    args = ()
    kwargs = {"path": "openapi.yaml", "ref": "main"}
    assert check_github_exploration_budget(tool, args, kwargs) is None
    blocked = check_github_exploration_budget(tool, args, kwargs)
    assert blocked is not None
    assert "GITHUB_EXPLORATION_BUDGET_EXCEEDED" in blocked


def test_github_exploration_budget_blocks_extra_issue_fetch():
    GithubExplorationBudget.clear()
    tool = "github___github_get_issue"
    assert check_github_exploration_budget(tool, (), {"issue_number": 3}) is None
    blocked = check_github_exploration_budget(tool, (), {"issue_number": 3})
    assert blocked is not None


def test_augment_system_prompt_adds_github_efficiency():
    tools = [_FakeTool("github___github_get_issue")]
    out = augment_system_prompt_with_github_efficiency("Base prompt.", tools)
    assert "GITHUB MCP EFFICIENCY" in out
    assert "8" in out
    assert "GITHUB_EXPLORATION_BUDGET_EXCEEDED" in out


def test_augment_system_prompt_no_github_tools_unchanged():
    base = "Base prompt."
    assert augment_system_prompt_with_github_efficiency(base, []) == base


def test_create_boto_config_uses_read_timeout():
    from gaab_strands_common.utils.helpers import create_boto_config

    config = create_boto_config("us-east-1")
    assert config.read_timeout == 840
    assert config.connect_timeout == 10


def test_create_boto_config_raises_stale_low_env_timeout(monkeypatch):
    from gaab_strands_common.utils.helpers import create_boto_config

    monkeypatch.setenv("BEDROCK_READ_TIMEOUT", "300")
    config = create_boto_config("us-east-1")
    assert config.read_timeout == 840
