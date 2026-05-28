// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { agentRuntimeNameFromUseCaseId } from '../sync-agent-runtime-env-helpers';

describe('agentRuntimeNameFromUseCaseId', () => {
    it('uses the first UUID segment for the runtime name', () => {
        expect(agentRuntimeNameFromUseCaseId('f00522dd-3c4d-4893-a640-a6587714596f')).toBe('gaab_agent_f00522dd');
    });
});
