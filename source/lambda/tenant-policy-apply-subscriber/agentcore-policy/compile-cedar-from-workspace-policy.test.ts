// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { compileCedarFromWorkspacePolicy } from './compile-cedar-from-workspace-policy';

describe('compileCedarFromWorkspacePolicy', () => {
    it('emits permit and unified tool forbid when allowTradeExecution is false', () => {
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

        expect(compiled[1].name).toBe('aiw_workspace_tool_forbid');
        expect(compiled[1].statement).toContain('forbid(');
        expect(compiled[1].statement).toContain('operation like "*trade*"');
        expect(compiled[1].statement).toContain('orderType like "*trade*"');
    });

    it('emits only permit when no forbid rules match', () => {
        const compiled = compileCedarFromWorkspacePolicy({
            version: 2,
            digitalWorkerRole: 'portfolio_manager',
            title: 'Execution allowed',
            summary: 'Trades ok',
            limits: { allowTradeExecution: true, allowDiscordPosting: true }
        });

        expect(compiled).toHaveLength(1);
        expect(compiled[0].statement).toContain('permit(');
        expect(compiled[0].statement).not.toContain('forbid(');
    });

    it('merges discord and trade patterns into one forbid policy', () => {
        const compiled = compileCedarFromWorkspacePolicy({
            version: 2,
            digitalWorkerRole: 'portfolio_manager',
            title: 'No Discord or trades',
            summary: 'Research only',
            limits: { allowDiscordPosting: false, allowTradeExecution: false }
        });

        expect(compiled).toHaveLength(2);
        expect(compiled[1].name).toBe('aiw_workspace_tool_forbid');
        expect(compiled[1].statement).toContain('operation like "*discord*"');
        expect(compiled[1].statement).toContain('operation like "*trade*"');
        expect(compiled[1].statement).toContain('active rules: trade_execution, discord_posting');
    });

    it('honors explicit forbiddenToolPatterns for future integrations', () => {
        const compiled = compileCedarFromWorkspacePolicy({
            version: 2,
            digitalWorkerRole: 'portfolio_manager',
            title: 'No Slack',
            summary: 'Internal research',
            limits: { forbiddenToolPatterns: ['*slack*', 'teams_post'] }
        });

        const forbid = compiled.find((p) => p.name === 'aiw_workspace_tool_forbid');
        expect(forbid?.statement).toContain('operation like "*slack*"');
        expect(forbid?.statement).toContain('tool like "*teams_post*"');
    });

    it('emits discord forbid from policy text when limits omit allowDiscordPosting', () => {
        const compiled = compileCedarFromWorkspacePolicy({
            version: 2,
            digitalWorkerRole: 'portfolio_manager',
            title: 'Portfolio research — no Discord posting',
            summary:
                'Provide research only. The agent must never post, send, or publish messages to Discord on the user behalf.',
            prohibitedActions: [],
            customRules: [],
            limits: {}
        });

        const forbid = compiled.find((p) => p.name === 'aiw_workspace_tool_forbid');
        expect(forbid).toBeDefined();
        expect(forbid?.statement).toContain('operation like "*discord*"');
    });
});
