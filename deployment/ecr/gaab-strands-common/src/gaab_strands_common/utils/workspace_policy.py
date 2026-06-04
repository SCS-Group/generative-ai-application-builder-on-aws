# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Workspace policy helpers for AgentCore runtime containers."""

from __future__ import annotations

import os
from typing import Any, Dict


def _truthy(raw: str) -> bool:
    return raw.strip().lower() in ("true", "1", "yes")


def policy_block_from_env() -> str:
    return os.environ.get("AIW_WORKSPACE_POLICY_BLOCK", "").strip()


def orchestrator_policy_system_suffix() -> str:
    block = policy_block_from_env()
    if not block:
        return ""
    return f"\n\n---\nWorkspace policy (orchestrator — apply to all specialist delegations):\n{block}"


def resolve_runtime_user_message(payload: Dict[str, Any], extracted: str) -> str:
    """
    Honor AIW invoke contract: policy_test / policy_memory_seed channels and optional policyBlock.
    Hosted chat input may already be prepended by agentcore-invocation.
    """
    channel = str(payload.get("channel", "")).strip()
    block = str(payload.get("policyBlock") or policy_block_from_env()).strip()

    if channel == "policy_memory_seed":
        if block:
            seed_instruction = (
                "Persist the following workspace policy in long-term memory. "
                "Reply with a single short acknowledgment only.\n\n"
            )
            return seed_instruction + block
        return extracted

    if not block or "---\n\nUser message:" in extracted:
        return extracted

    msg = extracted.strip()
    if not msg:
        return block
    return f"{block}\n\n---\n\nUser message:\n{msg}"
