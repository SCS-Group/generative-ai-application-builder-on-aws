// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { BedrockClient } from '@aws-sdk/client-bedrock';
import { AWSClientManager } from 'aws-sdk-lib';
import { logger, tracer } from '../power-tools-init';

export interface BedrockModelListItem {
    ModelName: string;
    DisplayName: string;
    Description: string;
}

function getBedrockClient(): BedrockClient {
    return AWSClientManager.getServiceClient<BedrockClient>('bedrock', tracer);
}

function isOnDemandFoundationModel(
    modelId: string | undefined,
    lifecycleStatus: string | undefined,
    inferenceTypesSupported: string[] | undefined
): boolean {
    if (!modelId?.trim()) {
        return false;
    }
    if (lifecycleStatus === 'LEGACY') {
        return false;
    }
    if (!inferenceTypesSupported?.includes('ON_DEMAND')) {
        return false;
    }
    return true;
}

/**
 * Lists on-demand foundation models from Amazon Bedrock (enabled in account/region).
 * Profile-only models (e.g. Claude Opus 4.1) are excluded — they require an inference profile.
 */
export async function listBedrockFoundationModels(): Promise<BedrockModelListItem[]> {
    const bedrockClient = getBedrockClient();
    const models: BedrockModelListItem[] = [];

    const response = await bedrockClient.send(
        new ListFoundationModelsCommand({
            byOutputModality: 'TEXT',
            byInferenceType: 'ON_DEMAND'
        })
    );

    for (const summary of response.modelSummaries ?? []) {
        const modelId = summary.modelId;
        const status = summary.modelLifecycle?.status;
        if (!isOnDemandFoundationModel(modelId, status, summary.inferenceTypesSupported)) {
            continue;
        }
        models.push({
            ModelName: modelId!,
            DisplayName: summary.modelName?.trim() || modelId!,
            Description: [summary.providerName, status, 'On-demand'].filter(Boolean).join(' · ')
        });
    }

    models.sort((a, b) => a.ModelName.localeCompare(b.ModelName));
    logger.info('Listed Bedrock foundation models', { count: models.length });
    return models;
}
