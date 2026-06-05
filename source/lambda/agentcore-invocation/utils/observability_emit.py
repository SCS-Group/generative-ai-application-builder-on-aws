#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Fire-and-forget EventBridge tap for AIW Operations Monitor (default bus)."""

import json
import os
import time
from typing import Any, Dict, Optional

from aws_lambda_powertools import Logger

logger = Logger(utc=True)

OBSERVABILITY_SOURCE = "gaab.observability"
OBSERVABILITY_DETAIL_TYPE = "WorkflowObservabilityEvent"
OBSERVABILITY_ENABLED_ENV = "OBSERVABILITY_EMIT_ENABLED"
USE_CASE_TYPE_ENV = "GAAB_USE_CASE_TYPE"
USE_CASE_UUID_ENV = "USE_CASE_UUID"

THINKING_MIN_INTERVAL_SEC = 2.0
MAX_THINKING_EVENTS_PER_SESSION = 120

_eb_client = None
_last_thinking_emit: Dict[str, float] = {}
_thinking_emit_count: Dict[str, int] = {}
_last_tool_status: Dict[str, str] = {}


def _enabled() -> bool:
    raw = os.environ.get(OBSERVABILITY_ENABLED_ENV, "true").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _agent_kind() -> str:
    raw = os.environ.get(USE_CASE_TYPE_ENV, "specialist").strip().lower()
    return "workflow" if raw == "workflow" else "specialist"


def _get_eb_client():
    global _eb_client
    if _eb_client is None:
        import boto3

        _eb_client = boto3.client("events")
    return _eb_client


def _session_key(conversation_id: str) -> str:
    return conversation_id or "unknown"


def _tool_key(conversation_id: str, tool_name: str) -> str:
    return f"{conversation_id}:{tool_name}"


def emit_observability_event(
    *,
    aiw_tenant_id: str,
    gaab_use_case_id: str,
    conversation_id: str,
    message_id: Optional[str],
    event_type: str,
    payload: Optional[Dict[str, Any]] = None,
) -> None:
    """Best-effort PutEvents — never raises to caller."""
    if not _enabled():
        return
    tenant = (aiw_tenant_id or "").strip()
    use_case = (gaab_use_case_id or os.environ.get(USE_CASE_UUID_ENV) or "").strip()
    conv = (conversation_id or "").strip()
    if not tenant or not use_case or not conv:
        return

    detail = {
        "aiwTenantId": tenant,
        "gaabUseCaseId": use_case,
        "useCaseUuid": use_case,
        "conversationId": conv,
        "messageId": message_id or "",
        "eventType": event_type,
        "agentKind": _agent_kind(),
        "payload": payload or {},
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    try:
        _get_eb_client().put_events(
            Entries=[
                {
                    "Source": OBSERVABILITY_SOURCE,
                    "DetailType": OBSERVABILITY_DETAIL_TYPE,
                    "Detail": json.dumps(detail, default=str),
                }
            ]
        )
    except Exception as exc:
        logger.warning("Observability PutEvents skipped: %s", exc)


def maybe_emit_thinking(
    *,
    aiw_tenant_id: str,
    gaab_use_case_id: str,
    conversation_id: str,
    message_id: Optional[str],
    thinking_message: str,
) -> None:
    key = _session_key(conversation_id)
    count = _thinking_emit_count.get(key, 0)
    if count >= MAX_THINKING_EVENTS_PER_SESSION:
        return
    now = time.time()
    last = _last_thinking_emit.get(key, 0.0)
    if now - last < THINKING_MIN_INTERVAL_SEC:
        return
    _last_thinking_emit[key] = now
    _thinking_emit_count[key] = count + 1
    text = (thinking_message or "")[:500]
    if not text:
        return
    emit_observability_event(
        aiw_tenant_id=aiw_tenant_id,
        gaab_use_case_id=gaab_use_case_id,
        conversation_id=conversation_id,
        message_id=message_id,
        event_type="thinking",
        payload={"thinkingMessage": text},
    )


def maybe_emit_tool_use(
    *,
    aiw_tenant_id: str,
    gaab_use_case_id: str,
    conversation_id: str,
    message_id: Optional[str],
    tool_usage: Dict[str, Any],
) -> None:
    tool_name = str(tool_usage.get("toolName") or "")
    status = str(tool_usage.get("status") or "")
    if not tool_name or not status:
        return
    tk = _tool_key(conversation_id, tool_name)
    prev = _last_tool_status.get(tk)
    if prev == status:
        return
    _last_tool_status[tk] = status

    payload: Dict[str, Any] = {
        "toolName": tool_name,
        "status": status,
        "startTime": tool_usage.get("startTime"),
    }
    if tool_usage.get("error"):
        payload["error"] = str(tool_usage.get("error"))[:300]
    if tool_usage.get("mcpServerName"):
        payload["mcpServerName"] = str(tool_usage.get("mcpServerName"))

    emit_observability_event(
        aiw_tenant_id=aiw_tenant_id,
        gaab_use_case_id=gaab_use_case_id,
        conversation_id=conversation_id,
        message_id=message_id,
        event_type="tool_use",
        payload=payload,
    )


def emit_error(
    *,
    aiw_tenant_id: str,
    gaab_use_case_id: str,
    conversation_id: str,
    message_id: Optional[str],
    error_message: str,
) -> None:
    emit_observability_event(
        aiw_tenant_id=aiw_tenant_id,
        gaab_use_case_id=gaab_use_case_id,
        conversation_id=conversation_id,
        message_id=message_id,
        event_type="error",
        payload={"message": (error_message or "")[:500]},
    )


def emit_completion(
    *,
    aiw_tenant_id: str,
    gaab_use_case_id: str,
    conversation_id: str,
    message_id: Optional[str],
) -> None:
    emit_observability_event(
        aiw_tenant_id=aiw_tenant_id,
        gaab_use_case_id=gaab_use_case_id,
        conversation_id=conversation_id,
        message_id=message_id,
        event_type="completion",
        payload={},
    )
