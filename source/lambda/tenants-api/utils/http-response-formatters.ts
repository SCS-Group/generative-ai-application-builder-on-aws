// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { APIGatewayProxyResult } from 'aws-lambda';

export function formatResponse(body: unknown, statusCode = 200): APIGatewayProxyResult {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
        },
        body: JSON.stringify(body)
    };
}

export function formatError(opts: { message: string; statusCode: string }): APIGatewayProxyResult {
    const code = parseInt(opts.statusCode, 10);
    return formatResponse({ message: opts.message }, Number.isFinite(code) ? code : 400);
}
