// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { sanitizeCfnStackNameBase } from '../sanitize-cfn-stack-name';

describe('sanitizeCfnStackNameBase', () => {
    it('replaces spaces with hyphens for CFN stack naming', () => {
        expect(sanitizeCfnStackNameBase('Securities Research Assistant')).toBe(
            'Securities-Research-Assistant'
        );
    });

    it('prefixes with A when the name would start with a digit', () => {
        expect(sanitizeCfnStackNameBase('123-agent')).toBe('A123-agent');
    });

    it('handles empty input', () => {
        expect(sanitizeCfnStackNameBase('   ')).toBe('Agent');
    });
});
