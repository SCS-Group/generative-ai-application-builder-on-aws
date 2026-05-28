// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeEvent } from 'aws-lambda';
import { createUserFederationOAuthChallenge } from './agentcore-oauth';
import { emitToolConnectionChallenge } from './emit-tool-connection-challenge';
import { loadOAuthProviderMap } from './oauth-providers';
import { REQUIRED_ENV_VARS } from './utils/constants';

function checkEnv(): void {
    const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
    if (missing.length) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}

function parseDetail(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return {};
        }
    }
    return {};
}

export const handler = async (event: EventBridgeEvent<string, unknown>) => {
    checkEnv();
    const d = parseDetail(event.detail);
    const correlationId = typeof d.correlationId === 'string' ? d.correlationId.trim() : '';
    const tenantTemplateInstanceId =
        typeof d.tenantTemplateInstanceId === 'string' ? d.tenantTemplateInstanceId.trim() : '';
    const providerKey = typeof d.providerKey === 'string' ? d.providerKey.trim() : '';
    const tenantId = typeof d.tenantId === 'string' ? d.tenantId.trim() : '';
    const oauthProviderName = typeof d.oauthProviderName === 'string' ? d.oauthProviderName.trim() : '';
    const oauthState = typeof d.oauthState === 'string' ? d.oauthState.trim() : '';
    const scopes = Array.isArray(d.scopes) ? d.scopes.filter((s): s is string => typeof s === 'string') : [];
    const callbackUrl = typeof d.callbackUrl === 'string' ? d.callbackUrl.trim() : '';
    const gaabMcpGatewayUseCaseId =
        typeof d.gaabMcpGatewayUseCaseId === 'string' ? d.gaabMcpGatewayUseCaseId.trim() : '';

    if (!correlationId || !tenantTemplateInstanceId || !providerKey || !tenantId) {
        console.warn('TenantToolConnectionRequested missing required fields', JSON.stringify(d));
        return;
    }

    const providers = loadOAuthProviderMap();
    const providerCfg = oauthProviderName ? providers[oauthProviderName] : undefined;

    if (!providerCfg?.credentialProviderArn) {
        await emitToolConnectionChallenge({
            correlationId,
            tenantTemplateInstanceId,
            providerKey,
            message:
                `OAuth provider "${oauthProviderName}" is not configured on GAAB. Set ` +
                `TOOL_CONNECTION_OAUTH_PROVIDERS_JSON with credentialProviderArn (AgentCore Identity).`
        });
        return;
    }

    try {
        const result = await createUserFederationOAuthChallenge({
            credentialProviderArn: providerCfg.credentialProviderArn,
            tenantId,
            scopes,
            callbackUrl,
            oauthState: oauthState || undefined,
            mcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
        });

        if (!result.ok) {
            await emitToolConnectionChallenge({
                correlationId,
                tenantTemplateInstanceId,
                providerKey,
                message: result.message
            });
            return;
        }

        // Do not add query params to the URL — AgentCore PAR authorize URLs reject modified requests.
        // Signed AIW state is sent as GetResourceOauth2Token customState and returned on resourceOauth2ReturnUrl.
        await emitToolConnectionChallenge({
            correlationId,
            tenantTemplateInstanceId,
            providerKey,
            authorizationUrl: result.authorizationUrl,
            sessionUri: result.sessionUri
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('OAuth challenge failed', msg, oauthProviderName, providerKey);
        await emitToolConnectionChallenge({
            correlationId,
            tenantTemplateInstanceId,
            providerKey,
            message: `OAuth challenge failed: ${msg}`
        });
    }
};
