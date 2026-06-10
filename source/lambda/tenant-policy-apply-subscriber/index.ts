// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { EventBridgeEvent } from 'aws-lambda';
import { runPolicyApply, type TenantPolicyApplyDetail } from './run-policy-apply';
import { emitPolicyApplyStatus } from './emit-policy-apply-status';
import { REQUIRED_ENV_VARS } from './utils/constants';
import { logger, tracer } from './power-tools-init';

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

function asPolicyRecord(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string') {
        try {
            const o = JSON.parse(raw) as unknown;
            if (o && typeof o === 'object' && !Array.isArray(o)) {
                return o as Record<string, unknown>;
            }
        } catch {
            return {};
        }
    }
    return {};
}

export const lambdaHandler = async (event: EventBridgeEvent<string, unknown>) => {
    checkEnv();
    const detail = parseDetail(event.detail);
    if (String(detail.version) !== '1') {
        logger.warn('Skipping TenantPolicyApplyRequested: expected detail.version "1"');
        return;
    }

    const tenantTemplateInstanceId =
        typeof detail.tenantTemplateInstanceId === 'string' ? detail.tenantTemplateInstanceId.trim() : '';
    const gaabUseCaseId = typeof detail.gaabUseCaseId === 'string' ? detail.gaabUseCaseId.trim() : '';
    const policyBlock = typeof detail.policyBlock === 'string' ? detail.policyBlock.trim() : undefined;
    const policyVersion = typeof detail.policyVersion === 'string' ? detail.policyVersion.trim() : '';
    const aiwTenantId = typeof detail.aiwTenantId === 'string' ? detail.aiwTenantId.trim() : undefined;
    const agentRuntimeArn =
        typeof detail.agentRuntimeArn === 'string' ? detail.agentRuntimeArn.trim() : undefined;
    const gaabMcpGatewayUseCaseId =
        typeof detail.gaabMcpGatewayUseCaseId === 'string' ? detail.gaabMcpGatewayUseCaseId.trim() : undefined;

    if (!tenantTemplateInstanceId || !gaabUseCaseId) {
        const message = !tenantTemplateInstanceId
            ? 'tenantTemplateInstanceId missing from TenantPolicyApplyRequested'
            : 'gaabUseCaseId missing from TenantPolicyApplyRequested';
        logger.error(message);
        if (tenantTemplateInstanceId) {
            await emitPolicyApplyStatus({
                tenantTemplateInstanceId,
                phase: 'policy_apply_failed',
                message
            });
        }
        return;
    }

    const applyDetail: TenantPolicyApplyDetail = {
        tenantTemplateInstanceId,
        gaabUseCaseId,
        gaabMcpGatewayUseCaseId,
        policyBlock,
        policyVersion,
        policy: asPolicyRecord(detail.policy),
        memoryEnabled: detail.memoryEnabled === true,
        aiwTenantId,
        agentRuntimeArn
    };

    await runPolicyApply(applyDetail);
};

export const handler = middy(lambdaHandler).use([captureLambdaHandler(tracer), injectLambdaContext(logger)]);
