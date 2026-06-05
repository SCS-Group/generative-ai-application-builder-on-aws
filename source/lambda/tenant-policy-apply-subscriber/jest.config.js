// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

module.exports = {
    modulePaths: ['<rootDir>/../layers/', '<rootDir>/../layers/aws-sdk-lib/node_modules/'],
    testMatch: ['**/*.test.ts'],
    modulePathIgnorePatterns: ['<rootDir>/dist/'],
    preset: 'ts-jest'
};
