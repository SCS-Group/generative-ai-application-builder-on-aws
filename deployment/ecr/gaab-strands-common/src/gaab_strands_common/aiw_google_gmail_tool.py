# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Direct Gmail tools for AIW tenants.

AgentCore Gateway OpenAPI targets with AUTHORIZATION_CODE attempt inline OAuth
elicitation (requires MCP 2025-11-25) when vault lookup fails. This module calls
Gmail REST with tokens from the same vault binding as AIW Connect
(workload gaab-mcp-{prefix} + TenantProfile.tenantId).
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, List, Optional

import httpx
from strands import tool

from gaab_strands_common.aiw_oauth_token import get_user_federation_access_token

logger = logging.getLogger(__name__)

GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
OAUTH_PROVIDER_NAME = "platform-google"
AIW_TENANT_ENV = "AIW_TENANT_ID"
AIW_OAUTH_CALLBACK_ENV = "AIW_OAUTH_CALLBACK_URL"
AIW_OAUTH_WORKLOAD_ENV = "AIW_OAUTH_WORKLOAD_NAME"
AIW_MCP_GATEWAY_USE_CASE_ENV = "AIW_MCP_GATEWAY_USE_CASE_ID"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1"


def gateway_workload_from_mcp_servers(mcp_servers: List[dict[str, str]]) -> Optional[str]:
    for server in mcp_servers:
        if server.get("type") != "gateway":
            continue
        url = server.get("url", "")
        match = re.search(r"(gaab-mcp-[a-f0-9]{8})", url)
        if match:
            return match.group(1)
    return None


def resolve_oauth_workload_name(mcp_servers: List[dict[str, str]]) -> Optional[str]:
    """Vault tokens from AIW Connect are on gaab-mcp-{prefix}, not the agent runtime workload."""
    workload = gateway_workload_from_mcp_servers(mcp_servers)
    if workload:
        return workload
    explicit = os.environ.get(AIW_OAUTH_WORKLOAD_ENV, "").strip()
    if explicit:
        return explicit
    gateway_uc = os.environ.get(AIW_MCP_GATEWAY_USE_CASE_ENV, "").strip()
    if gateway_uc:
        return f"gaab-mcp-{gateway_uc[:8]}"
    return None


def filter_gateway_gmail_mcp_tools(mcp_tools: List[Any]) -> List[Any]:
    """Drop broken gateway Gmail OpenAPI tools so the agent uses direct Gmail tools."""
    kept: List[Any] = []
    for t in mcp_tools:
        name = (getattr(t, "tool_name", None) or getattr(t, "name", None) or "").lower()
        if "gmail" in name:
            logger.info("Skipping gateway MCP tool %s (using direct Gmail API tool)", name)
            continue
        kept.append(t)
    return kept


def _google_access_token(region: str) -> str:
    return get_user_federation_access_token(region, OAUTH_PROVIDER_NAME, [GMAIL_READONLY_SCOPE])


def load_aiw_gmail_tools(region: str, tenant_id: str, mcp_servers: List[dict[str, str]]) -> List[Any]:
    tenant = tenant_id.strip()
    if not tenant:
        logger.warning("AIW Gmail direct tools skipped: no tenant id")
        return []

    logger.info("Loading direct Gmail tools (runtime vault, tenant=%s…)", tenant[:8])

    @tool
    def list_gmail_messages(max_results: int = 5) -> str:
        """
        List recent messages from the workspace's connected Gmail inbox.

        Returns subject, from, date, and snippet for each message. Use this for
        "list my emails", "recent Gmail", or inbox summaries.

        Args:
            max_results: How many messages to return (1–20, default 5).
        """
        limit = max(1, min(int(max_results), 20))
        token = _google_access_token(region)
        headers = {"Authorization": f"Bearer {token}"}
        with httpx.Client(timeout=30.0) as client:
            list_resp = client.get(
                f"{GMAIL_API}/users/me/messages",
                headers=headers,
                params={"maxResults": limit, "labelIds": ["INBOX"]},
            )
            list_resp.raise_for_status()
            message_refs = list_resp.json().get("messages", [])[:limit]

            lines: List[str] = []
            for ref in message_refs:
                mid = ref.get("id")
                if not mid:
                    continue
                detail = client.get(
                    f"{GMAIL_API}/users/me/messages/{mid}",
                    headers=headers,
                    params={"format": "metadata", "metadataHeaders": ["Subject", "From", "Date"]},
                )
                detail.raise_for_status()
                payload = detail.json()
                hdrs = {h["name"]: h["value"] for h in payload.get("payload", {}).get("headers", [])}
                subject = hdrs.get("Subject", "(no subject)")
                sender = hdrs.get("From", "(unknown)")
                date = hdrs.get("Date", "")
                snippet = payload.get("snippet", "")
                lines.append(f"- **{subject}**\n  From: {sender}\n  Date: {date}\n  {snippet}")

        if not lines:
            return "No messages found in INBOX."
        return f"Recent Gmail messages ({len(lines)}):\n\n" + "\n\n".join(lines)

    return [list_gmail_messages]
