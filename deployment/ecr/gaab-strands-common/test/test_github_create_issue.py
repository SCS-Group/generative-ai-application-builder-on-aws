# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
from unittest.mock import patch

import pytest

from gaab_strands_common.aiw_env import AIW_POLICY_ALLOW_ISSUE_CREATE_ENV, AIW_TENANT_ENV


@pytest.fixture(autouse=True)
def tenant_env():
    with patch.dict(os.environ, {AIW_TENANT_ENV: "tenant-test-12345678"}, clear=False):
        yield


def test_github_create_issue_calls_rest_and_returns_issue():
    from gaab_strands_common.aiw_github_tool import load_aiw_github_tools

    tools = {t.tool_name if hasattr(t, "tool_name") else t.name: t for t in load_aiw_github_tools("us-east-1")}
    create = tools.get("github_create_issue")
    assert create is not None

    created = {
        "number": 47,
        "title": "feat: test",
        "html_url": "https://github.com/o/r/issues/47",
        "labels": [{"name": "agent:groom"}],
    }

    with (
        patch.dict(os.environ, {AIW_POLICY_ALLOW_ISSUE_CREATE_ENV: "true"}, clear=False),
        patch("gaab_strands_common.aiw_github_tool._request", return_value=created) as req,
    ):
        out = json.loads(create(title="feat: test", body="Epic #46", labels="agent:groom"))

    assert out["number"] == 47
    req.assert_called_once()
    assert req.call_args[0][1] == "POST"
    assert req.call_args[0][2] == "/issues"
    body = req.call_args[1]["json_body"]
    assert body["title"] == "feat: test"
    assert body["labels"] == ["agent:groom"]


def test_github_create_issue_blocked_when_policy_false():
    from gaab_strands_common.aiw_github_tool import load_aiw_github_tools

    tools = {t.tool_name if hasattr(t, "tool_name") else t.name: t for t in load_aiw_github_tools("us-east-1")}
    create = tools.get("github_create_issue")
    assert create is not None

    with patch.dict(os.environ, {AIW_POLICY_ALLOW_ISSUE_CREATE_ENV: "false"}, clear=False):
        with pytest.raises(RuntimeError, match="github_create_issue"):
            create(title="x", body="y")
