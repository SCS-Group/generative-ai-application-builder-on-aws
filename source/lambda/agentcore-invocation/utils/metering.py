# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import boto3
from aws_lambda_powertools import Logger, Tracer

from utils.constants import USAGE_METERING_TABLE_NAME_ENV_VAR, USE_CASE_UUID_ENV_VAR

logger = Logger(utc=True)
tracer = Tracer()


def _use_case_short_id() -> str:
    raw = os.environ.get(USE_CASE_UUID_ENV_VAR, "").strip()
    return raw.split("-")[0] if raw else ""


@tracer.capture_method
def record_usage_event(
    *,
    tenant_id: str,
    conversation_id: str,
    message_id: str,
    model_id: Optional[str],
    usage: Optional[Dict[str, Any]],
    tool_event_count: int,
    elapsed_ms: int,
) -> bool:
    """
    Best-effort metering write.

    This is intentionally side-effect-only and must never fail the chat request.
    """
    table_name = os.environ.get(USAGE_METERING_TABLE_NAME_ENV_VAR, "").strip()
    if not table_name:
        return False

    use_case_short_id = _use_case_short_id()
    ts_ms = int(time.time() * 1000)
    month = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m")

    input_tokens = int((usage or {}).get("inputTokens") or 0)
    output_tokens = int((usage or {}).get("outputTokens") or 0)
    total_tokens = int((usage or {}).get("totalTokens") or (input_tokens + output_tokens))

    # Partition by tenant; sort by time for easy monthly queries.
    pk = f"TENANT#{tenant_id}"
    sk = f"TS#{ts_ms}#UC#{use_case_short_id}#CONV#{conversation_id}#MSG#{message_id}"

    item: Dict[str, Any] = {
        "PK": pk,
        "SK": sk,
        "EntityType": "usage_event",
        "TenantId": tenant_id,
        "UseCaseShortId": use_case_short_id,
        "ConversationId": conversation_id,
        "MessageId": message_id,
        "ModelId": model_id or "",
        "InputTokens": input_tokens,
        "OutputTokens": output_tokens,
        "TotalTokens": total_tokens,
        "ToolEventCount": int(tool_event_count),
        "ElapsedMs": int(elapsed_ms),
        "TimestampMs": ts_ms,
    }

    try:
        table = boto3.resource("dynamodb").Table(table_name)
        table.put_item(Item=item)

        # Monthly aggregate for fast billing queries (one row per tenant/usecase/model/month).
        # Query pattern: PK = TENANT#{tenantId}, begins_with(SK, "MONTH#YYYY-MM")
        agg_sk = f"MONTH#{month}#UC#{use_case_short_id}#MODEL#{model_id or ''}"
        table.update_item(
            Key={"PK": pk, "SK": agg_sk},
            UpdateExpression=(
                "SET EntityType = :t, Month = :m, TenantId = :tenant, UseCaseShortId = :uc, ModelId = :mid "
                "ADD RequestCount :one, InputTokens :in, OutputTokens :out, TotalTokens :tot, ToolEventCount :tools"
            ),
            ExpressionAttributeValues={
                ":t": "usage_month",
                ":m": month,
                ":tenant": tenant_id,
                ":uc": use_case_short_id,
                ":mid": model_id or "",
                ":one": 1,
                ":in": input_tokens,
                ":out": output_tokens,
                ":tot": total_tokens,
                ":tools": int(tool_event_count),
            },
        )
        return True
    except Exception as e:
        logger.warning("Usage metering write failed: %s", e)
        return False

