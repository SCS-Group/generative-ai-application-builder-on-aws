// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildGithubRuntimeEnvVars, githubApiKeyProviderName } from '../utils/github-runtime-env';

describe('github-runtime-env (installer)', () => {
    it('buildGithubRuntimeEnvVars includes secret ARN when provided', () => {
        const secretArn =
            'arn:aws:secretsmanager:us-east-1:123456789012:secret:bedrock-agentcore-identity!default/apikey/aiw-custom-8d8480cc-github-abc';
        expect(
            buildGithubRuntimeEnvVars({
                tenantId: '8d8480cc-6b5f-4d3f-b281-94a697de224a',
                githubOwner: 'SCS-Group',
                githubRepo: 'scs-group-pm-suite',
                githubApiKeySecretArn: secretArn
            })
        ).toEqual({
            AIW_GITHUB_OWNER: 'SCS-Group',
            AIW_GITHUB_REPO: 'scs-group-pm-suite',
            AIW_GITHUB_API_KEY_PROVIDER_NAME: 'aiw-custom-8d8480cc-github',
            AIW_GITHUB_API_KEY_SECRET_ID: secretArn
        });
    });

    it('githubApiKeyProviderName uses tenant prefix', () => {
        expect(githubApiKeyProviderName('abcd1234-0000-0000-0000-000000000000')).toBe('aiw-custom-abcd1234-github');
    });
});
