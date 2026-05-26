// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { deployRequestBodyFromDevops, parseDevopsRecord } from '../utils/parse-devops';

describe('parse-devops', () => {
    const body = { UseCaseName: 'test', AgentParams: { SystemPrompt: 'hi' }, LlmParams: { ModelId: 'amazon.nova-pro-v1:0' } };
    const devopsObject = {
        gaab: {
            variant: 'AgentBuilder',
            provisioning: { deployRequestBody: body }
        }
    };

    it('parses devops object', () => {
        expect(parseDevopsRecord(devopsObject)).toEqual(devopsObject);
        expect(deployRequestBodyFromDevops(devopsObject)).toEqual(body);
    });

    it('parses devops JSON string (AIW AppSync shape)', () => {
        const json = JSON.stringify(devopsObject);
        expect(deployRequestBodyFromDevops(json)).toEqual(body);
    });

    it('returns undefined when deploy body missing', () => {
        expect(deployRequestBodyFromDevops({ gaab: { provisioning: {} } })).toBeUndefined();
        expect(deployRequestBodyFromDevops('not-json')).toBeUndefined();
    });
});
