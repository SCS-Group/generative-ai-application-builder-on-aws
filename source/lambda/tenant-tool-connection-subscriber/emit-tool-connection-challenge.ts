// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { EVENT_BUS_NAME_ENV_VAR } from './utils/constants';

const eb = new EventBridgeClient({});

export async function emitToolConnectionChallenge(detail: {
    correlationId: string;
    tenantTemplateInstanceId: string;
    providerKey: string;
    authorizationUrl?: string;
    sessionUri?: string;
    message?: string;
}): Promise<void> {
    const bus = process.env[EVENT_BUS_NAME_ENV_VAR] ?? 'default';
    await eb.send(
        new PutEventsCommand({
            Entries: [
                {
                    EventBusName: bus,
                    Source: 'gaab.tenant',
                    DetailType: 'TenantToolConnectionChallengeCreated',
                    Detail: JSON.stringify({
                        version: '1',
                        correlationId: detail.correlationId,
                        tenantTemplateInstanceId: detail.tenantTemplateInstanceId,
                        providerKey: detail.providerKey,
                        ...(detail.authorizationUrl ? { authorizationUrl: detail.authorizationUrl } : {}),
                        ...(detail.sessionUri ? { sessionUri: detail.sessionUri } : {}),
                        ...(detail.message ? { message: detail.message } : {})
                    })
                }
            ]
        })
    );
}
