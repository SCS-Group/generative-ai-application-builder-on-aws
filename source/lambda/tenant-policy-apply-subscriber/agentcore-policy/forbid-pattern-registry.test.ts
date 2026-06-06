// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    buildToolForbidWhenClause,
    collectForbidPatterns
} from './forbid-pattern-registry';

describe('forbid-pattern-registry', () => {
    it('merges registry limits into one pattern set', () => {
        const collected = collectForbidPatterns({
            limits: {
                allowTradeExecution: false,
                allowDiscordPosting: false
            }
        });

        expect(collected.activatedRuleIds).toEqual(['trade_execution', 'discord_posting']);
        expect(collected.toolPatterns).toEqual(expect.arrayContaining(['*trade*', '*discord*']));
        expect(collected.inputFieldPatterns).toEqual([{ field: 'orderType', pattern: '*trade*' }]);
    });

    it('includes explicit forbiddenToolPatterns from limits', () => {
        const collected = collectForbidPatterns({
            limits: {
                forbiddenToolPatterns: ['slack', '*email*']
            }
        });

        expect(collected.explicitPatterns).toEqual(['*slack*', '*email*']);
        expect(collected.toolPatterns).toEqual(expect.arrayContaining(['*slack*', '*email*']));
    });

    it('activates discord rule from policy prose', () => {
        const collected = collectForbidPatterns({
            summary: 'Must never post messages to Discord on the user behalf.',
            limits: {}
        });

        expect(collected.activatedRuleIds).toContain('discord_posting');
        expect(collected.toolPatterns).toContain('*discord*');
    });

    it('builds a single when clause for all patterns', () => {
        const whenClause = buildToolForbidWhenClause(
            collectForbidPatterns({
                limits: { allowDiscordPosting: false, forbiddenToolPatterns: ['*slack*'] }
            })
        );

        expect(whenClause).toContain('operation like "*discord*"');
        expect(whenClause).toContain('tool like "*slack*"');
    });
});
