/**
 * Default AgentCore runtime env for Strands agents (Bedrock timeouts + GitHub MCP budgets).
 * Caller-specific keys (e.g. AIW_TENANT_ID) should override via spread order after defaults.
 */
export declare const PLATFORM_AGENT_RUNTIME_ENV_DEFAULTS: Record<string, string>;
export declare function withPlatformAgentRuntimeDefaults(env: Record<string, string> | undefined): Record<string, string>;
