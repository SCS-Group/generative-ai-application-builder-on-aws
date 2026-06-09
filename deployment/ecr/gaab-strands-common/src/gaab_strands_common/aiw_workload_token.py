# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Resolve workload identity tokens for AgentCore vault API calls.

Service-linked agent runtime workloads cannot call GetWorkloadAccessTokenForUserId
(the API returns ValidationException). Runtime delivers a WorkloadAccessToken on
each invoke when runtimeUserId is set (AIW tenant id).
"""

from __future__ import annotations

import logging
import os

import boto3

from gaab_strands_common.aiw_env import AIW_OAUTH_WORKLOAD_ENV, AIW_TENANT_ENV

logger = logging.getLogger(__name__)


def _context_workload_token() -> str | None:
    try:
        from bedrock_agentcore.runtime.context import BedrockAgentCoreContext
    except ImportError:
        return None
    token = BedrockAgentCoreContext.get_workload_access_token()
    return token.strip() if token and token.strip() else None


def _workload_token_for_user_id(region: str, workload_name: str, tenant_id: str) -> str:
    client = boto3.client("bedrock-agentcore", region_name=region)
    response = client.get_workload_access_token_for_user_id(
        workloadName=workload_name,
        userId=tenant_id,
    )
    token = (response.get("workloadAccessToken") or "").strip()
    if not token:
        raise RuntimeError(
            f"GetWorkloadAccessTokenForUserId returned no token for workload {workload_name}."
        )
    return token


def resolve_workload_identity_token(region: str, tenant_id: str | None = None) -> str:
    """
    Return a workload identity token for GetResourceOauth2Token / GetResourceApiKey.

    Prefer the runtime-delivered token from BedrockAgentCoreContext. Fall back to
    GetWorkloadAccessTokenForUserId on the MCP gateway companion workload for local dev.
    """
    tenant = (tenant_id or os.environ.get(AIW_TENANT_ENV, "")).strip()
    if not tenant:
        raise RuntimeError("AIW_TENANT_ID is required for vault token resolution.")

    context_token = _context_workload_token()
    if context_token:
        logger.debug("Using WorkloadAccessToken from BedrockAgentCoreContext")
        return context_token

    workload = os.environ.get(AIW_OAUTH_WORKLOAD_ENV, "").strip()
    if not workload:
        raise RuntimeError(
            "No runtime WorkloadAccessToken in context and AIW_OAUTH_WORKLOAD_NAME is unset. "
            "Ensure InvokeAgentRuntime passes runtimeUserId (tenant id) so AgentCore delivers "
            "a workload access token, or set AIW_OAUTH_WORKLOAD_NAME for local dev."
        )

    logger.debug(
        "No context WorkloadAccessToken; using GetWorkloadAccessTokenForUserId on %s",
        workload,
    )
    return _workload_token_for_user_id(region, workload, tenant)
