# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import unittest

from utils.delivery_session_resume import prepend_delivery_session_resume, _resume_block_from_config


class TestDeliverySessionResume(unittest.TestCase):
    def test_prepend_single_session_block(self):
        config = {
            "WorkflowParams": {
                "DeliverySessionResumeByKey": {
                    "my-feature": {
                        "resumeBlock": "[AIW delivery session resume]\nSession key: my-feature",
                    }
                }
            }
        }
        block = _resume_block_from_config(config, "my-feature")
        self.assertIn("my-feature", block or "")
        merged = prepend_delivery_session_resume("hello", "my-feature")
        self.assertIn("hello", merged)

    def test_prepend_adds_orchestration_guard_to_legacy_block(self):
        config = {
            "WorkflowParams": {
                "DeliverySessionResumeByKey": {
                    "my-feature": {
                        "resumeBlock": "[AIW delivery session resume]\nSession key: my-feature",
                    }
                }
            }
        }
        block = _resume_block_from_config(config, "my-feature")
        merged = prepend_delivery_session_resume("hello", "my-feature")
        self.assertIn("Orchestration (mandatory on resume)", merged)
        self.assertIn("hello", merged)

    def test_no_block_without_config(self):
        self.assertEqual(prepend_delivery_session_resume("hello", None), "hello")


if __name__ == "__main__":
    unittest.main()
