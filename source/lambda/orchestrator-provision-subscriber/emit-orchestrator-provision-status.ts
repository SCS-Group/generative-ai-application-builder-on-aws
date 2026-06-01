// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { customAwsConfig } from 'aws-node-user-agent-config';
import { EVENT_BUS_NAME_ENV_VAR } from './utils/constants';

const eb = new EventBridgeClient(customAwsConfig());

export type OrchestratorProvisionPhase = 'provisioning_started' | 'stack_complete' | 'runtime_ready' | 'failed';

export async function emitOrchestratorProvisionStatus(detail: {
    orchestratorInstanceId: string;
    phase: OrchestratorProvisionPhase;
    message?: string;
    gaabUseCaseId?: string;
    runtimeUiUrl?: string;
}): Promise<void> {
    const instanceId = detail.orchestratorInstanceId?.trim();
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
                    DetailType: 'OrchestratorProvisionStatus',
                    Detail: JSON.stringify({
                        version: '1',
                        orchestratorInstanceId: instanceId,
                        phase: detail.phase,
                        ...(detail.message ? { message: detail.message } : {}),
                        ...(detail.gaabUseCaseId ? { gaabUseCaseId: detail.gaabUseCaseId } : {}),
                        ...(detail.runtimeUiUrl ? { runtimeUiUrl: detail.runtimeUiUrl } : {})
                    })
                }
            ]
        })
    );
}
