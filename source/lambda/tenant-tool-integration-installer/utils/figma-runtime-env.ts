// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const AIW_FIGMA_TEAM_ID_ENV = 'AIW_FIGMA_TEAM_ID';
export const AIW_FIGMA_UX_TEMPLATE_FILE_KEY_ENV = 'AIW_FIGMA_UX_TEMPLATE_FILE_KEY';
export const AIW_FIGMA_PROJECT_ID_ENV = 'AIW_FIGMA_PROJECT_ID';
export const AIW_FIGMA_TOOL_PROXY_LAMBDA_ENV = 'AIW_FIGMA_TOOL_PROXY_LAMBDA';

export const FIGMA_WORKSPACE_RUNTIME_ENV_KEYS = [
    AIW_FIGMA_TEAM_ID_ENV,
    AIW_FIGMA_UX_TEMPLATE_FILE_KEY_ENV,
    AIW_FIGMA_PROJECT_ID_ENV,
    AIW_FIGMA_TOOL_PROXY_LAMBDA_ENV
] as const;

export function buildFigmaRuntimeEnvVars(params: {
    figmaTeamId: string;
    figmaUxTemplateFileKey: string;
    figmaProjectId?: string;
    figmaToolProxyLambda?: string;
}): Record<string, string> {
    const teamId = params.figmaTeamId.trim();
    const templateKey = params.figmaUxTemplateFileKey.trim();
    if (!teamId || !templateKey) {
        return {};
    }
    const env: Record<string, string> = {
        [AIW_FIGMA_TEAM_ID_ENV]: teamId,
        [AIW_FIGMA_UX_TEMPLATE_FILE_KEY_ENV]: templateKey
    };
    const projectId = params.figmaProjectId?.trim();
    if (projectId) {
        env[AIW_FIGMA_PROJECT_ID_ENV] = projectId;
    }
    const proxy = params.figmaToolProxyLambda?.trim();
    if (proxy) {
        env[AIW_FIGMA_TOOL_PROXY_LAMBDA_ENV] = proxy;
    }
    return env;
}
