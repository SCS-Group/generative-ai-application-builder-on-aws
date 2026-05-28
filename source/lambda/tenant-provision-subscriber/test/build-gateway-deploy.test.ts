// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildGatewayDeployBody, mergeAgentMcpServer } from '../build-gateway-deploy';
import { DEFAULT_MVP_CONNECTION_PROVIDERS } from '../utils/connections';

describe('buildGatewayDeployBody', () => {
    it('builds openApi targets when oauth and schema maps are complete', () => {
        const result = buildGatewayDeployBody({
            tenantId: 'tenant-1',
            gatewayUseCaseName: 'AIW Tools Acme',
            providers: DEFAULT_MVP_CONNECTION_PROVIDERS.filter((p) => p.providerKey === 'gmail'),
            oauthProviderMap: {
                'platform-gmail': {
                    credentialProviderArn:
                        'arn:aws:bedrock-agentcore:us-east-1:123:token-vault/default/oauth2credentialprovider/platform-google'
                }
            },
            schemaUriByTargetName: {
                gmail: 'mcp/schemas/openApiSchema/abc.json'
            }
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const targets = (result.body.MCPParams as Record<string, unknown>).GatewayParams as Record<
            string,
            unknown
        >;
        const tp = targets.TargetParams as unknown[];
        expect(tp).toHaveLength(1);
        expect((tp[0] as Record<string, unknown>).TargetName).toBe('gmail');
    });

    it('fails when schema uri missing', () => {
        const result = buildGatewayDeployBody({
            tenantId: 'tenant-1',
            gatewayUseCaseName: 'AIW Tools Acme',
            providers: DEFAULT_MVP_CONNECTION_PROVIDERS.filter((p) => p.providerKey === 'gmail'),
            oauthProviderMap: {
                'platform-gmail': { credentialProviderArn: 'arn:...:platform-google' }
            },
            schemaUriByTargetName: {}
        });
        expect(result.ok).toBe(false);
    });
});

describe('mergeAgentMcpServer', () => {
    it('adds gateway MCPServer entry', () => {
        const body: Record<string, unknown> = { AgentParams: { MCPServers: [] } };
        mergeAgentMcpServer(body, {
            useCaseId: 'gw-id',
            useCaseName: 'AIW Tools X',
            gatewayUrl: 'https://abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp'
        });
        const servers = (body.AgentParams as Record<string, unknown>).MCPServers as unknown[];
        expect(servers).toHaveLength(1);
        expect((servers[0] as Record<string, unknown>).Type).toBe('gateway');
    });
});
