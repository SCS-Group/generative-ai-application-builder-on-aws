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

from gaab_strands_common.aiw_env import AIW_OAUTH_CALLBACK_ENV, AIW_OAUTH_WORKLOAD_ENV, AIW_TENANT_ENV
from gaab_strands_common.aiw_oauth_token import get_user_federation_access_token

logger = logging.getLogger(__name__)

FIGMA_API = "https://api.figma.com"
OAUTH_PROVIDER_NAME = "platform-figma"
FIGMA_SCOPES = [
    "current_user:read",
    "file_content:read",
    "file_metadata:read",
    "project_metadata:read",
    "projects:read",
    "file_comments:read",
    "file_comments:write",
    "file_dev_resources:read",
    "file_dev_resources:write",
]
AIW_FIGMA_PROXY_ENV = "AIW_FIGMA_TOOL_PROXY_LAMBDA"
AIW_FIGMA_TEMPLATE_FILE_KEY_ENV = "AIW_FIGMA_UX_TEMPLATE_FILE_KEY"
AIW_FIGMA_TEAM_ID_ENV = "AIW_FIGMA_TEAM_ID"
AIW_FIGMA_PROJECT_ID_ENV = "AIW_FIGMA_PROJECT_ID"


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
                "Open AIW Connections for this workspace and click Reconnect (write scopes required)."
            )
        raise RuntimeError(f"Figma proxy failed: {err}")
    return body.get("data") or {}


def _figma_access_token(region: str) -> str:
    return get_user_federation_access_token(region, OAUTH_PROVIDER_NAME, FIGMA_SCOPES)


def _format_json(data: Any, max_len: int = 120_000) -> str:
    text = json.dumps(data, indent=2) if not isinstance(data, str) else data
    if len(text) > max_len:
        return text[:max_len] + f"\n… truncated ({len(text)} chars total)"
    return text


def _proxy_or_http(region: str, use_proxy: bool, proxy_payload: dict[str, Any], http_call) -> Any:
    if use_proxy:
        return _invoke_figma_proxy(region, proxy_payload)
    return http_call()


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
    template_file_key = os.environ.get(AIW_FIGMA_TEMPLATE_FILE_KEY_ENV, "").strip()
    logger.info(
        "Loading direct Figma tools (tenant=%s… via %s, template=%s)",
        tenant[:8],
        "lambda-proxy" if use_proxy else "runtime-http",
        template_file_key[:8] + "…" if template_file_key else "(none)",
    )

    @tool
    def figma_get_my_profile() -> str:
        """
        Get the connected Figma user's profile (email, handle, name).

        Use before listing team projects or creating flow files.
        """
        data = _proxy_or_http(
            region,
            use_proxy,
            {"operation": "me"},
            lambda: httpx.get(f"{FIGMA_API}/v1/me", headers={"Authorization": f"Bearer {_figma_access_token(region)}"}, timeout=30).json(),
        )
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

        Team id is in the URL: figma.com/files/team/<team_id>/...

        Args:
            team_id: Numeric team id from the Figma team page URL.
        """
        tid = team_id.strip()
        if not tid:
            return "team_id is required (from your Figma team URL, segment after /team/)."
        data = _invoke_figma_proxy(region, {"operation": "team_projects", "teamId": tid}) if use_proxy else None
        if data is None:
            token = _figma_access_token(region)
            with httpx.Client(timeout=30.0) as client:
                resp = client.get(f"{FIGMA_API}/v1/teams/{tid}/projects", headers={"Authorization": f"Bearer {token}"})
                resp.raise_for_status()
                data = resp.json()
        projects = data.get("projects") or []
        if not projects:
            return f"No projects found for team {tid} (team name: {data.get('name', 'unknown')})."
        lines = [f"Projects in team {data.get('name', tid)}:"]
        for p in projects:
            lines.append(f"- {p.get('name', '(unnamed)')} (id: {p.get('id', '')})")
        return "\n".join(lines)

    @tool
    def figma_list_project_files(project_id: str) -> str:
        """
        List design files in a Figma project.

        Args:
            project_id: Project id from figma_list_team_projects.
        """
        pid = project_id.strip()
        if not pid:
            return "project_id is required."
        data = _invoke_figma_proxy(region, {"operation": "project_files", "projectId": pid})
        files = data.get("files") or []
        if not files:
            return f"No files in project {pid}."
        lines = [f"Files in project {pid}:"]
        for f in files:
            key = f.get("key", "")
            lines.append(f"- {f.get('name', '(unnamed)')} (key: {key}, url: https://www.figma.com/design/{key})")
        return "\n".join(lines)

    @tool
    def figma_get_file(file_key: str, depth: int = 2) -> str:
        """
        Read a Figma file structure (pages, frames, components).

        Prefer depth=1 or 2 for large files. Use figma_get_file_nodes for specific frames.

        Args:
            file_key: File key from the Figma URL (figma.com/design/<file_key>/...).
            depth: Tree depth (default 2 = pages + top-level frames).
        """
        key = file_key.strip()
        if not key:
            return "file_key is required."
        data = _invoke_figma_proxy(region, {"operation": "file_get", "fileKey": key, "depth": depth})
        return _format_json(data)

    @tool
    def figma_get_file_nodes(file_key: str, node_ids: str, depth: int = 2) -> str:
        """
        Read specific nodes from a Figma file.

        Args:
            file_key: Figma file key.
            node_ids: Comma-separated node ids (e.g. "1:2,1:3" from node-id URL param with : not -).
            depth: Subtree depth (default 2).
        """
        key = file_key.strip()
        ids = node_ids.strip()
        if not key or not ids:
            return "file_key and node_ids are required."
        data = _invoke_figma_proxy(
            region,
            {"operation": "file_nodes", "fileKey": key, "nodeIds": ids, "depth": depth},
        )
        return _format_json(data)

    @tool
    def figma_render_images(file_key: str, node_ids: str, scale: float = 1.0) -> str:
        """
        Render PNG exports of Figma nodes (returns temporary image URLs).

        Args:
            file_key: Figma file key.
            node_ids: Comma-separated node ids to render.
            scale: Export scale 0.01–4 (default 1).
        """
        key = file_key.strip()
        ids = node_ids.strip()
        if not key or not ids:
            return "file_key and node_ids are required."
        data = _invoke_figma_proxy(
            region,
            {"operation": "file_images", "fileKey": key, "nodeIds": ids, "scale": scale, "format": "png"},
        )
        return _format_json(data)

    @tool
    def figma_post_comment(file_key: str, message: str) -> str:
        """
        Post a comment on a Figma file (pin notes on the canvas for collaborators).

        Args:
            file_key: Target file key.
            message: Comment text (flow notes, screen labels, open questions).
        """
        key = file_key.strip()
        msg = message.strip()
        if not key or not msg:
            return "file_key and message are required."
        data = _invoke_figma_proxy(region, {"operation": "post_comment", "fileKey": key, "message": msg})
        return f"Comment posted.\n{_format_json(data, 4000)}"

    @tool
    def figma_create_project(team_id: str, project_name: str) -> str:
        """
        Create a new Figma project in a team (for organizing UX flow files).

        Args:
            team_id: Team id from figma.com/files/team/<team_id>/...
            project_name: Human-readable project name (e.g. "PM Suite UX Flows").
        """
        tid = team_id.strip()
        name = project_name.strip()
        if not tid or not name:
            return "team_id and project_name are required."
        data = _invoke_figma_proxy(
            region,
            {"operation": "create_project", "team_id": tid, "projectName": name},
        )
        project_id = None
        if isinstance(data, dict):
            meta = data.get("meta")
            if isinstance(meta, list) and meta:
                project_id = meta[0].get("id")
            project_id = project_id or data.get("id")
        return f"Project created: {name}\nproject_id={project_id or '(see response)'}\n{_format_json(data, 4000)}"

    @tool
    def figma_copy_file_to_project(template_file_key: str, project_id: str, new_file_name: str = "") -> str:
        """
        Copy a Figma file into a project (duplicate a UX flow template).

        Use AIW_FIGMA_UX_TEMPLATE_FILE_KEY when no template is specified in the prompt.
        After copy, optionally rename with new_file_name.

        Args:
            template_file_key: Source file key to duplicate (blank template with frames). Empty uses workspace template env.
            project_id: Destination project id from figma_list_team_projects / figma_create_project.
            new_file_name: Optional rename after copy (e.g. "Issue #46 — Application feature").
        """
        src_key = template_file_key.strip() or os.environ.get(AIW_FIGMA_TEMPLATE_FILE_KEY_ENV, "").strip()
        pid = project_id.strip()
        if not src_key:
            return (
                "template_file_key is required (or set AIW_FIGMA_UX_TEMPLATE_FILE_KEY on the workspace). "
                "Provide a team UX template file key."
            )
        if not pid:
            return "project_id is required."
        data = _invoke_figma_proxy(
            region,
            {"operation": "copy_file", "templateFileKey": src_key, "projectId": pid},
        )
        new_key = None
        if isinstance(data, dict):
            meta = data.get("meta") or {}
            if isinstance(meta, dict):
                new_key = meta.get("key")
            elif isinstance(meta, list) and meta:
                new_key = meta[0].get("key")
        rename = new_file_name.strip()
        if new_key and rename:
            _invoke_figma_proxy(
                region,
                {"operation": "rename_file", "projectId": pid, "fileKey": new_key, "fileName": rename},
            )
        url = f"https://www.figma.com/design/{new_key}" if new_key else "(copy response below)"
        return f"File copied to project {pid}.\nURL: {url}\n{_format_json(data, 4000)}"

    @tool
    def figma_create_flow_file(
        team_id: str,
        project_id: str,
        file_name: str,
        template_file_key: str = "",
    ) -> str:
        """
        Create a UX flow file by copying the workspace template into a project.

        End-to-end helper: copies template → renames → returns Figma URL for handoff.

        Args:
            team_id: Figma team id (used only when project_id is empty to find/create project).
            project_id: Existing project id, or empty to use first project in team.
            file_name: Name for the new flow file.
            template_file_key: Optional override; defaults to AIW_FIGMA_UX_TEMPLATE_FILE_KEY.
        """
        tpl = template_file_key.strip() or os.environ.get(AIW_FIGMA_TEMPLATE_FILE_KEY_ENV, "").strip()
        if not tpl:
            return (
                "No UX template file configured. Set AIW_FIGMA_UX_TEMPLATE_FILE_KEY on the workspace "
                "or pass template_file_key (a blank Figma file with flow frame structure)."
            )
        pid = project_id.strip() or os.environ.get(AIW_FIGMA_PROJECT_ID_ENV, "").strip()
        if not pid:
            tid = team_id.strip() or os.environ.get(AIW_FIGMA_TEAM_ID_ENV, "").strip()
            if not tid:
                return "project_id or team_id (or AIW_FIGMA_TEAM_ID env) is required."
            projects_data = _invoke_figma_proxy(region, {"operation": "team_projects", "teamId": tid})
            projects = projects_data.get("projects") or []
            if not projects:
                return f"No projects in team {tid}. Create one with figma_create_project first."
            pid = str(projects[0].get("id", ""))
        fname = file_name.strip() or "UX Flow"
        return figma_copy_file_to_project(tpl, pid, fname)

    return [
        figma_get_my_profile,
        figma_list_team_projects,
        figma_list_project_files,
        figma_get_file,
        figma_get_file_nodes,
        figma_render_images,
        figma_post_comment,
        figma_create_project,
        figma_copy_file_to_project,
        figma_create_flow_file,
    ]
