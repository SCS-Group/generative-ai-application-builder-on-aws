# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Runtime message helpers — workspace policy enforced via AgentCore Policy on MCP gateway."""

from __future__ import annotations

from typing import Any, Dict


def resolve_runtime_user_message(_payload: Dict[str, Any], extracted: str) -> str:
    return extracted
