# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Direct GitHub REST tools for AIW tenants.

AgentCore Gateway OpenAPI targets return "An internal error occurred" for several GitHub
write/read paths (pulls, issue comments) while contents/git refs work. Direct REST calls
with the same installation token from AgentCore vault bypass the gateway (Gmail/Figma pattern).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, List, Optional

import httpx
from strands import tool

from gaab_strands_common.aiw_api_key_token import (
    AIW_GITHUB_OWNER_ENV,
    AIW_GITHUB_REPO_ENV,
    AIW_GITHUB_API_KEY_PROVIDER_ENV,
    get_resource_api_key_header,
    github_api_key_provider_name,
    github_direct_tools_disabled,
)
from gaab_strands_common.aiw_env import (
    AIW_POLICY_ALLOW_ISSUE_CREATE_ENV,
    AIW_POLICY_ALLOW_ISSUE_EDIT_ENV,
    AIW_POLICY_ALLOW_MERGE_ENV,
    AIW_POLICY_ALLOW_PULL_REQUEST_CREATE_ENV,
    AIW_POLICY_ALLOW_PULL_REQUEST_REVIEW_ENV,
    AIW_TENANT_ENV,
)

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def _tool_name(t: Any) -> str:
    return (getattr(t, "tool_name", None) or getattr(t, "name", None) or "").strip()


def is_github_mcp_tool(t: Any) -> bool:
    name = _tool_name(t).lower()
    return "github" in name and any(
        token in name
        for token in ("github_get_", "github_list_", "github_create_", "github_add_", "github_merge_")
    )


def filter_gateway_github_mcp_tools(mcp_tools: List[Any]) -> List[Any]:
    """Drop gateway GitHub MCP tools when direct REST tools load or GitHub is disabled on orchestrator."""
    disabled = github_direct_tools_disabled()
    kept: List[Any] = []
    for t in mcp_tools:
        if is_github_mcp_tool(t):
            reason = (
                "workflow orchestrator (AIW_DISABLE_GITHUB_DIRECT)"
                if disabled
                else "using direct GitHub REST"
            )
            logger.info("Skipping gateway MCP tool %s (%s)", _tool_name(t), reason)
            continue
        kept.append(t)
    return kept


def _discover_owner_repo(auth: str) -> tuple[str, str]:
    owner = os.environ.get(AIW_GITHUB_OWNER_ENV, "").strip()
    repo = os.environ.get(AIW_GITHUB_REPO_ENV, "").strip()
    if owner and repo:
        return owner, repo

    headers = {**GITHUB_HEADERS, "Authorization": auth}
    with httpx.Client(timeout=30.0) as client:
        resp = client.get(f"{GITHUB_API}/installation/repositories", headers=headers, params={"per_page": 100})
    if resp.status_code >= 400:
        raise RuntimeError(
            f"Could not list GitHub App installation repositories ({resp.status_code}): {resp.text[:300]}"
        )
    repos = resp.json().get("repositories") or []
    if not repos:
        raise RuntimeError("GitHub App installation has no accessible repositories.")
    if len(repos) == 1:
        row = repos[0]
        return str(row["owner"]["login"]), str(row["name"])
    names = [f"{r['owner']['login']}/{r['name']}" for r in repos if r.get("owner") and r.get("name")]
    raise RuntimeError(
        "Multiple repos on this GitHub App installation; set AIW_GITHUB_OWNER and AIW_GITHUB_REPO on the runtime. "
        f"Accessible: {', '.join(names[:10])}"
    )


def _github_config(region: str) -> tuple[str, str, str]:
    tenant = os.environ.get(AIW_TENANT_ENV, "").strip()
    if not tenant:
        raise RuntimeError(
            "GitHub direct tools require AIW_TENANT_ID on the agent runtime. Re-provision the workspace."
        )
    provider = os.environ.get(AIW_GITHUB_API_KEY_PROVIDER_ENV, "").strip() or github_api_key_provider_name(tenant)
    auth = get_resource_api_key_header(region, provider)
    owner, repo = _discover_owner_repo(auth)
    return owner, repo, auth


def _request(
    region: str,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> Any:
    owner, repo, auth = _github_config(region)
    url = f"{GITHUB_API}/repos/{owner}/{repo}{path}"
    headers = {**GITHUB_HEADERS, "Authorization": auth}
    with httpx.Client(timeout=60.0) as client:
        resp = client.request(method, url, headers=headers, params=params, json=json_body)
    if resp.status_code >= 400:
        detail = resp.text[:500]
        raise RuntimeError(f"GitHub API {method} {path} failed ({resp.status_code}): {detail}")
    if resp.status_code == 204 or not resp.content:
        raise RuntimeError(
            f"GitHub API {method} {path} returned an empty body (status {resp.status_code}). "
            "Check AIW_GITHUB_API_KEY_SECRET_ID or GitHub App installation access to the repo."
        )
    data = resp.json()
    if isinstance(data, dict) and data.get("message") and "number" not in data and "content" not in data:
        raise RuntimeError(
            f"GitHub API {method} {path} error: {data.get('message')} "
            f"(status {resp.status_code}). Verify the installation token can access the repository."
        )
    return data


def _policy_limit_blocks(env_key: str) -> bool:
    flag = os.environ.get(env_key, "").strip().lower()
    return flag in ("false", "no", "0")


def _assert_policy_allows(env_key: str, label: str) -> None:
    if not _policy_limit_blocks(env_key):
        return
    raise RuntimeError(
        f"Workspace policy blocks {label}. Update the attached workspace policy to allow this action."
    )


def load_aiw_github_tools(region: str) -> List[Any]:
    if github_direct_tools_disabled():
        logger.info("GitHub direct tools skipped (workflow orchestrator or AIW_DISABLE_GITHUB_DIRECT)")
        return []

    tenant = os.environ.get(AIW_TENANT_ENV, "").strip()
    if not tenant:
        logger.info("GitHub direct tools skipped (AIW_TENANT_ID not set on runtime)")
        return []

    owner = os.environ.get(AIW_GITHUB_OWNER_ENV, "").strip()
    repo = os.environ.get(AIW_GITHUB_REPO_ENV, "").strip()
    repo_hint = f"{owner}/{repo}" if owner and repo else "auto-discover"
    logger.info(
        "Loading direct GitHub REST tools for %s (tenant %s…)",
        repo_hint,
        tenant[:8],
    )

    @tool
    def github_get_issue(issue_number: int) -> str:
        """Get a GitHub issue by number (title, body, labels, state)."""
        data = _request(region, "GET", f"/issues/{int(issue_number)}")
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_list_issue_comments(issue_number: int) -> str:
        """List comments on a GitHub issue."""
        data = _request(region, "GET", f"/issues/{int(issue_number)}/comments")
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_add_issue_comment(issue_number: int, body: str) -> str:
        """Add a comment on a GitHub issue."""
        data = _request(region, "POST", f"/issues/{int(issue_number)}/comments", json_body={"body": body})
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_create_issue(
        title: str,
        body: str,
        labels: Optional[str] = None,
    ) -> str:
        """Create a GitHub issue. labels: comma-separated e.g. agent:groom."""
        _assert_policy_allows(AIW_POLICY_ALLOW_ISSUE_CREATE_ENV, "github_create_issue")
        payload: dict[str, Any] = {"title": title.strip(), "body": body}
        label_list = [part.strip() for part in (labels or "").split(",") if part.strip()]
        if label_list:
            payload["labels"] = label_list
        data = _request(region, "POST", "/issues", json_body=payload)
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_update_issue(
        issue_number: int,
        title: Optional[str] = None,
        body: Optional[str] = None,
        labels: Optional[str] = None,
    ) -> str:
        """Update a GitHub issue title, body, and/or labels (comma-separated)."""
        _assert_policy_allows(AIW_POLICY_ALLOW_ISSUE_EDIT_ENV, "github_update_issue")
        payload: dict[str, Any] = {}
        if title is not None and title.strip():
            payload["title"] = title.strip()
        if body is not None:
            payload["body"] = body
        label_list = [part.strip() for part in (labels or "").split(",") if part.strip()]
        if label_list:
            payload["labels"] = label_list
        if not payload:
            raise RuntimeError("github_update_issue requires at least one of title, body, or labels")
        data = _request(region, "PATCH", f"/issues/{int(issue_number)}", json_body=payload)
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_get_file_content(path: str, ref: Optional[str] = None) -> str:
        """Get file contents from the repository (decoded UTF-8 when possible)."""
        params = {"ref": ref} if ref else None
        data = _request(region, "GET", f"/contents/{path.lstrip('/')}", params=params)
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_create_or_update_file(
        path: str,
        message: str,
        content: str,
        branch: str,
        sha: Optional[str] = None,
    ) -> str:
        """Create or update a file on a branch. content must be base64-encoded file bytes."""
        body: dict[str, Any] = {"message": message, "content": content, "branch": branch}
        if sha:
            body["sha"] = sha
        data = _request(region, "PUT", f"/contents/{path.lstrip('/')}", json_body=body)
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_get_ref(ref: str) -> str:
        """Get a branch or tag ref (commit SHA for branching). Pass short ref e.g. heads/main."""
        short = ref.strip()
        if short.startswith("refs/"):
            short = short.split("/", 2)[-1] if short.count("/") >= 2 else short.replace("refs/", "", 1)
        data = _request(region, "GET", f"/git/ref/{short}")
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_create_ref(ref: str, sha: str) -> str:
        """Create a branch ref from a commit SHA (full ref e.g. refs/heads/feature/1-api)."""
        data = _request(region, "POST", "/git/refs", json_body={"ref": ref, "sha": sha})
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_list_pulls(
        state: Optional[str] = "open",
        head: Optional[str] = None,
        base: Optional[str] = None,
    ) -> str:
        """List pull requests (optional filters: state, head branch, base branch)."""
        params: dict[str, str] = {}
        if state:
            params["state"] = state
        if head:
            params["head"] = head
        if base:
            params["base"] = base
        data = _request(region, "GET", "/pulls", params=params or None)
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_create_pull(
        title: str,
        head: str,
        base: str,
        body: Optional[str] = None,
        draft: Optional[bool] = None,
    ) -> str:
        """Open a pull request."""
        _assert_policy_allows(AIW_POLICY_ALLOW_PULL_REQUEST_CREATE_ENV, "github_create_pull")
        payload: dict[str, Any] = {"title": title, "head": head, "base": base}
        if body is not None:
            payload["body"] = body
        if draft is not None:
            payload["draft"] = draft
        data = _request(region, "POST", "/pulls", json_body=payload)
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_create_pull_review(pull_number: int, body: str, event: str) -> str:
        """Create a pull request review (COMMENT, APPROVE, or REQUEST_CHANGES)."""
        _assert_policy_allows(AIW_POLICY_ALLOW_PULL_REQUEST_REVIEW_ENV, "github_create_pull_review")
        data = _request(
            region,
            "POST",
            f"/pulls/{int(pull_number)}/reviews",
            json_body={"body": body, "event": event},
        )
        return json.dumps(data, ensure_ascii=False)

    @tool
    def github_merge_pull(
        pull_number: int,
        merge_method: Optional[str] = None,
        commit_title: Optional[str] = None,
        commit_message: Optional[str] = None,
    ) -> str:
        """Merge a pull request. Blocked only when attached workspace policy sets Allow Merge to no."""
        _assert_policy_allows(AIW_POLICY_ALLOW_MERGE_ENV, "github_merge_pull")
        payload: dict[str, Any] = {}
        if merge_method:
            payload["merge_method"] = merge_method
        if commit_title:
            payload["commit_title"] = commit_title
        if commit_message:
            payload["commit_message"] = commit_message
        data = _request(
            region,
            "PUT",
            f"/pulls/{int(pull_number)}/merge",
            json_body=payload or None,
        )
        return json.dumps(data, ensure_ascii=False)

    return [
        github_get_issue,
        github_list_issue_comments,
        github_add_issue_comment,
        github_create_issue,
        github_update_issue,
        github_get_file_content,
        github_create_or_update_file,
        github_get_ref,
        github_create_ref,
        github_list_pulls,
        github_create_pull,
        github_create_pull_review,
        github_merge_pull,
    ]
