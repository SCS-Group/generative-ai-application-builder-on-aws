// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { applyPlatformDeployFields } from '../platform-deploy-fields';

describe('applyPlatformDeployFields', () => {
    it('copies ExistingRestApiId from agent deploy body', () => {
        const gateway: Record<string, unknown> = { UseCaseType: 'MCPServer' };
        applyPlatformDeployFields(
            gateway,
            { ExistingRestApiId: 'abc123' },
            { existingRestApiId: 'fallback' }
        );
        expect(gateway.ExistingRestApiId).toBe('abc123');
    });

    it('falls back to platform REST API id when agent body omits it', () => {
        const gateway: Record<string, unknown> = {};
        applyPlatformDeployFields(gateway, {}, { existingRestApiId: '5mp179ssja' });
        expect(gateway.ExistingRestApiId).toBe('5mp179ssja');
    });

    it('sets empty string when no agent or platform id', () => {
        const gateway: Record<string, unknown> = {};
        applyPlatformDeployFields(gateway, {}, {});
        expect(gateway.ExistingRestApiId).toBe('');
    });
});
