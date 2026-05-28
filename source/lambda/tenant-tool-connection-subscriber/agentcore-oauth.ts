// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    BedrockAgentCoreClient,
    GetResourceOauth2TokenCommand,
    GetWorkloadAccessTokenForUserIdCommand,
    Oauth2FlowType
} from '@aws-sdk/client-bedrock-agentcore';
import {
    BedrockAgentCoreControlClient,
    CreateWorkloadIdentityCommand,
    GetOauth2CredentialProviderCommand,
    GetWorkloadIdentityCommand,
    UpdateWorkloadIdentityCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
import { resolveGatewayOAuthContext } from './resolve-gateway-workload';

export const DEFAULT_PLATFORM_WORKLOAD_NAME = 'aiw-platform-tool-oauth';

/** ARN tail after `oauth2credentialprovider/` (e.g. gaab-oauth-provider-7650ad56). */
export function credentialProviderNameFromArn(arn: string): string | undefined {
    const marker = '/oauth2credentialprovider/';
    const idx = arn.indexOf(marker);
    if (idx < 0) return undefined;
    const name = arn.slice(idx + marker.length).trim();
    return name || undefined;
}

function isNotFoundError(e: unknown): boolean {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return err?.name === 'ResourceNotFoundException' || err?.$metadata?.httpStatusCode === 404;
}

export function platformWorkloadName(): string {
    return process.env.AIW_TOOL_CONNECTION_WORKLOAD_NAME?.trim() || DEFAULT_PLATFORM_WORKLOAD_NAME;
}

export async function ensureWorkloadIdentity(callbackUrl: string, workloadName: string): Promise<string> {
    const name = workloadName.trim();
    const control = new BedrockAgentCoreControlClient({});

    try {
        await control.send(new GetWorkloadIdentityCommand({ name }));
    } catch (e) {
        if (!isNotFoundError(e)) {
            throw e;
        }
        await control.send(
            new CreateWorkloadIdentityCommand({
                name,
                allowedResourceOauth2ReturnUrls: callbackUrl ? [callbackUrl] : undefined
            })
        );
        return name;
    }

    if (callbackUrl) {
        const current = await control.send(new GetWorkloadIdentityCommand({ name }));
        const existing = current.allowedResourceOauth2ReturnUrls ?? [];
        if (!existing.includes(callbackUrl)) {
            await control.send(
                new UpdateWorkloadIdentityCommand({
                    name,
                    allowedResourceOauth2ReturnUrls: [...existing, callbackUrl]
                })
            );
        }
    }

    return name;
}

export async function ensurePlatformWorkloadIdentity(callbackUrl: string): Promise<string> {
    return ensureWorkloadIdentity(callbackUrl, platformWorkloadName());
}

export type OAuthChallengeInput = {
    credentialProviderArn: string;
    tenantId: string;
    scopes: string[];
    callbackUrl: string;
    oauthState?: string;
    /** When set, OAuth tokens are stored on the tenant MCP gateway service workload (required for tool calls). */
    mcpGatewayUseCaseId?: string;
};

export type OAuthChallengeResult =
    | { ok: true; authorizationUrl: string; sessionUri?: string }
    | { ok: false; message: string };

/** GAAB agent M2M providers use Cognito; third-party tools must use Google/Dropbox OIDC discovery URLs. */
export async function validateThirdPartyCredentialProvider(
    providerName: string
): Promise<OAuthChallengeResult | null> {
    const control = new BedrockAgentCoreControlClient({});
    const provider = await control.send(new GetOauth2CredentialProviderCommand({ name: providerName }));
    const discovery =
        provider.oauth2ProviderConfigOutput?.customOauth2ProviderConfig?.oauthDiscovery?.discoveryUrl?.trim() ?? '';
    if (!discovery) {
        return {
            ok: false,
            message:
                `OAuth provider "${providerName}" has no discovery URL. Create a CustomOauth2 provider for Google or Dropbox in AgentCore Identity.`
        };
    }
    if (discovery.includes('cognito-idp.') || discovery.includes('amazoncognito.com')) {
        return {
            ok: false,
            message:
                `OAuth provider "${providerName}" is configured for GAAB Cognito (${discovery}), not Google/Dropbox. ` +
                'Create separate AgentCore providers (e.g. platform-google, platform-dropbox) and update SSM ' +
                'ToolConnectionOAuthProviders — see source/scripts/setup-platform-tool-oauth-providers.sh.'
        };
    }
    return null;
}

/**
 * MCP gateway OAuth uses the companion workload (GatewayName, e.g. gaab-mcp-{prefix}), not the
 * service-linked GatewayId workload. External callers use GetWorkloadAccessTokenForUserId(tenantId).
 * CompleteResourceTokenAuth binds tokens for runtime X-Amzn-Bedrock-AgentCore-Runtime-User-Id.
 */
async function createGatewayOAuthChallenge(
    input: OAuthChallengeInput,
    providerName: string,
    oauthWorkloadName: string
): Promise<OAuthChallengeResult> {
    try {
        await ensureWorkloadIdentity(input.callbackUrl, oauthWorkloadName);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            message: `Could not prepare gateway workload identity (${oauthWorkloadName}): ${msg}`
        };
    }

    const agentCore = new BedrockAgentCoreClient({});
    let workloadIdentityToken: string | undefined;
    try {
        const workloadToken = await agentCore.send(
            new GetWorkloadAccessTokenForUserIdCommand({
                workloadName: oauthWorkloadName,
                userId: input.tenantId
            })
        );
        workloadIdentityToken = workloadToken.workloadAccessToken?.trim();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            message: `Gateway GetWorkloadAccessTokenForUserId failed (${oauthWorkloadName}): ${msg}`
        };
    }

    if (!workloadIdentityToken) {
        return { ok: false, message: 'GetWorkloadAccessTokenForUserId did not return a workload access token.' };
    }

    const response = await agentCore.send(
        new GetResourceOauth2TokenCommand({
            workloadIdentityToken,
            resourceCredentialProviderName: providerName,
            oauth2Flow: Oauth2FlowType.USER_FEDERATION,
            scopes: input.scopes.length > 0 ? input.scopes : undefined,
            resourceOauth2ReturnUrl: input.callbackUrl,
            forceAuthentication: true,
            customState: input.oauthState || undefined
        })
    );

    const authorizationUrlRaw = response.authorizationUrl?.trim();
    const sessionUri = response.sessionUri?.trim();
    if (!authorizationUrlRaw) {
        return { ok: false, message: 'GetResourceOauth2Token did not return an authorization URL.' };
    }

    return {
        ok: true,
        authorizationUrl: authorizationUrlRaw,
        sessionUri: sessionUri || undefined
    };
}

async function createPlatformOAuthChallenge(
    input: OAuthChallengeInput,
    providerName: string
): Promise<OAuthChallengeResult> {
    const workloadName = platformWorkloadName();
    try {
        await ensureWorkloadIdentity(input.callbackUrl, workloadName);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, message: `Could not prepare workload identity (${workloadName}): ${msg}` };
    }

    const agentCore = new BedrockAgentCoreClient({});
    let workloadIdentityToken: string | undefined;
    try {
        const workloadToken = await agentCore.send(
            new GetWorkloadAccessTokenForUserIdCommand({
                workloadName,
                userId: input.tenantId
            })
        );
        workloadIdentityToken = workloadToken.workloadAccessToken?.trim();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            message: `Workload access token failed: ${msg}. Use MCP gateway provisioning so gaabMcpGatewayUseCaseId is set.`
        };
    }

    if (!workloadIdentityToken) {
        return { ok: false, message: 'GetWorkloadAccessTokenForUserId did not return a workload access token.' };
    }

    const response = await agentCore.send(
        new GetResourceOauth2TokenCommand({
            workloadIdentityToken,
            resourceCredentialProviderName: providerName,
            oauth2Flow: Oauth2FlowType.USER_FEDERATION,
            scopes: input.scopes.length > 0 ? input.scopes : undefined,
            resourceOauth2ReturnUrl: input.callbackUrl,
            forceAuthentication: true,
            customState: input.oauthState || undefined
        })
    );

    const authorizationUrlRaw = response.authorizationUrl?.trim();
    const sessionUri = response.sessionUri?.trim();
    if (!authorizationUrlRaw) {
        return { ok: false, message: 'GetResourceOauth2Token did not return an authorization URL.' };
    }

    return {
        ok: true,
        authorizationUrl: authorizationUrlRaw,
        sessionUri: sessionUri || undefined
    };
}

export async function createUserFederationOAuthChallenge(input: OAuthChallengeInput): Promise<OAuthChallengeResult> {
    const providerName = credentialProviderNameFromArn(input.credentialProviderArn);
    if (!providerName) {
        return { ok: false, message: 'Invalid OAuth credential provider ARN.' };
    }

    const providerCheck = await validateThirdPartyCredentialProvider(providerName);
    if (providerCheck) {
        return providerCheck;
    }

    if (!input.callbackUrl) {
        return { ok: false, message: 'OAuth callback URL is required.' };
    }

    const gatewayUseCaseId = input.mcpGatewayUseCaseId?.trim();
    if (gatewayUseCaseId) {
        const gatewayCtx = await resolveGatewayOAuthContext(gatewayUseCaseId);
        if (gatewayCtx.ok) {
            return createGatewayOAuthChallenge(input, providerName, gatewayCtx.context.oauthWorkloadName);
        }
        return { ok: false, message: gatewayCtx.message };
    }

    return createPlatformOAuthChallenge(input, providerName);
}
