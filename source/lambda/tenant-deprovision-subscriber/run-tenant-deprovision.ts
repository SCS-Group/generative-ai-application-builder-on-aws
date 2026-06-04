// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LambdaClient } from '@aws-sdk/client-lambda';
import { emitTenantDeprovisionStatus } from './emit-deprovision-status';
import { invokeGetUseCaseStackId } from './invoke-get-use-case';
import { invokePermanentDeleteUseCase } from './invoke-delete-use-case';
import { logger } from './power-tools-init';
import { waitForStackDeletion } from './wait-for-stack-deletion';

export type TenantDeprovisionDetail = {
    tenantTemplateInstanceId: string;
    gaabUseCaseId?: string;
    gaabMcpGatewayUseCaseId?: string;
};

/**
 * Ordered teardown: MCP gateway stack (and AgentCore gateway) first, then agent stack.
 * Emits TenantProvisionStatus phases consumed by AIW tenant-provision-status-subscriber.
 */
export async function runTenantDeprovision(
    lambdaClient: LambdaClient,
    agentFn: string,
    mcpFn: string,
    systemUser: string,
    detail: TenantDeprovisionDetail
): Promise<void> {
    const instanceId = detail.tenantTemplateInstanceId;
    const gaabUseCaseId = detail.gaabUseCaseId?.trim() ?? '';
    const gaabMcpGatewayUseCaseId = detail.gaabMcpGatewayUseCaseId?.trim() ?? '';

    await emitTenantDeprovisionStatus({
        tenantTemplateInstanceId: instanceId,
        phase: 'deprovision_started',
        gaabUseCaseId: gaabUseCaseId || undefined,
        gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
    });

    const errors: string[] = [];

    if (gaabMcpGatewayUseCaseId) {
        const mcpStackId = await invokeGetUseCaseStackId(
            lambdaClient,
            mcpFn,
            'mcp',
            gaabMcpGatewayUseCaseId,
            systemUser
        );
        const mcpDelete = await invokePermanentDeleteUseCase(
            lambdaClient,
            mcpFn,
            'mcp',
            gaabMcpGatewayUseCaseId,
            systemUser
        );
        if (!mcpDelete.ok) {
            errors.push('MCP gateway permanent delete request failed');
        } else if (mcpStackId) {
            const wait = await waitForStackDeletion(mcpStackId);
            if (wait === 'failed') {
                errors.push('MCP gateway CloudFormation stack DELETE_FAILED');
            } else if (wait === 'timeout') {
                errors.push('Timed out waiting for MCP gateway stack deletion');
            }
        } else {
            logger.warn('MCP gateway stack id unknown; proceeding without wait', { gaabMcpGatewayUseCaseId });
        }
    }

    if (gaabUseCaseId && errors.length === 0) {
        const agentStackId = await invokeGetUseCaseStackId(
            lambdaClient,
            agentFn,
            'agents',
            gaabUseCaseId,
            systemUser
        );
        const agentDelete = await invokePermanentDeleteUseCase(
            lambdaClient,
            agentFn,
            'agents',
            gaabUseCaseId,
            systemUser
        );
        if (!agentDelete.ok) {
            errors.push('Agent permanent delete request failed');
        } else if (agentStackId) {
            const wait = await waitForStackDeletion(agentStackId);
            if (wait === 'failed') {
                errors.push('Agent CloudFormation stack DELETE_FAILED');
            } else if (wait === 'timeout') {
                errors.push('Timed out waiting for agent stack deletion');
            }
        } else {
            logger.warn('Agent stack id unknown; delete invoked without wait', { gaabUseCaseId });
        }
    } else if (gaabUseCaseId && errors.length > 0) {
        logger.warn('Skipping agent stack delete because MCP gateway teardown failed', {
            gaabUseCaseId,
            errors
        });
    }

    if (errors.length) {
        await emitTenantDeprovisionStatus({
            tenantTemplateInstanceId: instanceId,
            phase: 'deprovision_failed',
            message: errors.join('; '),
            gaabUseCaseId: gaabUseCaseId || undefined,
            gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
        });
        return;
    }

    await emitTenantDeprovisionStatus({
        tenantTemplateInstanceId: instanceId,
        phase: 'deprovision_complete',
        gaabUseCaseId: gaabUseCaseId || undefined,
        gaabMcpGatewayUseCaseId: gaabMcpGatewayUseCaseId || undefined
    });
}
