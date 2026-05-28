// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { syntheticPermanentDeleteEvent } from '../synthetic-delete-event';

describe('syntheticPermanentDeleteEvent', () => {
    it('builds agent permanent delete path', () => {
        const ev = syntheticPermanentDeleteEvent('agents', 'abc-123', 'system:test');
        expect(ev.httpMethod).toBe('DELETE');
        expect(ev.path).toBe('/deployments/agents/abc-123');
        expect(ev.queryStringParameters?.permanent).toBe('true');
        expect(ev.requestContext.authorizer).toEqual({ UserId: 'system:test' });
    });

    it('builds mcp permanent delete path', () => {
        const ev = syntheticPermanentDeleteEvent('mcp', 'gw-456', 'system:test');
        expect(ev.path).toBe('/deployments/mcp/gw-456');
        expect(ev.resource).toBe('/deployments/mcp/{useCaseId}');
    });
});
