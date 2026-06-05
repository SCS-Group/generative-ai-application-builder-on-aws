# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import unittest

from utils.workspace_policy import resolve_invoke_input


class TestWorkspacePolicy(unittest.TestCase):
    def test_resolve_invoke_passes_input_through(self):
        resolved = resolve_invoke_input(
            input_text="hello",
            channel="user",
            policy_block_override="RULE: no trades",
            policy_version_override="v1",
            runtime_env_vars={
                "AIW_WORKSPACE_POLICY_BLOCK": "ignored",
            },
        )
        self.assertEqual(resolved["input"], "hello")
        self.assertEqual(resolved["channel"], "user")
        self.assertNotIn("policyBlock", resolved)

    def test_resolve_invoke_omits_channel_when_empty(self):
        resolved = resolve_invoke_input(
            input_text="seed",
            channel="",
            policy_block_override=None,
            policy_version_override=None,
            runtime_env_vars={},
        )
        self.assertEqual(resolved["input"], "seed")
        self.assertNotIn("channel", resolved)


if __name__ == "__main__":
    unittest.main()
