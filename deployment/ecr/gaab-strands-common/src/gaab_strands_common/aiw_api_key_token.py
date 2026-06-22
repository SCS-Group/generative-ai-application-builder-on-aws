# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Resolve API-key credential providers from AgentCore vault (GitHub App installation tokens)."""

from __future__ import annotations

import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

from gaab_strands_common.aiw_env import AIW_TENANT_ENV
from gaab_strands_common.aiw_workload_token import resolve_workload_identity_token

logger = logging.getLogger(__name__)

AIW_GITHUB_OWNER_ENV = "AIW_GITHUB_OWNER"
AIW_GITHUB_REPO_ENV = "AIW_GITHUB_REPO"
AIW_GITHUB_API_KEY_PROVIDER_ENV = "AIW_GITHUB_API_KEY_PROVIDER_NAME"
AIW_GITHUB_API_KEY_SECRET_ID_ENV = "AIW_GITHUB_API_KEY_SECRET_ID"
USE_CASE_UUID_ENV = "USE_CASE_UUID"
AIW_AGENT_WORKLOAD_ENV = "AIW_AGENT_WORKLOAD_NAME"
AIW_DISABLE_GITHUB_DIRECT_ENV = "AIW_DISABLE_GITHUB_DIRECT"


def github_direct_tools_disabled() -> bool:
    """Workflow orchestrators must not load GitHub REST tools (delegate to specialists + delivery sessions)."""
    flag = os.environ.get(AIW_DISABLE_GITHUB_DIRECT_ENV, "").strip().lower()
    if flag in ("1", "true", "yes"):
        return True
    workload = os.environ.get(AIW_AGENT_WORKLOAD_ENV, "").strip()
    return workload.startswith("gaab_workflow_")


def github_api_key_provider_name(tenant_id: str) -> str:
    prefix = tenant_id.strip()[:8]
    return f"aiw-custom-{prefix}-github"


def _normalize_api_key(raw: str) -> str:
    value = raw.strip()
    if not value:
        raise RuntimeError("GitHub API key credential provider returned an empty value.")
    if value.startswith("{") and value.endswith("}"):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return value
        if isinstance(parsed, dict):
            nested = parsed.get("api_key_value")
            if isinstance(nested, str) and nested.strip():
                return nested.strip()
    return value


def agent_workload_name() -> str:
    """Agent runtime workload (not the MCP gateway workload)."""
    explicit = os.environ.get(AIW_AGENT_WORKLOAD_ENV, "").strip()
    if explicit:
        return explicit
    use_case = os.environ.get(USE_CASE_UUID_ENV, "").strip()
    if use_case:
        return f"gaab_agent_{use_case.split('-')[0]}"
    raise RuntimeError(
        "Cannot resolve agent workload name; set AIW_AGENT_WORKLOAD_NAME or USE_CASE_UUID on the runtime."
    )


def get_api_key_from_secrets_manager(region: str, secret_id: str) -> str:
    """Read installation token via GetSecretValue (agent role has no ListSecrets)."""
    sm = boto3.client("secretsmanager", region_name=region)
    resp = sm.get_secret_value(SecretId=secret_id.strip())
    return _normalize_api_key(str(resp.get("SecretString") or ""))


def _get_resource_api_key(region: str, tenant_id: str, provider_name: str) -> str:
    workload_token = resolve_workload_identity_token(region, tenant_id)
    client = boto3.client("bedrock-agentcore", region_name=region)
    try:
        response = client.get_resource_api_key(
            workloadIdentityToken=workload_token,
            resourceCredentialProviderName=provider_name.strip(),
        )
    except ClientError as e:
        msg = e.response.get("Error", {}).get("Message", str(e))
        raise RuntimeError(
            f"Could not read GitHub API key for {provider_name}: {msg}"
        ) from e
    return _normalize_api_key(str(response.get("apiKey") or ""))


def get_resource_api_key_header(region: str, provider_name: str) -> str:
    """
    Return Authorization header for a GitHub App installation token (Bearer ghs_…).

    Uses the runtime-delivered WorkloadAccessToken from BedrockAgentCoreContext when
    available. Optional AIW_GITHUB_API_KEY_SECRET_ID skips vault API calls.
    """
    tenant = os.environ.get(AIW_TENANT_ENV, "").strip()
    if not tenant:
        raise RuntimeError("GitHub direct tools require AIW_TENANT_ID on the agent runtime.")

    secret_id = os.environ.get(AIW_GITHUB_API_KEY_SECRET_ID_ENV, "").strip()
    if secret_id:
        api_key = get_api_key_from_secrets_manager(region, secret_id)
        return _auth_header(api_key)

    api_key = _get_resource_api_key(region, tenant, provider_name)
    return _auth_header(api_key)


def _auth_header(api_key: str) -> str:
    if api_key.lower().startswith("bearer "):
        return api_key
    return f"Bearer {api_key}"
