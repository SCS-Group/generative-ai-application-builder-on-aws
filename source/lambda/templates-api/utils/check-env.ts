// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { logger } from '../power-tools-init';
import { REQUIRED_ENV_VARS } from './constants';

export const checkEnv = () => {
    const missingVars: string[] = [];
    for (const envVar of REQUIRED_ENV_VARS) {
        if (!process.env[envVar]) {
            missingVars.push(envVar);
        }
    }
    if (missingVars.length > 0) {
        const errMsg = `Missing required environment variables: ${missingVars.join(
            ', '
        )}. This should not happen and indicates an issue with your deployment.`;
        logger.error(errMsg);
        throw new Error(errMsg);
    }
};
