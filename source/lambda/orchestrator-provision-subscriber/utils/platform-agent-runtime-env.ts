// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Default AgentCore runtime env for Strands agents (Bedrock timeouts + GitHub MCP budgets).
 * Caller-specific keys (e.g. AIW_TENANT_ID) should override via spread order after defaults.
 */
export const PLATFORM_AGENT_RUNTIME_ENV_DEFAULTS: Record<string, string> = {
    BEDROCK_READ_TIMEOUT: '850',
    BEDROCK_CONNECT_TIMEOUT: '10',
    GITHUB_MCP_MAX_FILE_READS: '8',
    GITHUB_MCP_MAX_ISSUE_FETCHES: '1'
};

/** Platform defaults always win over stale live runtime env (e.g. legacy 300s). */
export function withPlatformAgentRuntimeDefaults(
    env: Record<string, string> | undefined
): Record<string, string> {
    return {
        ...(env ?? {}),
        ...PLATFORM_AGENT_RUNTIME_ENV_DEFAULTS
    };
}
