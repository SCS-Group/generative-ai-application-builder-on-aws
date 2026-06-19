// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    AIW_POLICY_ALLOW_ISSUE_CREATE_ENV,
    AIW_POLICY_ALLOW_ISSUE_EDIT_ENV,
    AIW_POLICY_ALLOW_MERGE_ENV,
    AIW_POLICY_ALLOW_PULL_REQUEST_CREATE_ENV,
    AIW_POLICY_ALLOW_PULL_REQUEST_REVIEW_ENV,
    policyLimitRuntimeEnvPatch
} from './policy-runtime-env';

describe('policy-runtime-env', () => {
    it('writes env only for explicit policy limits', () => {
        expect(
            policyLimitRuntimeEnvPatch({
                limits: { allowMerge: false, allowPullRequestCreate: true }
            })
        ).toEqual({
            [AIW_POLICY_ALLOW_MERGE_ENV]: 'false',
            [AIW_POLICY_ALLOW_PULL_REQUEST_CREATE_ENV]: 'true'
        });
    });

    it('writes github issue limits when set', () => {
        expect(
            policyLimitRuntimeEnvPatch({
                limits: { allowGithubIssueCreate: true, allowGithubIssueEdit: false }
            })
        ).toEqual({
            [AIW_POLICY_ALLOW_ISSUE_CREATE_ENV]: 'true',
            [AIW_POLICY_ALLOW_ISSUE_EDIT_ENV]: 'false'
        });
    });

    it('omits limits not set on the policy', () => {
        expect(
            policyLimitRuntimeEnvPatch({
                limits: { allowPullRequestReview: true }
            })
        ).toEqual({
            [AIW_POLICY_ALLOW_PULL_REQUEST_REVIEW_ENV]: 'true'
        });
    });

    it('does not infer merge from role when allowMerge is unset', () => {
        expect(
            policyLimitRuntimeEnvPatch({
                digitalWorkerRole: 'frontend_engineer',
                limits: {}
            })
        ).toEqual({});
    });
});
