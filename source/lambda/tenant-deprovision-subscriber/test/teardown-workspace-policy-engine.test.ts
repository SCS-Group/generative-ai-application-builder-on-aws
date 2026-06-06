// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { policyEngineNameForInstance } from '../agentcore-policy/policy-engine-naming';

describe('policyEngineNameForInstance', () => {
    it('matches AIW policy apply naming (no hyphens, 8-char suffix)', () => {
        expect(policyEngineNameForInstance('1b982433-ac08-434c-b90d-021b4aafe83e')).toBe('aiw_pe_1b982433');
    });
});
