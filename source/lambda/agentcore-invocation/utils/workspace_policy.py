# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Hosted chat invoke payload — workspace policy enforced via AgentCore Policy on MCP gateway."""

from __future__ import annotations

from typing import Any, Dict, Optional

from utils.delivery_session_resume import prepend_delivery_session_resume


def resolve_invoke_input(
    *,
    input_text: str,
    channel: str,
    policy_block_override: Optional[str],
    policy_version_override: Optional[str],
    runtime_env_vars: Dict[str, str],
    delivery_session_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Pass user input through; prepend AIW delivery session resume when configured."""
    _ = (policy_block_override, policy_version_override, runtime_env_vars)
    payload: Dict[str, Any] = {"input": prepend_delivery_session_resume(input_text, delivery_session_key)}
    if channel:
        payload["channel"] = channel
    return payload
