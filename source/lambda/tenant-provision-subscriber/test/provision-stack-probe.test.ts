// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { expectedAgentStackName } from '../provision-stack-naming';

describe('expectedAgentStackName', () => {
    it('matches use-case-management stack naming (name + first 8 chars of use case id)', () => {
        expect(expectedAgentStackName('test', 'ae3dd580-34ef-4191-9bf9-25ad953478e4')).toBe('test-ae3dd580');
    });

    it('trims use case name', () => {
        expect(expectedAgentStackName('  test  ', 'ae3dd580-34ef-4191-9bf9-25ad953478e4')).toBe('test-ae3dd580');
    });
});
