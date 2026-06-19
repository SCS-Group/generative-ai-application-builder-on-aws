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
                allowDiscordPosting: false,
                allowMerge: false,
                allowPullRequestCreate: false,
                allowPullRequestReview: false,
                allowGithubIssueCreate: false,
                allowGithubIssueEdit: false
            }
        });

        expect(collected.activatedRuleIds).toEqual([
            'trade_execution',
            'discord_posting',
            'github_merge',
            'github_create_pull',
            'github_pull_review',
            'github_create_issue',
            'github_update_issue'
        ]);
        expect(collected.toolPatterns).toEqual(
            expect.arrayContaining([
                '*trade*',
                '*discord*',
                '*github_merge*',
                '*github_create_pull*',
                '*github_create_pull_review*',
                '*github_create_issue*',
                '*github_update_issue*'
            ])
        );
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

    it('forbids merge only when allowMerge is explicitly false', () => {
        const blocked = collectForbidPatterns({
            digitalWorkerRole: 'frontend_engineer',
            limits: { allowMerge: false }
        });
        expect(blocked.activatedRuleIds).toContain('github_merge');

        const unset = collectForbidPatterns({
            digitalWorkerRole: 'tech_lead',
            limits: {}
        });
        expect(unset.activatedRuleIds).not.toContain('github_merge');
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
