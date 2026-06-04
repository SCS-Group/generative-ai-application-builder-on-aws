# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Workspace policy prepend for hosted chat (AIW contract)."""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from utils.constants import (
    AIW_WORKSPACE_POLICY_BLOCK_CONFIG_KEY,
    AIW_WORKSPACE_POLICY_MEMORY_ENABLED_CONFIG_KEY,
    AIW_WORKSPACE_POLICY_VERSION_CONFIG_KEY,
    WORKSPACE_POLICY_MEMORY_ENFORCEMENT_ENV_VAR,
)

CHANNEL_POLICY_MEMORY_SEED = "policy_memory_seed"
CHANNEL_POLICY_TEST = "policy_test"


def _truthy(raw: Optional[str]) -> bool:
    if not raw:
        return False
    return raw.strip().lower() in ("true", "1", "yes")


def workspace_policy_memory_enforcement_enabled() -> bool:
    return _truthy(os.environ.get(WORKSPACE_POLICY_MEMORY_ENFORCEMENT_ENV_VAR, ""))


def policy_block_from_runtime_env(env_vars: Dict[str, str]) -> str:
    return str(env_vars.get(AIW_WORKSPACE_POLICY_BLOCK_CONFIG_KEY, "")).strip()


def memory_enabled_from_runtime_env(env_vars: Dict[str, str]) -> bool:
    return _truthy(str(env_vars.get(AIW_WORKSPACE_POLICY_MEMORY_ENABLED_CONFIG_KEY, "")))


def should_prepend_saved_policy(*, channel: str, memory_enabled: bool, enforcement_enabled: bool) -> bool:
    ch = (channel or "").strip()
    if ch in (CHANNEL_POLICY_TEST, CHANNEL_POLICY_MEMORY_SEED):
        return False
    if not enforcement_enabled:
        return True
    if memory_enabled:
        return False
    return True


def wrap_user_message_with_policy(policy_block: str, user_message: str) -> str:
    block = (policy_block or "").strip()
    msg = (user_message or "").strip()
    if not block:
        return msg
    if not msg:
        return block
    return f"{block}\n\n---\n\nUser message:\n{msg}"


def resolve_invoke_input(
    *,
    input_text: str,
    channel: str,
    policy_block_override: Optional[str],
    policy_version_override: Optional[str],
    runtime_env_vars: Dict[str, str],
) -> Dict[str, Any]:
    """
    Build runtime payload fields: input text (possibly prepended) and optional policy metadata.
    """
    block = (policy_block_override or "").strip() or policy_block_from_runtime_env(runtime_env_vars)
    version = (policy_version_override or "").strip() or str(
        runtime_env_vars.get(AIW_WORKSPACE_POLICY_VERSION_CONFIG_KEY, "")
    ).strip()
    mem_on = memory_enabled_from_runtime_env(runtime_env_vars)
    prepend = should_prepend_saved_policy(
        channel=channel,
        memory_enabled=mem_on,
        enforcement_enabled=workspace_policy_memory_enforcement_enabled(),
    )
    final_input = wrap_user_message_with_policy(block, input_text) if prepend and block else input_text

    payload: Dict[str, Any] = {
        "input": final_input,
    }
    if block:
        payload["policyBlock"] = block
    if version:
        payload["policyVersion"] = version
    if channel:
        payload["channel"] = channel
    return payload
