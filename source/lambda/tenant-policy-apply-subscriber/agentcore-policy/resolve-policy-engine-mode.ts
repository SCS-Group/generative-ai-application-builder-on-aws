// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayPolicyEngineMode } from './types';

const MODE_ENV = 'AIW_POLICY_ENGINE_MODE';

export function resolvePolicyEngineMode(): GatewayPolicyEngineMode {
    const raw = process.env[MODE_ENV]?.trim().toUpperCase();
    if (raw === 'LOG_ONLY') return 'LOG_ONLY';
    return 'ENFORCE';
}
