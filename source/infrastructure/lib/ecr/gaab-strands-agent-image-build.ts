#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import * as path from 'path';
import {
    GAAB_STRANDS_AGENT_IMAGE_NAME,
    GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM,
    GAAB_STRANDS_WORKFLOW_IMAGE_NAME
} from '../utils/constants';
import { platformBuiltAgentImageTag } from '../use-case-stacks/agent-core/utils/image-uri-resolver';

export { GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM };

export interface GaabStrandsAgentImageBuildProps {
    gaabVersion: string;
    /** Shared ECR prefix from ECRPullThroughCache (e.g. deploymentplatformstack). */
    ecrRepositoryPrefix: string;
    /** Platform custom-resource Lambda (runs BUILD_GAAB_STRANDS_AGENT_IMAGE). */
    customResourceLambda: lambda.IFunction;
}

/**
 * Builds gaab-strands-agent and gaab-strands-workflow-agent in AWS CodeBuild on stack deploy
 * and pushes to ${ecrRepositoryPrefix}/<image>:${versionTag}.
 * Repeatable IaC — no laptop Docker required.
 */
export class GaabStrandsAgentImageBuild extends Construct {
    public readonly imageTag: string;
    public readonly imageUri: string;
    public readonly workflowImageUri: string;
    public readonly buildProject: codebuild.Project;

    constructor(scope: Construct, id: string, props: GaabStrandsAgentImageBuildProps) {
        super(scope, id);

        this.imageTag = platformBuiltAgentImageTag(props.gaabVersion ?? 'v0.0.0-local');

        const ecrSource = new s3_assets.Asset(this, 'EcrSource', {
            path: path.join(__dirname, '../../../../deployment/ecr'),
            exclude: ['**/__pycache__', '**/.pytest_cache', '**/node_modules', '**/.git']
        });

        const buildRole = new iam.Role(this, 'CodeBuildRole', {
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com')
        });
        ecrSource.grantRead(buildRole);
        buildRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'ecr:GetAuthorizationToken',
                    'ecr:BatchCheckLayerAvailability',
                    'ecr:GetDownloadUrlForLayer',
                    'ecr:BatchGetImage',
                    'ecr:PutImage',
                    'ecr:InitiateLayerUpload',
                    'ecr:UploadLayerPart',
                    'ecr:CompleteLayerUpload',
                    'ecr:DescribeRepositories',
                    'ecr:CreateRepository'
                ],
                resources: ['*']
            })
        );
        buildRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                resources: ['*']
            })
        );

        this.buildProject = new codebuild.Project(this, 'Project', {
            projectName: cdk.Names.uniqueResourceName(this, { maxLength: 240 }).slice(0, 240),
            role: buildRole,
            source: codebuild.Source.s3({
                bucket: ecrSource.bucket,
                path: ecrSource.s3ObjectKey
            }),
            environment: {
                // AgentCore runtimes are linux/arm64; native ARM builders avoid amd64 images from docker push on x86.
                buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
                privileged: true,
                computeType: codebuild.ComputeType.MEDIUM
            },
            buildSpec: codebuild.BuildSpec.fromAsset(
                path.join(__dirname, '../../../../deployment/ecr/codebuild-buildspec.yml')
            ),
            timeout: cdk.Duration.minutes(45),
            encryptionKey: new kms.Key(this, 'CodeBuildKey', {
                enableKeyRotation: true,
                removalPolicy: cdk.RemovalPolicy.DESTROY
            })
        });

        NagSuppressions.addResourceSuppressions(this.buildProject, [
            {
                id: 'AwsSolutions-CB3',
                reason: 'Privileged mode required to run Docker build for gaab-strands-agent container image.'
            }
        ]);

        props.customResourceLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
                resources: [this.buildProject.projectArn]
            })
        );
        props.customResourceLambda.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ssm:PutParameter'],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/gaab-deployment-platform/GaabStrandsAgentImageUri`,
                    `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/gaab-deployment-platform/GaabStrandsWorkflowAgentImageUri`
                ]
            })
        );

        const buildResource = new cdk.CustomResource(this, 'Build', {
            serviceToken: props.customResourceLambda.functionArn,
            resourceType: 'Custom::GaabStrandsAgentImageBuild',
            properties: {
                Resource: 'BUILD_GAAB_STRANDS_AGENT_IMAGE',
                ProjectName: this.buildProject.projectName,
                ImageTag: this.imageTag,
                EcrRepositoryPrefix: props.ecrRepositoryPrefix,
                /** Force rebuild when solution version or ECR sources change. */
                BuildVersion: `${props.gaabVersion}-${ecrSource.assetHash}`
            }
        });
        buildResource.node.addDependency(ecrSource);

        this.imageUri = cdk.Fn.sub(
            '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${Prefix}/${ImageName}:${Tag}',
            {
                Prefix: props.ecrRepositoryPrefix,
                ImageName: GAAB_STRANDS_AGENT_IMAGE_NAME,
                Tag: this.imageTag
            }
        );

        this.workflowImageUri = cdk.Fn.sub(
            '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${Prefix}/${ImageName}:${Tag}',
            {
                Prefix: props.ecrRepositoryPrefix,
                ImageName: GAAB_STRANDS_WORKFLOW_IMAGE_NAME,
                Tag: this.imageTag
            }
        );

        // SSM is written by BUILD_GAAB_STRANDS_AGENT_IMAGE after CodeBuild (avoids CFN conflict with existing params).
        new cdk.CfnOutput(this, 'GaabStrandsAgentImageUri', {
            value: this.imageUri,
            description: 'ECR URI for gaab-strands-agent (shared prefix + version tag)'
        });

        new cdk.CfnOutput(this, 'GaabStrandsWorkflowAgentImageUri', {
            value: this.workflowImageUri,
            description: 'ECR URI for gaab-strands-workflow-agent (shared prefix + version tag)'
        });

        new cdk.CfnOutput(this, 'GaabStrandsAgentImageTag', {
            value: this.imageTag,
            description: 'ECR tag for gaab-strands-agent'
        });
    }
}
