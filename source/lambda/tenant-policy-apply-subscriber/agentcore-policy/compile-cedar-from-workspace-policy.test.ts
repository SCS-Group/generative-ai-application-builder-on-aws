// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { compileCedarFromWorkspacePolicy } from './compile-cedar-from-workspace-policy';

describe('compileCedarFromWorkspacePolicy', () => {
    it('emits a permit policy scoped to gateway ARN when provided', () => {
        const compiled = compileCedarFromWorkspacePolicy(
            {
                version: 2,
                digitalWorkerRole: 'portfolio_manager',
                title: 'Research only',
                summary: 'No trade execution',
                prohibitedActions: ['Place trades'],
                customRules: ['State risks clearly'],
                limits: { allowTradeExecution: false }
            },
            { gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:gateway/abc' }
        );

        expect(compiled.name).toBe('aiw_workspace_governance');
        expect(compiled.statement).toContain('permit(');
        expect(compiled.statement).toContain('AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-east-1:123:gateway/abc"');
        expect(compiled.statement).toContain('allowTradeExecution=false');
        expect(compiled.description).toContain('portfolio_manager');
    });

    it('omits trade note when allowTradeExecution is true', () => {
        const compiled = compileCedarFromWorkspacePolicy({
            version: 2,
            digitalWorkerRole: 'portfolio_manager',
            title: 'Execution allowed',
            summary: 'Trades ok',
            limits: { allowTradeExecution: true }
        });

        expect(compiled.statement).toContain('permit(');
        expect(compiled.statement).not.toContain('allowTradeExecution=false');
    });
});
