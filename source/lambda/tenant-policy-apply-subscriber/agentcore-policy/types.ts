// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type GatewayPolicyEngineMode = 'LOG_ONLY' | 'ENFORCE';

export type CompiledCedarPolicy = {
    name: string;
    description: string;
    statement: string;
};

export type AgentCoreWorkspacePolicyRecord = {
    policyEngineId: string;
    policyEngineArn: string;
    gatewayId: string;
    gatewayArn?: string;
    gaabMcpGatewayUseCaseId: string;
    cedarPolicyId: string;
    cedarPolicyArn?: string;
    /** All Cedar policy resources on the engine keyed by policy name. */
    cedarPolicyIds?: Record<string, string>;
    policyVersion: string;
    policy: Record<string, unknown>;
    mode: GatewayPolicyEngineMode;
    updatedAt: string;
};
