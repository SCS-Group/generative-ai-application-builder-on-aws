// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { compileCedarFromWorkspacePolicy } from './compile-cedar-from-workspace-policy';

describe('compileCedarFromWorkspacePolicy', () => {
    it('emits permit and trade forbid policies when allowTradeExecution is false', () => {
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

        expect(compiled).toHaveLength(2);
        expect(compiled[0].name).toBe('aiw_workspace_governance');
        expect(compiled[0].statement).toContain('permit(');
        expect(compiled[0].statement).toContain('AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-east-1:123:gateway/abc"');
        expect(compiled[0].description).toContain('portfolio_manager');

        expect(compiled[1].name).toBe('aiw_workspace_trade_forbid');
        expect(compiled[1].statement).toContain('forbid(');
        expect(compiled[1].statement).toContain('operation like "*trade*"');
    });

    it('emits only permit when allowTradeExecution is true', () => {
        const compiled = compileCedarFromWorkspacePolicy({
            version: 2,
            digitalWorkerRole: 'portfolio_manager',
            title: 'Execution allowed',
            summary: 'Trades ok',
            limits: { allowTradeExecution: true }
        });

        expect(compiled).toHaveLength(1);
        expect(compiled[0].statement).toContain('permit(');
        expect(compiled[0].statement).not.toContain('forbid(');
    });
});
