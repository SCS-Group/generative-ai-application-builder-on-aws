// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './power-tools-init';
import { DeleteDeploymentKind, syntheticPermanentDeleteEvent } from './synthetic-delete-event';

export type { DeleteDeploymentKind } from './synthetic-delete-event';

export async function invokePermanentDeleteUseCase(
    lambdaClient: LambdaClient,
    functionName: string,
    kind: DeleteDeploymentKind,
    useCaseId: string,
    systemUser: string
): Promise<{ ok: true } | { ok: false; statusCode?: number; body?: string }> {
    const payload = syntheticPermanentDeleteEvent(kind, useCaseId, systemUser);

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
        logger.error('Delete invoke returned non-JSON payload', { kind, useCaseId, raw: raw.slice(0, 500) });
        return { ok: false };
    }

    if (parsed?.statusCode && parsed.statusCode >= 400) {
        return { ok: false, statusCode: parsed.statusCode, body: parsed.body };
    }

    return { ok: true };
}
