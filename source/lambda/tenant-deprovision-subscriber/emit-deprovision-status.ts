// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { EVENT_BUS_NAME_ENV_VAR } from './utils/constants';

const eb = new EventBridgeClient(customAwsConfig());

export type DeprovisionStatusPhase = 'deprovision_started' | 'deprovision_complete' | 'deprovision_failed';

export async function emitTenantDeprovisionStatus(detail: {
    tenantTemplateInstanceId: string;
    phase: DeprovisionStatusPhase;
    message?: string;
    gaabUseCaseId?: string;
    gaabMcpGatewayUseCaseId?: string;
}): Promise<void> {
    const instanceId = detail.tenantTemplateInstanceId?.trim();
    if (!instanceId) {
        return;
    }
    const bus = process.env[EVENT_BUS_NAME_ENV_VAR] ?? 'default';

    await eb.send(
        new PutEventsCommand({
            Entries: [
                {
                    EventBusName: bus,
                    Source: 'gaab.tenant',
                    DetailType: 'TenantProvisionStatus',
                    Detail: JSON.stringify({
                        version: '1',
                        tenantTemplateInstanceId: instanceId,
                        phase: detail.phase,
                        ...(detail.message ? { message: detail.message } : {}),
                        ...(detail.gaabUseCaseId ? { gaabUseCaseId: detail.gaabUseCaseId } : {}),
                        ...(detail.gaabMcpGatewayUseCaseId
                            ? { gaabMcpGatewayUseCaseId: detail.gaabMcpGatewayUseCaseId }
                            : {})
                    })
                }
            ]
        })
    );
}
