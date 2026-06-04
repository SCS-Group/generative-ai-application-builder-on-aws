# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import boto3
from aws_lambda_powertools import Logger, Tracer
from botocore.exceptions import ClientError

from utils.constants import (
    AIW_AGENT_TEMPLATE_ID,
    AIW_SESSION_BILLING_MODEL_ID,
    AIW_SESSION_INCLUDED_PER_MONTH,
    AIW_SESSION_TIER_ID,
    SESSION_BILLING_METERING_TABLE_NAME_ENV_VAR,
    USE_CASE_CONFIG_RECORD_KEY_ENV_VAR,
    USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
    USE_CASE_UUID_ENV_VAR,
)

logger = Logger(utc=True)
tracer = Tracer()


class SessionQuotaExceededError(Exception):
    """Raised when tenant has exhausted included sessions for the billing period."""


def _use_case_short_id() -> str:
    raw = os.environ.get(USE_CASE_UUID_ENV_VAR, "").strip()
    return raw.split("-")[0] if raw else ""


def _load_runtime_env_vars() -> Dict[str, str]:
    table_name = os.environ.get(USE_CASE_CONFIG_TABLE_NAME_ENV_VAR, "").strip()
    config_key = os.environ.get(USE_CASE_CONFIG_RECORD_KEY_ENV_VAR, "").strip()
    if not table_name or not config_key:
        return {}
    try:
        table = boto3.resource("dynamodb").Table(table_name)
        item = table.get_item(Key={"key": config_key}).get("Item") or {}
        config = item.get("config") or {}
        if not isinstance(config, dict):
            return {}
        env_vars = config.get("AgentRuntimeEnvVars") or {}
        if not isinstance(env_vars, dict):
            return {}
        out: Dict[str, str] = {}
        for k, v in env_vars.items():
            if v is not None:
                out[str(k)] = str(v)
        return out
    except Exception as e:
        logger.warning("Could not load AgentRuntimeEnvVars for session billing: %s", e)
        return {}


def _session_billing_config(env_vars: Dict[str, str]) -> Optional[Dict[str, Any]]:
    included_raw = env_vars.get(AIW_SESSION_INCLUDED_PER_MONTH, "").strip()
    if not included_raw:
        return None
    try:
        included = int(included_raw)
    except ValueError:
        return None
    if included < 1:
        return None
    model_id = env_vars.get(AIW_SESSION_BILLING_MODEL_ID, "").strip()
    return {
        "included_per_month": included,
        "model_id": model_id,
        "agent_template_id": env_vars.get(AIW_AGENT_TEMPLATE_ID, "").strip(),
        "tier_id": env_vars.get(AIW_SESSION_TIER_ID, "").strip(),
    }


@tracer.capture_method
def assert_session_quota_and_record(
    *,
    tenant_id: str,
    conversation_id: str,
    message_id: str,
    model_id: Optional[str],
) -> bool:
    """
    Session-based billing metering (separate from token usage metering).

    - Counts one session per end-user request (conversation + message).
    - Idempotent ledger write prevents double-charging on retries.
    - Best-effort: returns False on misconfiguration; raises SessionQuotaExceededError when over quota.
    """
    table_name = os.environ.get(SESSION_BILLING_METERING_TABLE_NAME_ENV_VAR, "").strip()
    if not table_name:
        return False

    env_vars = _load_runtime_env_vars()
    cfg = _session_billing_config(env_vars)
    if not cfg:
        return False

    included = int(cfg["included_per_month"])
    use_case_short_id = _use_case_short_id()
    ts_ms = int(time.time() * 1000)
    month = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m")
    billing_model_id = (model_id or cfg.get("model_id") or "").strip()

    session_id = f"{conversation_id}#{message_id}"
    pk = f"TENANT#{tenant_id}"
    ledger_sk = f"SESSION#{session_id}#UC#{use_case_short_id}"
    agg_sk = f"MONTH#{month}#UC#{use_case_short_id}#MODEL#{billing_model_id}"

    table = boto3.resource("dynamodb").Table(table_name)

    is_new_session = False
    try:
        table.put_item(
            Item={
                "PK": pk,
                "SK": ledger_sk,
                "EntityType": "session_ledger",
                "TenantId": tenant_id,
                "UseCaseShortId": use_case_short_id,
                "ConversationId": conversation_id,
                "MessageId": message_id,
                "ModelId": billing_model_id,
                "AgentTemplateId": cfg.get("agent_template_id") or "",
                "TierId": cfg.get("tier_id") or "",
                "TimestampMs": ts_ms,
            },
            ConditionExpression="attribute_not_exists(SK)",
        )
        is_new_session = True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            logger.warning("Session billing ledger write failed: %s", e)
            return False

    if is_new_session:
        table.update_item(
            Key={"PK": pk, "SK": agg_sk},
            UpdateExpression=(
                "SET EntityType = :t, Month = :m, TenantId = :tenant, UseCaseShortId = :uc, ModelId = :mid "
                "ADD SessionCount :one"
            ),
            ExpressionAttributeValues={
                ":t": "session_month",
                ":m": month,
                ":tenant": tenant_id,
                ":uc": use_case_short_id,
                ":mid": billing_model_id,
                ":one": 1,
            },
        )

    # Read aggregate after potential increment
    agg = table.get_item(Key={"PK": pk, "SK": agg_sk}).get("Item") or {}
    used = int(agg.get("SessionCount") or 0)
    if used > included:
        raise SessionQuotaExceededError(
            f"Session quota exceeded for this billing period ({used}/{included} sessions used)."
        )

    return True
