// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
    buildGithubRuntimeEnvVars,
    githubApiKeyProviderName,
    githubFieldsFromProvisionDetail
} from '../utils/github-runtime-env';

describe('github-runtime-env', () => {
    it('buildGithubRuntimeEnvVars returns owner, repo, and provider name', () => {
        expect(
            buildGithubRuntimeEnvVars({
                tenantId: '8d8480cc-6b5f-4d3f-b281-94a697de224a',
                githubOwner: 'SCS-Group',
                githubRepo: 'scs-group-pm-suite'
            })
        ).toEqual({
            AIW_GITHUB_OWNER: 'SCS-Group',
            AIW_GITHUB_REPO: 'scs-group-pm-suite',
            AIW_GITHUB_API_KEY_PROVIDER_NAME: 'aiw-custom-8d8480cc-github'
        });
    });

    it('githubApiKeyProviderName uses tenant prefix', () => {
        expect(githubApiKeyProviderName('abcd1234-0000-0000-0000-000000000000')).toBe('aiw-custom-abcd1234-github');
    });

    it('githubFieldsFromProvisionDetail reads detail keys', () => {
        expect(
            githubFieldsFromProvisionDetail({
                githubOwner: ' org ',
                githubRepo: 'repo'
            })
        ).toEqual({ githubOwner: 'org', githubRepo: 'repo' });
    });
});
