# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Resolve USER_FEDERATION OAuth tokens inside AgentCore Runtime.

AIW Connect stores tokens on the tenant MCP gateway companion workload
(gaab-mcp-{prefix}) keyed by TenantProfile.tenantId.
"""

from __future__ import annotations

import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

AIW_TENANT_ENV = "AIW_TENANT_ID"
AIW_OAUTH_WORKLOAD_ENV = "AIW_OAUTH_WORKLOAD_NAME"
AIW_OAUTH_CALLBACK_ENV = "AIW_OAUTH_CALLBACK_URL"


def _workload_token_for_tenant(region: str, workload_name: str, tenant_id: str) -> str:
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


def get_user_federation_access_token(
    region: str,
    provider_name: str,
    scopes: list[str],
) -> str:
    """
    Return an OAuth access token for provider_name using the AIW tenant vault binding.
    """
    workload = os.environ.get(AIW_OAUTH_WORKLOAD_ENV, "").strip()
    tenant = os.environ.get(AIW_TENANT_ENV, "").strip()
    if not workload or not tenant:
        raise RuntimeError(
            "OAuth is unavailable: AIW_OAUTH_WORKLOAD_NAME and AIW_TENANT_ID must be set on the agent runtime. "
            "Re-provision the workspace or sync runtime env from GAAB."
        )

    workload_token = _workload_token_for_tenant(region, workload, tenant)
    callback = os.environ.get(AIW_OAUTH_CALLBACK_ENV, "").strip()
    if not callback:
        raise RuntimeError("AIW_OAUTH_CALLBACK_URL is not set on the agent runtime.")

    client = boto3.client("bedrock-agentcore", region_name=region)
    try:
        response = client.get_resource_oauth2_token(
            workloadIdentityToken=workload_token,
            resourceCredentialProviderName=provider_name,
            oauth2Flow="USER_FEDERATION",
            scopes=scopes,
            resourceOauth2ReturnUrl=callback,
            forceAuthentication=False,
        )
    except ClientError as e:
        msg = e.response.get("Error", {}).get("Message", str(e))
        raise RuntimeError(f"Could not read OAuth token for {provider_name}: {msg}") from e

    access_token = (response.get("accessToken") or "").strip()
    if access_token:
        logger.info(
            "OAuth token for %s (workload=%s tenant=%s… len=%s prefix=%s)",
            provider_name,
            workload,
            tenant[:8],
            len(access_token),
            access_token[:8],
        )
        return access_token

    if response.get("authorizationUrl"):
        raise RuntimeError(
            f"{provider_name} is not connected for this workspace (no token in AgentCore vault). "
            "Open Connections in AIW, connect the integration, then start a new chat."
        )

    status = response.get("sessionStatus")
    raise RuntimeError(
        f"OAuth token for {provider_name} is not ready (sessionStatus={status}). "
        "Reconnect in AIW Connections and start a new chat."
    )
