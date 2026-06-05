# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Hosted chat invoke payload — workspace policy enforced via AgentCore Policy on MCP gateway."""

from __future__ import annotations

from typing import Any, Dict, Optional


def resolve_invoke_input(
    *,
    input_text: str,
    channel: str,
    policy_block_override: Optional[str],
    policy_version_override: Optional[str],
    runtime_env_vars: Dict[str, str],
) -> Dict[str, Any]:
    """Pass user input through; Cedar policies on the gateway handle tool authorization."""
    _ = (policy_block_override, policy_version_override, runtime_env_vars)
    payload: Dict[str, Any] = {"input": input_text}
    if channel:
        payload["channel"] = channel
    return payload
