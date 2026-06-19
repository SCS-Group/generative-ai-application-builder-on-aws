// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    BedrockAgentCoreControlClient,
    GetAgentRuntimeCommand,
    ListAgentRuntimesCommand,
    UpdateAgentRuntimeCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
    AIW_AGENT_WORKLOAD_NAME_ENV,
    AIW_GITHUB_API_KEY_SECRET_ID_ENV,
    GITHUB_WORKSPACE_RUNTIME_ENV_KEYS,
    buildGithubRuntimeEnvVars,
    githubApiKeyProviderName
} from './utils/github-runtime-env';
import { loadGithubApiKeySecretArn } from './utils/load-github-api-key-secret-arn';

const USE_CASES_TABLE = process.env.USE_CASES_TABLE_NAME?.trim() ?? '';
const USE_CASE_CONFIG_TABLE = process.env.USE_CASE_CONFIG_TABLE_NAME?.trim() ?? '';
const GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM = '/gaab-deployment-platform/GaabStrandsAgentImageUri';
const AIW_OAUTH_CALLBACK_SSM_PARAM = '/gaab-deployment-platform/AiwOAuthCallbackUrl';

const PLATFORM_AGENT_RUNTIME_ENV_DEFAULTS: Record<string, string> = {
    BEDROCK_READ_TIMEOUT: '850',
    BEDROCK_CONNECT_TIMEOUT: '10',
    GITHUB_MCP_MAX_FILE_READS: '8',
    GITHUB_MCP_MAX_ISSUE_FETCHES: '1'
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const control = new BedrockAgentCoreControlClient({});
const ssm = new SSMClient({});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function agentRuntimeNameFromUseCaseId(useCaseId: string): string {
    return `gaab_agent_${useCaseId.trim().split('-')[0]}`;
}

async function loadConfigKey(useCaseId: string): Promise<string | undefined> {
    if (!USE_CASES_TABLE) return undefined;
    const row = await ddb.send(
        new GetCommand({
            TableName: USE_CASES_TABLE,
            Key: { UseCaseId: useCaseId },
            ProjectionExpression: 'UseCaseConfigRecordKey'
        })
    );
    const key = typeof row.Item?.UseCaseConfigRecordKey === 'string' ? row.Item.UseCaseConfigRecordKey.trim() : '';
    return key || undefined;
}

async function resolveGithubSecretArn(tenantId: string, existingSecretArn?: string): Promise<string> {
    const resolved = await loadGithubApiKeySecretArn(control, tenantId, (providerName, error) => {
        console.warn('GitHub runtime env sync: could not resolve API key secret ARN', { providerName, error });
    });
    if (resolved) {
        return resolved;
    }
    const fromConfig = existingSecretArn?.trim();
    if (fromConfig) {
        return fromConfig;
    }
    throw new Error(
        `GitHub runtime env sync could not resolve ${AIW_GITHUB_API_KEY_SECRET_ID_ENV} for provider ${githubApiKeyProviderName(tenantId)}`
    );
}

async function patchConfigGithubEnv(
    gaabUseCaseId: string,
    tenantId: string,
    owner: string,
    repo: string,
    runtimeId: string
): Promise<Record<string, string>> {
    if (!USE_CASE_CONFIG_TABLE) {
        throw new Error('USE_CASE_CONFIG_TABLE_NAME not configured on integration installer');
    }
    const configKey = await loadConfigKey(gaabUseCaseId);
    if (!configKey) {
        throw new Error(`Use case config key not found for ${gaabUseCaseId}`);
    }
    const cfgRow = await ddb.send(
        new GetCommand({
            TableName: USE_CASE_CONFIG_TABLE,
            Key: { key: configKey }
        })
    );
    const config = cfgRow.Item?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`Use case config missing for key ${configKey}`);
    }
    const base = { ...(config as Record<string, unknown>) };
    const envVars =
        base.AgentRuntimeEnvVars && typeof base.AgentRuntimeEnvVars === 'object' && !Array.isArray(base.AgentRuntimeEnvVars)
            ? { ...(base.AgentRuntimeEnvVars as Record<string, string>) }
            : {};

    const githubSecretArn = await resolveGithubSecretArn(tenantId, envVars[AIW_GITHUB_API_KEY_SECRET_ID_ENV]);
    const githubEnv = buildGithubRuntimeEnvVars({
        tenantId,
        githubOwner: owner,
        githubRepo: repo,
        githubApiKeySecretArn: githubSecretArn
    });
    if (!Object.keys(githubEnv).length) {
        throw new Error('GitHub owner/repo missing for runtime env patch');
    }

    const workloadEnv = { [AIW_AGENT_WORKLOAD_NAME_ENV]: runtimeId.trim() };
    Object.assign(envVars, githubEnv, workloadEnv);
    base.AgentRuntimeEnvVars = envVars;
    await ddb.send(
        new UpdateCommand({
            TableName: USE_CASE_CONFIG_TABLE,
            Key: { key: configKey },
            UpdateExpression: 'SET #cfg = :cfg',
            ExpressionAttributeNames: { '#cfg': 'config' },
            ExpressionAttributeValues: { ':cfg': base }
        })
    );
    return envVars;
}

async function resolveRuntimeId(runtimeName: string): Promise<string | undefined> {
    let nextToken: string | undefined;
    do {
        const page = await control.send(new ListAgentRuntimesCommand({ maxResults: 50, nextToken }));
        const match = page.agentRuntimes?.find((rt) => rt.agentRuntimeName === runtimeName);
        if (match?.agentRuntimeId) return match.agentRuntimeId;
        nextToken = page.nextToken;
    } while (nextToken);
    return undefined;
}

async function resolveRuntimeIdOnce(useCaseId: string): Promise<string> {
    const runtimeName = agentRuntimeNameFromUseCaseId(useCaseId);
    const runtimeId = await resolveRuntimeId(runtimeName);
    if (!runtimeId) {
        throw new Error(`Agent runtime ${runtimeName} not found for GitHub credential sync`);
    }
    return runtimeId;
}

async function resolveRuntimeIdWithRetry(useCaseId: string): Promise<string> {
    const runtimeName = agentRuntimeNameFromUseCaseId(useCaseId);
    for (let attempt = 1; attempt <= 30; attempt++) {
        const runtimeId = await resolveRuntimeId(runtimeName);
        if (runtimeId) {
            return runtimeId;
        }
        console.info('GitHub runtime env sync waiting for agent runtime', { runtimeName, attempt });
        await sleep(10_000);
    }
    throw new Error(`Agent runtime ${runtimeName} not found after GitHub install`);
}

async function loadSsmParam(name: string): Promise<string | undefined> {
    const resp = await ssm.send(new GetParameterCommand({ Name: name }));
    return resp.Parameter?.Value?.trim() || undefined;
}

async function applyRuntimeEnvFromConfig(
    gaabUseCaseId: string,
    configEnvVars: Record<string, string>,
    runtimeId: string,
    tenantId: string
): Promise<void> {
    const describe = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
    const roleArn = describe.roleArn?.trim();
    if (!roleArn) {
        throw new Error(`Agent runtime ${runtimeId} missing roleArn`);
    }

    const platformUri = await loadSsmParam(GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM);
    if (!platformUri) {
        throw new Error(`SSM ${GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM} is missing`);
    }

    const oauthCallback = process.env.AIW_OAUTH_CALLBACK_URL?.trim() || (await loadSsmParam(AIW_OAUTH_CALLBACK_SSM_PARAM));
    const githubSecretArn = await resolveGithubSecretArn(tenantId, configEnvVars[AIW_GITHUB_API_KEY_SECRET_ID_ENV]);
    const env: Record<string, string> = {
        ...(describe.environmentVariables ?? {}),
        ...configEnvVars,
        [AIW_AGENT_WORKLOAD_NAME_ENV]: runtimeId,
        [AIW_GITHUB_API_KEY_SECRET_ID_ENV]: githubSecretArn,
        ...(oauthCallback ? { AIW_OAUTH_CALLBACK_URL: oauthCallback } : {}),
        ...PLATFORM_AGENT_RUNTIME_ENV_DEFAULTS
    };

    const updateReq = {
        agentRuntimeId: runtimeId,
        agentRuntimeArtifact: {
            containerConfiguration: { containerUri: platformUri }
        },
        roleArn,
        networkConfiguration: describe.networkConfiguration ?? { networkMode: 'PUBLIC' },
        environmentVariables: env,
        ...(describe.protocolConfiguration ? { protocolConfiguration: describe.protocolConfiguration } : {}),
        ...(describe.lifecycleConfiguration ? { lifecycleConfiguration: describe.lifecycleConfiguration } : {})
    };
    for (let attempt = 1; attempt <= 12; attempt++) {
        try {
            await control.send(new UpdateAgentRuntimeCommand(updateReq));
            break;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const busy = /UPDATING|being modified/i.test(msg);
            if (!busy || attempt === 12) {
                throw e;
            }
            console.info('GitHub runtime env sync waiting for agent runtime READY', { runtimeId, attempt });
            await sleep(5_000);
        }
    }

    console.info('GitHub runtime env applied to agent runtime', {
        gaabUseCaseId,
        runtimeId,
        containerUri: platformUri,
        githubKeys: Object.keys(env).filter((k) => k.includes('GITHUB')),
        hasGithubSecretArn: Boolean(env[AIW_GITHUB_API_KEY_SECRET_ID_ENV])
    });
}

function removeGithubKeysFromEnv(env: Record<string, string>): Record<string, string> {
    const next = { ...env };
    for (const key of GITHUB_WORKSPACE_RUNTIME_ENV_KEYS) {
        delete next[key];
    }
    return next;
}

async function patchConfigRemoveGithubEnv(gaabUseCaseId: string, runtimeId: string): Promise<Record<string, string>> {
    if (!USE_CASE_CONFIG_TABLE) {
        throw new Error('USE_CASE_CONFIG_TABLE_NAME not configured on integration installer');
    }
    const configKey = await loadConfigKey(gaabUseCaseId);
    if (!configKey) {
        throw new Error(`Use case config key not found for ${gaabUseCaseId}`);
    }
    const cfgRow = await ddb.send(
        new GetCommand({
            TableName: USE_CASE_CONFIG_TABLE,
            Key: { key: configKey }
        })
    );
    const config = cfgRow.Item?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`Use case config missing for key ${configKey}`);
    }
    const base = { ...(config as Record<string, unknown>) };
    const envVars =
        base.AgentRuntimeEnvVars && typeof base.AgentRuntimeEnvVars === 'object' && !Array.isArray(base.AgentRuntimeEnvVars)
            ? removeGithubKeysFromEnv(base.AgentRuntimeEnvVars as Record<string, string>)
            : {};
    envVars[AIW_AGENT_WORKLOAD_NAME_ENV] = runtimeId.trim();
    base.AgentRuntimeEnvVars = envVars;
    await ddb.send(
        new UpdateCommand({
            TableName: USE_CASE_CONFIG_TABLE,
            Key: { key: configKey },
            UpdateExpression: 'SET #cfg = :cfg',
            ExpressionAttributeNames: { '#cfg': 'config' },
            ExpressionAttributeValues: { ':cfg': base }
        })
    );
    return envVars;
}

async function applyRuntimeEnvWithoutGithub(gaabUseCaseId: string, configEnvVars: Record<string, string>, runtimeId: string): Promise<void> {
    const describe = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
    const roleArn = describe.roleArn?.trim();
    if (!roleArn) {
        throw new Error(`Agent runtime ${runtimeId} missing roleArn`);
    }

    const platformUri = await loadSsmParam(GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM);
    if (!platformUri) {
        throw new Error(`SSM ${GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM} is missing`);
    }

    const oauthCallback = process.env.AIW_OAUTH_CALLBACK_URL?.trim() || (await loadSsmParam(AIW_OAUTH_CALLBACK_SSM_PARAM));
    const env = removeGithubKeysFromEnv({
        ...(describe.environmentVariables ?? {}),
        ...configEnvVars,
        [AIW_AGENT_WORKLOAD_NAME_ENV]: runtimeId,
        ...(oauthCallback ? { AIW_OAUTH_CALLBACK_URL: oauthCallback } : {}),
        ...PLATFORM_AGENT_RUNTIME_ENV_DEFAULTS
    });

    await control.send(
        new UpdateAgentRuntimeCommand({
            agentRuntimeId: runtimeId,
            agentRuntimeArtifact: {
                containerConfiguration: { containerUri: platformUri }
            },
            roleArn,
            networkConfiguration: describe.networkConfiguration ?? { networkMode: 'PUBLIC' },
            environmentVariables: env,
            ...(describe.protocolConfiguration ? { protocolConfiguration: describe.protocolConfiguration } : {}),
            ...(describe.lifecycleConfiguration ? { lifecycleConfiguration: describe.lifecycleConfiguration } : {})
        })
    );

    console.info('GitHub runtime env cleared from agent runtime', {
        gaabUseCaseId,
        runtimeId,
        remainingGithubKeys: Object.keys(env).filter((k) => k.includes('GITHUB'))
    });
}

/** Remove GitHub direct-tool env from one workspace runtime after uninstall. */
export async function clearGithubRuntimeEnvForWorkspace(gaabUseCaseId: string): Promise<void> {
    const useCaseId = gaabUseCaseId.trim();
    if (!useCaseId) {
        throw new Error('gaabUseCaseId is required to clear GitHub runtime env');
    }

    const runtimeId = await resolveRuntimeIdOnce(useCaseId);
    const configEnvVars = await patchConfigRemoveGithubEnv(useCaseId, runtimeId);
    await applyRuntimeEnvWithoutGithub(useCaseId, configEnvVars, runtimeId);
}

type GithubInstallDetail = {
    gaabUseCaseId?: string;
    tenantId: string;
    customGithubOwner?: string;
    customGithubRepo?: string;
};

/** After GitHub gateway target install, persist owner/repo on config + live runtime (direct REST tools). */
export async function syncGithubRuntimeEnvAfterInstall(detail: GithubInstallDetail): Promise<void> {
    await syncGithubRuntimeEnv(detail, { waitForRuntime: true });
}

/** Tenant-wide credential fan-out: runtime already exists; refresh secret ARN on config + live runtime. */
export async function syncGithubRuntimeEnvForCredentialUpdate(detail: GithubInstallDetail): Promise<void> {
    await syncGithubRuntimeEnv(detail, { waitForRuntime: false });
}

async function syncGithubRuntimeEnv(
    detail: GithubInstallDetail,
    options: { waitForRuntime: boolean }
): Promise<void> {
    const gaabUseCaseId = detail.gaabUseCaseId?.trim();
    const owner = detail.customGithubOwner?.trim() ?? '';
    const repo = detail.customGithubRepo?.trim() ?? '';
    const tenantId = detail.tenantId?.trim() ?? '';

    if (!gaabUseCaseId) {
        throw new Error('GitHub install missing gaabUseCaseId; cannot sync direct GitHub runtime env');
    }
    if (!tenantId || !owner || !repo) {
        console.warn(
            `GitHub runtime env sync skipped: missing tenant/owner/repo (tenantId=${Boolean(tenantId)}, owner=${Boolean(owner)}, repo=${Boolean(repo)})`
        );
        return;
    }

    const runtimeId = options.waitForRuntime
        ? await resolveRuntimeIdWithRetry(gaabUseCaseId)
        : await resolveRuntimeIdOnce(gaabUseCaseId);

    const configEnvVars = await patchConfigGithubEnv(gaabUseCaseId, tenantId, owner, repo, runtimeId);
    await applyRuntimeEnvFromConfig(gaabUseCaseId, configEnvVars, runtimeId, tenantId);
    console.info(
        options.waitForRuntime
            ? 'GitHub runtime env synced after integration install'
            : 'GitHub runtime env synced after credential update',
        { gaabUseCaseId, owner, repo }
    );
}
