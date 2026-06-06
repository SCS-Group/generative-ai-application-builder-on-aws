// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createPolicyDescription, updatePolicyDescriptionWire } from '../agentcore-policy/policy-description';

describe('policy-description', () => {
    it('passes plain string for CreatePolicy', () => {
        expect(createPolicyDescription(' AIW workspace ')).toBe('AIW workspace');
        expect(createPolicyDescription('   ')).toBeUndefined();
    });

    it('wraps description for UpdatePolicy wire format', () => {
        expect(updatePolicyDescriptionWire('Portfolio research')).toEqual({ optionalValue: 'Portfolio research' });
        expect(updatePolicyDescriptionWire('   ')).toBeUndefined();
    });
});
