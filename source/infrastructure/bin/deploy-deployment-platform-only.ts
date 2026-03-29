#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal CDK app: only DeploymentPlatformStack.
 * Use when full `gen-ai-app-builder.ts` fails locally (Python/Docker bundling for other stacks).
 *
 *   SKIP_ECR_PREBUILD=1 npx cdk deploy DeploymentPlatformStack \
 *     -a "npx ts-node --prefer-ts-exts bin/deploy-deployment-platform-only.ts" \
 *     --require-approval never
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DeploymentPlatformStack } from '../lib/deployment-platform-stack';
import { BaseStackProps } from '../lib/framework/base-stack';
import { LambdaAspects } from '../lib/utils/lambda-aspect';
import { LambdaVersionCDKNagSuppression } from '../lib/utils/lambda-version-cdk-nag-suppression';
import { LogGroupRetentionCheckAspect } from '../lib/utils/log-group-retention-check-aspect';

const app = new cdk.App();
const solutionID = process.env.SOLUTION_ID ?? app.node.tryGetContext('solution_id');
const version = process.env.VERSION ?? app.node.tryGetContext('solution_version');
const solutionName = process.env.SOLUTION_NAME ?? app.node.tryGetContext('solution_name');
const applicationTrademarkName = app.node.tryGetContext('application_trademark_name');

const props: BaseStackProps = {
    description: `(${solutionID}) - ${solutionName} - ${DeploymentPlatformStack.name} - Version ${version}`,
    synthesizer: new cdk.DefaultStackSynthesizer({
        generateBootstrapVersionRule: false
    }),
    solutionID: solutionID,
    solutionVersion: version,
    solutionName: `${solutionName}`,
    applicationTrademarkName: applicationTrademarkName
};

const deploymentPlatform = new DeploymentPlatformStack(app, DeploymentPlatformStack.name, props);

cdk.Aspects.of(deploymentPlatform).add(
    new LambdaAspects(deploymentPlatform, 'AspectInject', {
        solutionID: solutionID,
        solutionVersion: version
    }),
    { priority: cdk.AspectPriority.MUTATING }
);

cdk.Aspects.of(app).add(new AwsSolutionsChecks(), { priority: cdk.AspectPriority.READONLY });
cdk.Aspects.of(app).add(new LogGroupRetentionCheckAspect(), { priority: cdk.AspectPriority.READONLY });

for (const runtime of [lambda.Runtime.NODEJS_22_X, lambda.Runtime.PYTHON_3_13]) {
    cdk.Aspects.of(app).add(new LambdaVersionCDKNagSuppression(runtime), {
        priority: cdk.AspectPriority.MUTATING
    });
}

app.synth();
