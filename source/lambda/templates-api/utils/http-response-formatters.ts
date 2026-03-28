// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const formatResponse = (
    body: string | { [key: string]: unknown },
    extraHeaders: { [key: string]: string } = {}
) => {
    const defaultHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Headers': 'Origin,X-Requested-With,Content-Type,Accept',
        'Access-Control-Allow-Methods': 'OPTIONS,POST,GET,PATCH',
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin': '*' // NOSONAR - javascript:S5122 - Domain not known at this point.
    };
    const headers = typeof extraHeaders === 'undefined' ? defaultHeaders : { ...defaultHeaders, ...extraHeaders };
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        statusCode: 200,
        headers,
        isBase64Encoded: false,
        body: bodyStr
    };
};

export const formatError = ({
    message,
    statusCode,
    extraHeaders
}: {
    message: string;
    statusCode?: string;
    extraHeaders?: { [key: string]: string };
}) => {
    const defaultHeaders = {
        'Content-Type': 'text/plain',
        'x-amzn-ErrorType': 'CustomExecutionError',
        'Access-Control-Allow-Origin': '*' // NOSONAR - javascript:S5122 - Domain not known at this point.
    };

    return {
        statusCode: statusCode ?? '400',
        headers: {
            ...defaultHeaders,
            ...extraHeaders
        },
        isBase64Encoded: false,
        body: message
    };
};
