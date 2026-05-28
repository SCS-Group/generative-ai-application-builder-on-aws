// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Prefix-only OAuth workload name (matches MCP gateway companion workload gaab-mcp-{prefix}). */
export function gatewayWorkloadPrefixFromUseCaseId(mcpGatewayUseCaseId: string): string {
    const short = mcpGatewayUseCaseId.trim().substring(0, 8);
    return `gaab-mcp-${short}`;
}
