// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';

let controlClient: BedrockAgentCoreControlClient | undefined;

export function getAgentCoreControlClient(): BedrockAgentCoreControlClient {
    if (!controlClient) {
        controlClient = new BedrockAgentCoreControlClient({});
    }
    return controlClient;
}
