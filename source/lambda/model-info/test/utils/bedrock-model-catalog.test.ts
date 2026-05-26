// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mockClient } from 'aws-sdk-client-mock';
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { listBedrockFoundationModels } from '../../utils/bedrock-model-catalog';

const bedrockMock = mockClient(BedrockClient);

jest.mock('aws-sdk-lib', () => ({
    AWSClientManager: {
        getServiceClient: () => bedrockMock as unknown as BedrockClient
    }
}));

describe('bedrock-model-catalog', () => {
    beforeEach(() => {
        bedrockMock.reset();
    });

    it('listBedrockFoundationModels filters LEGACY and profile-only models', async () => {
        bedrockMock.on(ListFoundationModelsCommand).resolves({
            modelSummaries: [
                {
                    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
                    modelId: 'amazon.nova-pro-v1:0',
                    modelName: 'Nova Pro',
                    providerName: 'Amazon',
                    modelLifecycle: { status: 'ACTIVE' },
                    inferenceTypesSupported: ['ON_DEMAND', 'INFERENCE_PROFILE'] as never
                },
                {
                    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-1-20250805-v1:0',
                    modelId: 'anthropic.claude-opus-4-1-20250805-v1:0',
                    modelName: 'Claude Opus 4.1',
                    providerName: 'Anthropic',
                    modelLifecycle: { status: 'ACTIVE' },
                    inferenceTypesSupported: ['INFERENCE_PROFILE'] as never
                },
                {
                    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0',
                    modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
                    modelName: 'Old Sonnet',
                    providerName: 'Anthropic',
                    modelLifecycle: { status: 'LEGACY' },
                    inferenceTypesSupported: ['ON_DEMAND'] as never
                }
            ]
        });

        const models = await listBedrockFoundationModels();
        expect(models).toHaveLength(1);
        expect(models[0].ModelName).toBe('amazon.nova-pro-v1:0');
    });
});
