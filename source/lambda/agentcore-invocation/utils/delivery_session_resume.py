# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Inject AIW feature-ideation delivery session resume context into hosted chat invokes."""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

import boto3
from aws_lambda_powertools import Logger

from utils.constants import USE_CASE_CONFIG_RECORD_KEY_ENV_VAR, USE_CASE_CONFIG_TABLE_NAME_ENV_VAR

logger = Logger(utc=True)

_RESUME_ORCHESTRATION_GUARD = (
    "\nOrchestration (mandatory on resume):\n"
    "- Do NOT run a classification pass or invoke multiple specialists in parallel.\n"
    "- Invoke at most ONE specialist this turn unless the human explicitly asks for multiple perspectives.\n"
    "- Do NOT delegate for status-only turns — answer from this resume block and chat memory.\n"
    "- Do NOT call Gmail, Figma, GitHub, or current_time for session status."
)


def _load_use_case_config() -> Dict[str, Any]:
    table_name = os.environ.get(USE_CASE_CONFIG_TABLE_NAME_ENV_VAR, "").strip()
    config_key = os.environ.get(USE_CASE_CONFIG_RECORD_KEY_ENV_VAR, "").strip()
    if not table_name or not config_key:
        return {}
    try:
        table = boto3.resource("dynamodb").Table(table_name)
        item = table.get_item(Key={"key": config_key}).get("Item") or {}
        config = item.get("config") or {}
        return config if isinstance(config, dict) else {}
    except Exception as exc:
        logger.warning("delivery_session_resume: could not load use case config: %s", exc)
        return {}


def _resume_block_from_config(config: Dict[str, Any], delivery_session_key: Optional[str]) -> Optional[str]:
    workflow_params = config.get("WorkflowParams") or {}
    if not isinstance(workflow_params, dict):
        return None
    by_key = workflow_params.get("DeliverySessionResumeByKey") or {}
    if not isinstance(by_key, dict) or not by_key:
        return None

    key = (delivery_session_key or "").strip()
    if key:
        entry = by_key.get(key)
        if isinstance(entry, dict):
            block = entry.get("resumeBlock")
            return block.strip() if isinstance(block, str) and block.strip() else None
        return None

    keys = list(by_key.keys())
    if len(keys) == 1:
        entry = by_key.get(keys[0])
        if isinstance(entry, dict):
            block = entry.get("resumeBlock")
            return block.strip() if isinstance(block, str) and block.strip() else None
        return None

    if len(keys) > 1:
        return (
            "[AIW delivery sessions — multiple in progress]\n"
            "Ask the human which session key to resume, or reopen chat from the AIW portal Resume link.\n"
            f"Available session keys: {', '.join(keys)}"
        )
    return None


def prepend_delivery_session_resume(input_text: str, delivery_session_key: Optional[str]) -> str:
    text = input_text if input_text is not None else ""
    config = _load_use_case_config()
    block = _resume_block_from_config(config, delivery_session_key)
    if not block:
        return text
    if "[AIW delivery session resume" in block and "Orchestration (mandatory on resume)" not in block:
        block = f"{block}{_RESUME_ORCHESTRATION_GUARD}"
    return f"{block}\n\n---\n\n{text}"
