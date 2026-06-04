# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import os
import unittest

from utils.workspace_policy import (
    CHANNEL_POLICY_MEMORY_SEED,
    resolve_invoke_input,
    should_prepend_saved_policy,
    workspace_policy_memory_enforcement_enabled,
)


class TestWorkspacePolicy(unittest.TestCase):
    def test_enforcement_default_off(self):
        os.environ.pop("WORKSPACE_POLICY_MEMORY_ENFORCEMENT", None)
        self.assertFalse(workspace_policy_memory_enforcement_enabled())

    def test_prepend_when_enforcement_off_memory_on(self):
        self.assertTrue(
            should_prepend_saved_policy(
                channel="user", memory_enabled=True, enforcement_enabled=False
            )
        )

    def test_no_prepend_memory_on_enforcement_on(self):
        self.assertFalse(
            should_prepend_saved_policy(
                channel="user", memory_enabled=True, enforcement_enabled=True
            )
        )

    def test_resolve_invoke_adds_policy_block(self):
        resolved = resolve_invoke_input(
            input_text="hello",
            channel="user",
            policy_block_override=None,
            policy_version_override=None,
            runtime_env_vars={
                "AIW_WORKSPACE_POLICY_BLOCK": "RULE: no trades",
                "AIW_WORKSPACE_POLICY_VERSION": "v1",
            },
        )
        self.assertIn("RULE: no trades", resolved["input"])
        self.assertEqual(resolved["policyBlock"], "RULE: no trades")
        self.assertEqual(resolved["policyVersion"], "v1")

    def test_policy_memory_seed_channel_in_payload(self):
        resolved = resolve_invoke_input(
            input_text="seed",
            channel=CHANNEL_POLICY_MEMORY_SEED,
            policy_block_override="RULE",
            policy_version_override="v2",
            runtime_env_vars={},
        )
        self.assertEqual(resolved["channel"], CHANNEL_POLICY_MEMORY_SEED)
        self.assertEqual(resolved["input"], "seed")


if __name__ == "__main__":
    unittest.main()
