// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    policyClientToken,
    WORKSPACE_CEDAR_POLICY_NAME_PREFIX,
    AGENTCORE_CLIENT_TOKEN_PATTERN,
    sanitizeAgentCoreClientToken
} from '../agentcore-policy/upsert-cedar-policy';
import { policyEngineNameForInstance } from '../agentcore-policy/policy-engine-naming';

describe('policyClientToken', () => {
    it('is stable for the same engine and policy name', () => {
        const a = policyClientToken('aiw_pe_bdaf98eb-a7ztu3k3tg', 'aiw_workspace_governance');
        const b = policyClientToken('aiw_pe_bdaf98eb-a7ztu3k3tg', 'aiw_workspace_governance');
        expect(a).toBe(b);
        expect(a.length).toBeLessThanOrEqual(256);
    });

    it('matches AgentCore clientToken pattern (no underscores)', () => {
        const token = policyClientToken('aiw_pe_bdaf98eb-a7ztu3k3tg', 'aiw_workspace_governance');
        expect(token).not.toContain('_');
        expect(AGENTCORE_CLIENT_TOKEN_PATTERN.test(token)).toBe(true);
    });

    it('sanitizes policy engine create tokens from workspace instance ids', () => {
        const token = sanitizeAgentCoreClientToken(`aiwpe-${'bdaf98eb-f331-4c0b-8ed2-93deabc5f5d9'.replace(/[^A-Za-z0-9-]/g, '')}`);
        expect(AGENTCORE_CLIENT_TOKEN_PATTERN.test(token)).toBe(true);
    });
});

describe('policyEngineNameForInstance', () => {
    it('derives AgentCore-safe name from workspace instance id', () => {
        expect(policyEngineNameForInstance('bdaf98eb-f331-4c0b-8ed2-93deabc5f5d9')).toBe('aiw_pe_bdaf98eb');
    });
});

describe('workspace cedar policy prefix', () => {
    it('matches governance and tool forbid policy names', () => {
        expect('aiw_workspace_governance'.startsWith(WORKSPACE_CEDAR_POLICY_NAME_PREFIX)).toBe(true);
        expect('aiw_workspace_tool_forbid'.startsWith(WORKSPACE_CEDAR_POLICY_NAME_PREFIX)).toBe(true);
    });
});
