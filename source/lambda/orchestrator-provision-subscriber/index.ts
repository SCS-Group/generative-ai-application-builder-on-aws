// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { EventBridgeEvent } from 'aws-lambda';
import { buildWorkflowDeployBody, type OrchestratorMemberInput } from './build-workflow-deploy-body';
import { emitOrchestratorProvisionStatus } from './emit-orchestrator-provision-status';
import { emitTenantProvisionStatus } from './emit-tenant-provision-status';
import { invokeDeployApi, invokePermanentDeleteWorkflow } from './invoke-deploy-api';
import { logger, tracer } from './power-tools-init';
import {
    getDeploymentProbe,
    resolveWorkflowUseCaseIdByName,
    waitForUseCaseReady
} from './workflow-provision-poll';
import {
    REQUIRED_ENV_VARS,
    TENANT_PROVISION_WORKFLOW_FUNCTION_NAME_ENV_VAR,
    WORKFLOW_MAX_AGENTS
} from './utils/constants';

const PROVISION_WALL_CLOCK_BUDGET_MS = 840_000;

function checkEnv() {
    const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
    if (missing.length) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}

function parseDetail(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return {};
        }
    }
    return {};
}

function parseMembers(raw: unknown): OrchestratorMemberInput[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const members: OrchestratorMemberInput[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }
        const row = item as Record<string, unknown>;
        const tenantTemplateInstanceId =
            typeof row.tenantTemplateInstanceId === 'string' ? row.tenantTemplateInstanceId.trim() : '';
        const gaabUseCaseId = typeof row.gaabUseCaseId === 'string' ? row.gaabUseCaseId.trim() : '';
        if (tenantTemplateInstanceId && gaabUseCaseId) {
            members.push({ tenantTemplateInstanceId, gaabUseCaseId });
        }
    }
    return members;
}

async function notifyStatus(
    orchestratorInstanceId: string,
    phase: 'provisioning_started' | 'stack_complete' | 'runtime_ready' | 'failed',
    opts?: {
        message?: string;
        gaabUseCaseId?: string;
        runtimeUiUrl?: string;
        catalogTenantTemplateInstanceId?: string;
    }
): Promise<void> {
    const catalogId = opts?.catalogTenantTemplateInstanceId?.trim();
    try {
        if (catalogId) {
            await emitTenantProvisionStatus({
                tenantTemplateInstanceId: catalogId,
                phase,
                message: opts?.message,
                gaabUseCaseId: opts?.gaabUseCaseId,
                runtimeUiUrl: opts?.runtimeUiUrl
            });
            return;
        }
        await emitOrchestratorProvisionStatus({
            orchestratorInstanceId,
            phase,
            message: opts?.message,
            gaabUseCaseId: opts?.gaabUseCaseId,
            runtimeUiUrl: opts?.runtimeUiUrl
        });
    } catch (e) {
        logger.error('Failed to emit provision status', { phase, catalog: Boolean(catalogId), error: e });
    }
}

async function runOrchestratorProvision(detail: Record<string, unknown>): Promise<void> {
    if (String(detail.version) !== '1') {
        logger.warn('Skipping OrchestratorProvisionRequested: expected detail.version "1"');
        return;
    }

    const orchestratorInstanceId =
        typeof detail.orchestratorInstanceId === 'string' ? detail.orchestratorInstanceId.trim() : '';
    const catalogTenantTemplateInstanceId =
        typeof detail.catalogTenantTemplateInstanceId === 'string'
            ? detail.catalogTenantTemplateInstanceId.trim()
            : '';
    const statusOpts = catalogTenantTemplateInstanceId
        ? { catalogTenantTemplateInstanceId }
        : undefined;
    const tenantId = typeof detail.tenantId === 'string' ? detail.tenantId.trim() : '';
    const displayName = typeof detail.displayName === 'string' ? detail.displayName.trim() : '';
    const systemPrompt = typeof detail.systemPrompt === 'string' ? detail.systemPrompt.trim() : '';
    const useCaseDescription =
        typeof detail.useCaseDescription === 'string' ? detail.useCaseDescription.trim() : null;
    const tenantAdminEmail =
        typeof detail.tenantAdminEmail === 'string' ? detail.tenantAdminEmail.trim() : null;
    const memoryEnabled = detail.memoryEnabled === true;
    const bedrockModelId =
        typeof detail.bedrockModelId === 'string' && detail.bedrockModelId.trim()
            ? detail.bedrockModelId.trim()
            : null;
    const temperature =
        typeof detail.temperature === 'number' && Number.isFinite(detail.temperature)
            ? detail.temperature
            : null;
    const streaming = typeof detail.streaming === 'boolean' ? detail.streaming : null;
    const members = parseMembers(detail.members);

    if (!orchestratorInstanceId) {
        logger.error('OrchestratorProvisionRequested missing orchestratorInstanceId');
        return;
    }

    if (!tenantId) {
        await notifyStatus(orchestratorInstanceId, 'failed', {
            message: 'Missing tenant id in orchestrator provision request.',
            ...statusOpts
        });
        return;
    }

    if (members.length > WORKFLOW_MAX_AGENTS) {
        await notifyStatus(orchestratorInstanceId, 'failed', {
            message: `Too many specialists selected (max ${WORKFLOW_MAX_AGENTS}).`,
            ...statusOpts
        });
        return;
    }

    await notifyStatus(orchestratorInstanceId, 'provisioning_started', statusOpts);

    const built = await buildWorkflowDeployBody({
        tenantId,
        displayName,
        systemPrompt,
        useCaseDescription,
        tenantAdminEmail,
        memoryEnabled,
        llmOverrides: {
            modelId: bedrockModelId,
            temperature,
            streaming
        },
        members
    });
    if (!built.ok) {
        await notifyStatus(orchestratorInstanceId, 'failed', { message: built.message, ...statusOpts });
        return;
    }

    const workflowFn = process.env[TENANT_PROVISION_WORKFLOW_FUNCTION_NAME_ENV_VAR]!;
    const useCaseName = String(built.body.UseCaseName ?? displayName);
    const provisionStartedAt = Date.now();
    const remainingMs = () => Math.max(45_000, PROVISION_WALL_CLOCK_BUDGET_MS - (Date.now() - provisionStartedAt));

    const invoke = await invokeDeployApi(workflowFn, '/deployments/workflows', built.body);
    if (!invoke.ok) {
        logger.error('Workflow deployment invoke failed', { message: invoke.message });
        await notifyStatus(orchestratorInstanceId, 'failed', { message: invoke.message, ...statusOpts });
        return;
    }

    const gaabUseCaseId = await resolveWorkflowUseCaseIdByName(useCaseName, tenantId);
    if (!gaabUseCaseId) {
        await notifyStatus(orchestratorInstanceId, 'failed', {
            message:
                'Workflow deployment was accepted but the new use case could not be found. Check GAAB Deployments.',
            ...statusOpts
        });
        return;
    }

    await notifyStatus(orchestratorInstanceId, 'stack_complete', { gaabUseCaseId, ...statusOpts });

    const ready = await waitForUseCaseReady(gaabUseCaseId, remainingMs(), 20_000, useCaseName);
    const finalProbe = ready.ok ? ready.probe : await getDeploymentProbe(gaabUseCaseId, useCaseName);
    const stackComplete =
        ready.ok ||
        finalProbe.status === 'CREATE_COMPLETE' ||
        finalProbe.status === 'UPDATE_COMPLETE';

    if (!stackComplete) {
        await notifyStatus(orchestratorInstanceId, 'failed', {
            message: ready.ok ? 'Deployment status could not be confirmed.' : ready.message,
            gaabUseCaseId,
            ...statusOpts
        });
        return;
    }

    await notifyStatus(orchestratorInstanceId, 'runtime_ready', {
        gaabUseCaseId,
        runtimeUiUrl: finalProbe.cloudFrontWebUrl,
        ...statusOpts
    });
}

async function runOrchestratorDeprovision(detail: Record<string, unknown>): Promise<void> {
    if (String(detail.version) !== '1') {
        logger.warn('Skipping OrchestratorDeprovisionRequested: expected detail.version "1"');
        return;
    }

    const gaabUseCaseId = typeof detail.gaabUseCaseId === 'string' ? detail.gaabUseCaseId.trim() : '';
    if (!gaabUseCaseId) {
        logger.error('OrchestratorDeprovisionRequested missing gaabUseCaseId');
        return;
    }

    const workflowFn = process.env[TENANT_PROVISION_WORKFLOW_FUNCTION_NAME_ENV_VAR]!;
    const deleted = await invokePermanentDeleteWorkflow(workflowFn, gaabUseCaseId);
    if (!deleted.ok) {
        logger.error('Workflow delete invoke failed', {
            gaabUseCaseId,
            message: deleted.message
        });
    }
}

export const lambdaHandler = async (event: EventBridgeEvent<string, unknown>) => {
    checkEnv();
    const detail = parseDetail(event.detail);
    const detailType = event['detail-type'];

    if (detailType === 'OrchestratorDeprovisionRequested') {
        await runOrchestratorDeprovision(detail);
        return;
    }

    if (detailType === 'OrchestratorProvisionRequested') {
        try {
            await runOrchestratorProvision(detail);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error('Orchestrator provision worker failed', { error: e });
            const orchestratorInstanceId =
                typeof detail.orchestratorInstanceId === 'string'
                    ? detail.orchestratorInstanceId.trim()
                    : '';
            if (orchestratorInstanceId) {
                const catalogTenantTemplateInstanceId =
                    typeof detail.catalogTenantTemplateInstanceId === 'string'
                        ? detail.catalogTenantTemplateInstanceId.trim()
                        : '';
                await notifyStatus(orchestratorInstanceId, 'failed', {
                    message: msg || 'Orchestrator provision worker failed unexpectedly.',
                    ...(catalogTenantTemplateInstanceId
                        ? { catalogTenantTemplateInstanceId }
                        : {})
                });
            }
        }
        return;
    }

    logger.warn('Ignoring unknown detail-type for orchestrator subscriber', { detailType });
};

export const handler = middy(lambdaHandler).use([
    captureLambdaHandler(tracer),
    injectLambdaContext(logger)
]);
