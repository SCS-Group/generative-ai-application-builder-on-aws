# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from gaab_strands_common.aiw_api_key_token import (
    github_api_key_provider_name,
    _normalize_api_key,
    agent_workload_name,
)


def test_github_api_key_provider_name():
    assert github_api_key_provider_name("8d8480cc-6b5f-4d3f-b281-94a697de224a") == "aiw-custom-8d8480cc-github"


def test_normalize_api_key_json_wrapper():
    assert _normalize_api_key('{"api_key_value":"Bearer ghs_test"}') == "Bearer ghs_test"


def test_agent_workload_name_from_use_case_uuid(monkeypatch):
    monkeypatch.setenv("USE_CASE_UUID", "5c87d3f4-c05e-486f-b345-3b49179c13c2")
    monkeypatch.delenv("AIW_AGENT_WORKLOAD_NAME", raising=False)
    assert agent_workload_name() == "gaab_agent_5c87d3f4"


def test_agent_workload_name_prefers_explicit_env(monkeypatch):
    monkeypatch.setenv("AIW_AGENT_WORKLOAD_NAME", "gaab_agent_b1922e14-uc8KZ0BG97")
    monkeypatch.setenv("USE_CASE_UUID", "5c87d3f4-c05e-486f-b345-3b49179c13c2")
    assert agent_workload_name() == "gaab_agent_b1922e14-uc8KZ0BG97"
