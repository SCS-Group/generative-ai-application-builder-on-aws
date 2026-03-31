// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { customAwsConfig } from './custom-aws-config';

class AWSClientManager {
    private static dynamodbClient: DynamoDBClient | undefined;

    public static getServiceClient<T extends DynamoDBClient>(
        serviceName: 'dynamodb',
        tracer?: { captureAWSv3Client: (client: DynamoDBClient) => DynamoDBClient }
    ): T {
        if (serviceName !== 'dynamodb') {
            throw new Error(`Templates API only supports service 'dynamodb', got '${serviceName}'.`);
        }
        if (!AWSClientManager.dynamodbClient) {
            const client = new DynamoDBClient(customAwsConfig());
            AWSClientManager.dynamodbClient = tracer ? tracer.captureAWSv3Client(client) : client;
        }
        return AWSClientManager.dynamodbClient as T;
    }

    public static resetClients(): void {
        AWSClientManager.dynamodbClient = undefined;
    }
}

export { AWSClientManager };
