// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LambdaClient } from '@aws-sdk/client-lambda';
import * as emitModule from '../emit-deprovision-status';
import * as getModule from '../invoke-get-use-case';
import * as deleteModule from '../invoke-delete-use-case';
import { runTenantDeprovision } from '../run-tenant-deprovision';
import * as waitModule from '../wait-for-stack-deletion';

jest.mock('../emit-deprovision-status');
jest.mock('../invoke-get-use-case');
jest.mock('../invoke-delete-use-case');
jest.mock('../wait-for-stack-deletion');

describe('runTenantDeprovision', () => {
    const lambdaClient = {} as LambdaClient;

    beforeEach(() => {
        jest.resetAllMocks();
        jest.spyOn(emitModule, 'emitTenantDeprovisionStatus').mockResolvedValue(undefined);
    });

    it('deletes MCP gateway before agent and waits for each stack', async () => {
        const order: string[] = [];
        jest.spyOn(getModule, 'invokeGetUseCaseStackId').mockImplementation(async (_c, _f, kind) => {
            order.push(`get:${kind}`);
            return kind === 'mcp' ? 'arn:aws:cloudformation:us-east-1:1:stack/McpStack/guid' : 'arn:aws:cloudformation:us-east-1:1:stack/AgentStack/guid';
        });
        jest.spyOn(deleteModule, 'invokePermanentDeleteUseCase').mockImplementation(async (_c, _f, kind) => {
            order.push(`delete:${kind}`);
            return { ok: true as const };
        });
        jest.spyOn(waitModule, 'waitForStackDeletion').mockImplementation(async () => {
            order.push('wait');
            return 'deleted';
        });

        await runTenantDeprovision(lambdaClient, 'agent-fn', 'mcp-fn', 'system:test', {
            tenantTemplateInstanceId: 'inst-1',
            gaabUseCaseId: 'agent-uc',
            gaabMcpGatewayUseCaseId: 'mcp-uc'
        });

        expect(order).toEqual([
            'get:mcp',
            'delete:mcp',
            'wait',
            'get:agents',
            'delete:agents',
            'wait'
        ]);
        expect(emitModule.emitTenantDeprovisionStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({ phase: 'deprovision_complete', tenantTemplateInstanceId: 'inst-1' })
        );
    });

    it('emits deprovision_failed when MCP delete invoke fails', async () => {
        jest.spyOn(getModule, 'invokeGetUseCaseStackId').mockResolvedValue('arn:aws:cloudformation:us-east-1:1:stack/McpStack/guid');
        jest.spyOn(deleteModule, 'invokePermanentDeleteUseCase').mockResolvedValue({ ok: false, statusCode: 500 });

        await runTenantDeprovision(lambdaClient, 'agent-fn', 'mcp-fn', 'system:test', {
            tenantTemplateInstanceId: 'inst-2',
            gaabMcpGatewayUseCaseId: 'mcp-uc',
            gaabUseCaseId: 'agent-uc'
        });

        expect(deleteModule.invokePermanentDeleteUseCase).toHaveBeenCalledTimes(1);
        expect(emitModule.emitTenantDeprovisionStatus).toHaveBeenLastCalledWith(
            expect.objectContaining({ phase: 'deprovision_failed', tenantTemplateInstanceId: 'inst-2' })
        );
    });
});
