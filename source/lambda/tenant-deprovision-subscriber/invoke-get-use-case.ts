// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './power-tools-init';
import type { DeleteDeploymentKind } from './synthetic-delete-event';
import { syntheticGetDeploymentEvent } from './synthetic-get-event';

export async function invokeGetUseCaseStackId(
    lambdaClient: LambdaClient,
    functionName: string,
    kind: DeleteDeploymentKind,
    useCaseId: string,
    systemUser: string
): Promise<string | undefined> {
    const payload = syntheticGetDeploymentEvent(kind, useCaseId, systemUser);

    const out = await lambdaClient.send(
        new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(JSON.stringify(payload), 'utf8')
        })
    );

    const raw = out.Payload ? Buffer.from(out.Payload).toString('utf8') : '';
    let parsed: APIGatewayProxyResult | undefined;
    try {
        parsed = raw ? (JSON.parse(raw) as APIGatewayProxyResult) : undefined;
    } catch {
        logger.warn('Get deployment invoke returned non-JSON payload', { kind, useCaseId, raw: raw.slice(0, 500) });
        return undefined;
    }

    if (parsed?.statusCode && parsed.statusCode >= 400) {
        logger.warn('Get deployment invoke failed', { kind, useCaseId, statusCode: parsed.statusCode, body: parsed.body });
        return undefined;
    }

    if (!parsed?.body) {
        return undefined;
    }

    try {
        const body = JSON.parse(parsed.body) as { StackId?: string };
        const stackId = typeof body.StackId === 'string' ? body.StackId.trim() : '';
        return stackId || undefined;
    } catch {
        logger.warn('Get deployment body is not JSON', { kind, useCaseId, body: parsed.body?.slice(0, 500) });
        return undefined;
    }
}
