# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

from gaab_strands_common.aiw_workload_token import resolve_workload_identity_token


@patch("gaab_strands_common.aiw_workload_token._context_workload_token", return_value="ctx-token")
def test_prefers_context_token(mock_ctx, monkeypatch):
    monkeypatch.setenv("AIW_TENANT_ID", "8d8480cc-6b5f-4d3f-b281-94a697de224a")
    assert resolve_workload_identity_token("us-east-1") == "ctx-token"
    mock_ctx.assert_called_once()


@patch("gaab_strands_common.aiw_workload_token._context_workload_token", return_value=None)
@patch("gaab_strands_common.aiw_workload_token.boto3.client")
def test_falls_back_to_gateway_workload(mock_boto, _mock_ctx, monkeypatch):
    monkeypatch.setenv("AIW_TENANT_ID", "8d8480cc-6b5f-4d3f-b281-94a697de224a")
    monkeypatch.setenv("AIW_OAUTH_WORKLOAD_NAME", "gaab-mcp-b518c55c")
    client = MagicMock()
    client.get_workload_access_token_for_user_id.return_value = {"workloadAccessToken": "gw-token"}
    mock_boto.return_value = client

    assert resolve_workload_identity_token("us-east-1") == "gw-token"
    client.get_workload_access_token_for_user_id.assert_called_once_with(
        workloadName="gaab-mcp-b518c55c",
        userId="8d8480cc-6b5f-4d3f-b281-94a697de224a",
    )
