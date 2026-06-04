// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { logger } from './power-tools-init';

const agentCore = new BedrockAgentCoreClient(customAwsConfig());

/**
 * Seed long-term memory with workspace policy via runtime (channel policy_memory_seed).
 * Uses a fixed instruction payload to avoid a full user turn where possible.
 */
export async function invokePolicyMemorySeed(opts: {
    agentRuntimeArn: string;
    runtimeUserId: string;
    tenantTemplateInstanceId: string;
    policyBlock: string;
    policyVersion: string;
}): Promise<void> {
    const conversationId = `policy-seed-${opts.tenantTemplateInstanceId}`;
    const payload = JSON.stringify({
        conversationId,
        messageId: `seed-${Date.now()}`,
        channel: 'policy_memory_seed',
        policyBlock: opts.policyBlock,
        policyVersion: opts.policyVersion,
        userId: opts.runtimeUserId,
        input:
            'Store the workspace policy below as persistent session context. Do not ask questions; acknowledge only.\n\n' +
            opts.policyBlock
    });

    const resp = await agentCore.send(
        new InvokeAgentRuntimeCommand({
            agentRuntimeArn: opts.agentRuntimeArn,
            payload: new TextEncoder().encode(payload),
            contentType: 'application/json',
            accept: 'application/json',
            runtimeUserId: opts.runtimeUserId,
            runtimeSessionId: `${conversationId}_${opts.runtimeUserId}`
        })
    );

    if (resp.response) {
        try {
            await resp.response.transformToByteArray();
        } catch (e) {
            logger.warn('policy_memory_seed response read failed (non-fatal)', { error: e });
        }
    }

    logger.info('policy_memory_seed invoke completed', {
        tenantTemplateInstanceId: opts.tenantTemplateInstanceId,
        policyVersion: opts.policyVersion
    });
}
