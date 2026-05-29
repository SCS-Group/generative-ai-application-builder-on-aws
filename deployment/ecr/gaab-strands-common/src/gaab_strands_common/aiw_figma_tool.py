# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Direct Figma tools for AIW tenants.

AgentCore Runtime egress to api.figma.com returns HTML 403 even with a valid vault
token, so production calls go through the AIW figma-tool-proxy Lambda when configured.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, List

import boto3
import httpx
from botocore.exceptions import ClientError
from strands import tool

from gaab_strands_common.aiw_oauth_token import get_user_federation_access_token

logger = logging.getLogger(__name__)

FIGMA_API = "https://api.figma.com"
OAUTH_PROVIDER_NAME = "platform-figma"
FIGMA_SCOPES = [
    "current_user:read",
    "file_content:read",
    "file_metadata:read",
    "projects:read",
]
AIW_FIGMA_PROXY_ENV = "AIW_FIGMA_TOOL_PROXY_LAMBDA"
AIW_OAUTH_WORKLOAD_ENV = "AIW_OAUTH_WORKLOAD_NAME"
AIW_OAUTH_CALLBACK_ENV = "AIW_OAUTH_CALLBACK_URL"
AIW_TENANT_ENV = "AIW_TENANT_ID"


def _proxy_config() -> dict[str, str] | None:
    fn = os.environ.get(AIW_FIGMA_PROXY_ENV, "").strip()
    tenant = os.environ.get(AIW_TENANT_ENV, "").strip()
    workload = os.environ.get(AIW_OAUTH_WORKLOAD_ENV, "").strip()
    callback = os.environ.get(AIW_OAUTH_CALLBACK_ENV, "").strip()
    if fn and tenant and workload and callback:
        return {
            "function_name": fn,
            "tenant_id": tenant,
            "workload_name": workload,
            "callback_url": callback,
        }
    return None


def _invoke_figma_proxy(region: str, payload: dict[str, Any]) -> dict[str, Any]:
    cfg = _proxy_config()
    if not cfg:
        raise RuntimeError(f"{AIW_FIGMA_PROXY_ENV} is not configured on the agent runtime.")
    client = boto3.client("lambda", region_name=region)
    try:
        resp = client.invoke(
            FunctionName=cfg["function_name"],
            InvocationType="RequestResponse",
            Payload=json.dumps(
                {
                    "tenantId": cfg["tenant_id"],
                    "workloadName": cfg["workload_name"],
                    "callbackUrl": cfg["callback_url"],
                    **payload,
                }
            ).encode("utf-8"),
        )
    except ClientError as e:
        raise RuntimeError(f"Figma proxy Lambda invoke failed: {e}") from e

    raw = resp.get("Payload")
    body = json.loads(raw.read().decode("utf-8")) if raw else {}
    if resp.get("FunctionError"):
        raise RuntimeError(f"Figma proxy Lambda error: {body}")
    if not body.get("ok"):
        code = body.get("code") or ""
        err = body.get("error") or body.get("body") or f"status={body.get('status')}"
        if code in ("NOT_CONNECTED", "NEEDS_REAUTH", "TOKEN_INVALID"):
            raise RuntimeError(
                f"Figma connection needs attention ({code}): {err} "
                "Open AIW Connections for this workspace and click Reconnect."
            )
        raise RuntimeError(f"Figma proxy failed: {err}")
    return body.get("data") or {}


def _figma_access_token(region: str) -> str:
    return get_user_federation_access_token(region, OAUTH_PROVIDER_NAME, FIGMA_SCOPES)


def filter_gateway_figma_mcp_tools(mcp_tools: List[Any]) -> List[Any]:
    """Drop gateway Figma OpenAPI tools so the agent uses direct Figma API tools."""
    kept: List[Any] = []
    for t in mcp_tools:
        name = (getattr(t, "tool_name", None) or getattr(t, "name", None) or "").lower()
        if "figma" in name:
            logger.info("Skipping gateway MCP tool %s (using direct Figma API tool)", name)
            continue
        kept.append(t)
    return kept


def load_aiw_figma_tools(region: str, tenant_id: str, mcp_servers: List[dict[str, str]]) -> List[Any]:
    tenant = tenant_id.strip()
    if not tenant:
        logger.warning("AIW Figma direct tools skipped: no tenant id")
        return []

    use_proxy = _proxy_config() is not None
    logger.info(
        "Loading direct Figma tools (tenant=%s… via %s)",
        tenant[:8],
        "lambda-proxy" if use_proxy else "runtime-http",
    )

    @tool
    def figma_get_my_profile() -> str:
        """
        Get the connected Figma user's profile (email, handle, name).

        Use for "who am I on Figma", profile info, or before listing team projects.
        """
        if use_proxy:
            data = _invoke_figma_proxy(region, {"operation": "me"})
        else:
            token = _figma_access_token(region)
            with httpx.Client(timeout=30.0) as client:
                resp = client.get(f"{FIGMA_API}/v1/me", headers={"Authorization": f"Bearer {token}"})
                if resp.status_code == 403:
                    body = (resp.text or "").strip()[:200]
                    logger.warning("Figma /v1/me 403 (token_len=%s): %s", len(token), body)
                    return (
                        f"Figma returned 403 ({body}). Reconnect Figma in AIW (Connections) for this workspace, "
                        "then start a new chat."
                    )
                resp.raise_for_status()
                data = resp.json()
        return (
            f"Figma profile:\n"
            f"- Name: {data.get('name', '')}\n"
            f"- Handle: {data.get('handle', '')}\n"
            f"- Email: {data.get('email', '')}\n"
            f"- Id: {data.get('id', '')}"
        )

    @tool
    def figma_list_team_projects(team_id: str) -> str:
        """
        List Figma projects in a team.

        You need the team id from the Figma URL: figma.com/files/team/<team_id>/...

        Args:
            team_id: Numeric team id from the Figma team page URL.
        """
        tid = team_id.strip()
        if not tid:
            return "team_id is required (from your Figma team URL, segment after /team/)."
        if use_proxy:
            data = _invoke_figma_proxy(region, {"operation": "team_projects", "teamId": tid})
        else:
            token = _figma_access_token(region)
            with httpx.Client(timeout=30.0) as client:
                resp = client.get(
                    f"{FIGMA_API}/v1/teams/{tid}/projects",
                    headers={"Authorization": f"Bearer {token}"},
                )
                if resp.status_code == 403:
                    return (
                        "Figma returned 403 for team projects. Re-connect Figma in AIW with "
                        "projects:read scope, or verify the team_id."
                    )
                resp.raise_for_status()
                data = resp.json()
        projects = data.get("projects") or []
        if not projects:
            return f"No projects found for team {tid} (team name: {data.get('name', 'unknown')})."
        lines = [f"Projects in team {data.get('name', tid)}:"]
        for p in projects:
            lines.append(f"- {p.get('name', '(unnamed)')} (id: {p.get('id', '')})")
        return "\n".join(lines)

    return [figma_get_my_profile, figma_list_team_projects]
