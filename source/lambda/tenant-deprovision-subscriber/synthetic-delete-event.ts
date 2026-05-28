// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { APIGatewayProxyEvent } from 'aws-lambda';

export type DeleteDeploymentKind = 'agents' | 'mcp';

export function syntheticPermanentDeleteEvent(
    kind: DeleteDeploymentKind,
    useCaseId: string,
    systemUser: string
): APIGatewayProxyEvent {
    const resource = `/deployments/${kind}/{useCaseId}`;
    const path = `/deployments/${kind}/${useCaseId}`;
    return {
        resource,
        path,
        httpMethod: 'DELETE',
        headers: {},
        multiValueHeaders: {},
        queryStringParameters: { permanent: 'true' },
        multiValueQueryStringParameters: null,
        pathParameters: { useCaseId },
        stageVariables: null,
        requestContext: {
            accountId: '',
            apiId: '',
            authorizer: { UserId: systemUser },
            protocol: 'HTTP/1.1',
            httpMethod: 'DELETE',
            path,
            stage: '',
            requestId: '',
            requestTimeEpoch: Date.now(),
            resourceId: '',
            resourcePath: resource,
            identity: {
                accessKey: null,
                accountId: null,
                apiKey: null,
                apiKeyId: null,
                caller: null,
                clientCert: null,
                cognitoAuthenticationProvider: null,
                cognitoAuthenticationType: null,
                cognitoIdentityId: null,
                cognitoIdentityPoolId: null,
                principalOrgId: null,
                sourceIp: '',
                user: null,
                userAgent: null,
                userArn: null
            }
        } as APIGatewayProxyEvent['requestContext'],
        body: null,
        isBase64Encoded: false
    };
}
