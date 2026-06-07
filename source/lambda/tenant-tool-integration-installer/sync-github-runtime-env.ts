// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { patchAgentRuntimeGithubEnv } from '../tenant-provision-subscriber/patch-agent-runtime-github-env';

type GithubInstallDetail = {
    gaabUseCaseId?: string;
    tenantId: string;
    customGithubOwner?: string;
    customGithubRepo?: string;
};

/** After GitHub gateway target install, persist owner/repo on the agent runtime for direct REST tools. */
export async function syncGithubRuntimeEnvAfterInstall(detail: GithubInstallDetail): Promise<void> {
    const gaabUseCaseId = detail.gaabUseCaseId?.trim();
    const owner = detail.customGithubOwner?.trim() ?? '';
    const repo = detail.customGithubRepo?.trim() ?? '';
    const tenantId = detail.tenantId?.trim() ?? '';
    if (!gaabUseCaseId || !owner || !repo || !tenantId) {
        return;
    }
    try {
        await patchAgentRuntimeGithubEnv({
            gaabUseCaseId,
            tenantId,
            githubOwner: owner,
            githubRepo: repo,
            syncRuntime: true
        });
        console.info('GitHub runtime env synced after integration install', { gaabUseCaseId, owner, repo });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('GitHub runtime env sync failed (install still succeeded)', msg);
    }
}
