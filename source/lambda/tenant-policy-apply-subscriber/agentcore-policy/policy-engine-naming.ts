// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** AgentCore names must match ^[A-Za-z][A-Za-z0-9_]*$ (no hyphens). */
export function policyEngineNameForInstance(tenantTemplateInstanceId: string): string {
    const suffix = tenantTemplateInstanceId.replace(/-/g, '').slice(0, 8);
    return `aiw_pe_${suffix}`;
}
