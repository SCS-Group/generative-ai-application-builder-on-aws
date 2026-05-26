#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';

import { Construct } from 'constructs';
import { DynamoDBDeploymentPlatformStorage } from './deployment-platform-storage-stack';

import { LambdaToDynamoDB } from '@aws-solutions-constructs/aws-lambda-dynamodb';
import { NagSuppressions } from 'cdk-nag';
import { BaseStackProps } from '../framework/base-stack';
import {
    AGENT_TEMPLATES_TABLE_NAME_ENV_VAR,
    MODEL_INFO_TABLE_NAME_ENV_VAR,
    TENANTS_TABLE_NAME_ENV_VAR,
    USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
    USE_CASES_TABLE_NAME_ENV_VAR
} from '../utils/constants';

export interface DeploymentPlatformStorageProps extends BaseStackProps {
    /**
     * Lambda function to use for custom resource implementation.
     */
    customResourceLambda: lambda.Function;

    /**
     * The IAM role to use for custom resource implementation.
     */
    customResourceRole: iam.Role;

    /**
     * access logging bucket for any s3 resources
     */
    accessLoggingBucket: s3.Bucket;
}

/**
 * This Construct sets up the nested stack managing dynamoDB tables for use case management
 */
export class DeploymentPlatformStorageSetup extends Construct {
    /**
     * The instance of Construct passed to it the constructor to be used when infrastructure provisioning is
     * done outside the constructor through methods
     */
    private scope: Construct;

    /**
     * Nested stack which deploys storage for the deployment platform
     */
    public readonly deploymentPlatformStorage: DynamoDBDeploymentPlatformStorage;

    constructor(scope: Construct, id: string, props: DeploymentPlatformStorageProps) {
        super(scope, id);
        this.scope = scope;

        this.deploymentPlatformStorage = new DynamoDBDeploymentPlatformStorage(this, 'DeploymentPlatformStorage', {
            description: `Nested Stack that creates the DynamoDB table to manage use cases - Version ${props.solutionVersion}`,
            parameters: {
                CustomResourceLambdaArn: props.customResourceLambda.functionArn,
                CustomResourceRoleArn: props.customResourceRole.roleArn,
                AccessLoggingBucketArn: props.accessLoggingBucket.bucketArn
            }
        });
    }

    public configureDeploymentApiLambda(deploymentApiLambda: lambda.Function): void {
        const ddbPolicy = new iam.Policy(this, 'DeploymentApiDDBPolicy', {
            statements: [
                new iam.PolicyStatement({
                    actions: [
                        'dynamodb:Batch*',
                        'dynamodb:ConditionCheckItem',
                        'dynamodb:DeleteItem',
                        'dynamodb:Get*',
                        'dynamodb:PutItem',
                        'dynamodb:Query',
                        'dynamodb:Scan',
                        'dynamodb:UpdateItem'
                    ],
                    resources: [
                        this.deploymentPlatformStorage.useCasesTable.tableArn,
                        this.deploymentPlatformStorage.modelInfoTable.tableArn,
                        this.deploymentPlatformStorage.useCaseConfigTable.tableArn
                    ]
                })
            ]
        });
        ddbPolicy.attachToRole(deploymentApiLambda.role!);

        deploymentApiLambda.addEnvironment(
            USE_CASES_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCasesTable.tableName
        );
        deploymentApiLambda.addEnvironment(
            MODEL_INFO_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.modelInfoTable.tableName
        );
        deploymentApiLambda.addEnvironment(
            USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCaseConfigTable.tableName
        );

        this.addDynamoDBNagSuppressions(ddbPolicy, 'deploymentAPI');
    }

    public configureTenantsApiLambda(tenantsApiLambda: lambda.Function): void {
        const tableArn = this.deploymentPlatformStorage.tenantsTable.tableArn;
        const ddbPolicy = new iam.Policy(this, 'TenantsApiDDBPolicy', {
            statements: [
                new iam.PolicyStatement({
                    actions: [
                        'dynamodb:ConditionCheckItem',
                        'dynamodb:DeleteItem',
                        'dynamodb:GetItem',
                        'dynamodb:PutItem',
                        'dynamodb:Query',
                        'dynamodb:Scan',
                        'dynamodb:UpdateItem'
                    ],
                    resources: [tableArn]
                })
            ]
        });
        ddbPolicy.attachToRole(tenantsApiLambda.role!);

        tenantsApiLambda.addEnvironment(TENANTS_TABLE_NAME_ENV_VAR, this.deploymentPlatformStorage.tenantsTable.tableName);
    }

    public configureTenantProvisionSubscriberLambda(tenantProvisionLambda: lambda.Function): void {
        const tenantsTableArn = this.deploymentPlatformStorage.tenantsTable.tableArn;
        const useCasesTableArn = this.deploymentPlatformStorage.useCasesTable.tableArn;
        tenantProvisionLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
                resources: [tenantsTableArn]
            })
        );
        tenantProvisionLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['dynamodb:GetItem', 'dynamodb:Scan'],
                resources: [useCasesTableArn]
            })
        );
        tenantProvisionLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['cloudformation:DescribeStacks'],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:cloudformation:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stack/*/*`
                ]
            })
        );
        tenantProvisionLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['events:PutEvents'],
                resources: ['*']
            })
        );
        tenantProvisionLambda.addEnvironment(
            TENANTS_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.tenantsTable.tableName
        );
        tenantProvisionLambda.addEnvironment(
            USE_CASES_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCasesTable.tableName
        );

        NagSuppressions.addResourceSuppressions(
            tenantProvisionLambda.role!.node.tryFindChild('DefaultPolicy')!.node.tryFindChild('Resource')!,
            [
                {
                    id: 'AwsSolutions-IAM5',
                    reason:
                        'Tenant provision subscriber polls CloudFormation stack status for AIW tenant deploys; stack names are assigned at runtime.'
                }
            ]
        );
    }

    public configureTemplatesApiLambda(
        templatesApiLambda: lambda.Function,
        agentManagementApiLambda: lambda.Function
    ): void {
        const tableArn = this.deploymentPlatformStorage.agentTemplatesTable.tableArn;
        const useCasesTableArn = this.deploymentPlatformStorage.useCasesTable.tableArn;
        const ddbPolicy = new iam.Policy(this, 'TemplatesApiDDBPolicy', {
            statements: [
                new iam.PolicyStatement({
                    actions: [
                        'dynamodb:ConditionCheckItem',
                        'dynamodb:DeleteItem',
                        'dynamodb:GetItem',
                        'dynamodb:PutItem',
                        'dynamodb:Query',
                        'dynamodb:Scan',
                        'dynamodb:UpdateItem'
                    ],
                    resources: [tableArn, `${tableArn}/index/*`, useCasesTableArn]
                })
            ]
        });
        ddbPolicy.attachToRole(templatesApiLambda.role!);

        const cfnDescribePolicy = new iam.Policy(this, 'TemplatesApiCfnDescribePolicy', {
            statements: [
                new iam.PolicyStatement({
                    actions: ['cloudformation:DescribeStacks'],
                    resources: [
                        `arn:${cdk.Aws.PARTITION}:cloudformation:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stack/tpl-test-*/*`
                    ]
                })
            ]
        });
        cfnDescribePolicy.attachToRole(templatesApiLambda.role!);

        // cdk-nag: this is intentionally scoped to the ephemeral test stacks created by template testing.
        // The exact stack name suffix isn't known at synth time, so a prefix wildcard is required.
        NagSuppressions.addResourceSuppressions(cfnDescribePolicy, [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'Templates API needs cloudformation:DescribeStacks access to ephemeral template test stacks (stack name prefix tpl-test-*). The full stack name is generated at runtime during testing.'
            }
        ]);

        agentManagementApiLambda.grantInvoke(templatesApiLambda);

        templatesApiLambda.addEnvironment(
            AGENT_TEMPLATES_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.agentTemplatesTable.tableName
        );
        templatesApiLambda.addEnvironment(
            USE_CASES_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCasesTable.tableName
        );
        templatesApiLambda.addEnvironment('TEMPLATE_TEST_AGENT_FUNCTION_NAME', agentManagementApiLambda.functionName);
        templatesApiLambda.addEnvironment('TEMPLATE_TEST_SYSTEM_USER_ID', 'system:template-testing');

        // GSI access requires tableArn/index/*; AwsSolutions-IAM5 flags that resource wildcard (not covered by action-only suppressions).
        NagSuppressions.addResourceSuppressions(ddbPolicy, [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'The templates API Lambda uses the AgentTemplates table and its GSI (StatusSlugIndex). DynamoDB index ARNs use the tableArn/index/* pattern per IAM requirements.'
            }
        ]);
    }

    public configureModelInfoApiLambda(modelInfoApiLambda: lambda.Function): void {
        new LambdaToDynamoDB(this, 'ModelInfoLambdaToModelInfoDDB', {
            existingLambdaObj: modelInfoApiLambda,
            existingTableObj: this.deploymentPlatformStorage.modelInfoTable,
            tablePermissions: 'Read',
            tableEnvironmentVariableName: MODEL_INFO_TABLE_NAME_ENV_VAR
        });

        modelInfoApiLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles'],
                resources: ['*']
            })
        );
    }

    public configureFeedbackApiLambda(feedbackApiLambda: lambda.Function): void {
        feedbackApiLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['dynamodb:GetItem', 'dynamodb:Query'],
                resources: [
                    this.deploymentPlatformStorage.useCaseConfigTable.tableArn,
                    this.deploymentPlatformStorage.useCasesTable.tableArn
                ]
            })
        );

        feedbackApiLambda.addEnvironment(
            USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCaseConfigTable.tableName
        );
        feedbackApiLambda.addEnvironment(
            USE_CASES_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCasesTable.tableName
        );
    }

    public configureFilesHandlerLambda(filesMetadataLambda: lambda.Function): void {
        filesMetadataLambda.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['dynamodb:GetItem', 'dynamodb:Query'],
                resources: [
                    this.deploymentPlatformStorage.useCaseConfigTable.tableArn,
                    this.deploymentPlatformStorage.useCasesTable.tableArn
                ]
            })
        );

        filesMetadataLambda.addEnvironment(
            USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCaseConfigTable.tableName
        );
        filesMetadataLambda.addEnvironment(
            USE_CASES_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCasesTable.tableName
        );
    }

    public configureUseCaseManagementApiLambda(
        managementApiLambda: lambda.Function,
        type: string,
        includeModelInfoTable: boolean = false
    ): void {
        const resources = [
            this.deploymentPlatformStorage.useCasesTable.tableArn,
            this.deploymentPlatformStorage.useCaseConfigTable.tableArn
        ];

        if (includeModelInfoTable) {
            resources.push(this.deploymentPlatformStorage.modelInfoTable.tableArn);
        }

        const ddbPolicy = new iam.Policy(this, `${type}ManagementDDBPolicy`, {
            statements: [
                new iam.PolicyStatement({
                    actions: [
                        'dynamodb:Batch*',
                        'dynamodb:ConditionCheckItem',
                        'dynamodb:DeleteItem',
                        'dynamodb:Get*',
                        'dynamodb:PutItem',
                        'dynamodb:Query',
                        'dynamodb:Scan',
                        'dynamodb:UpdateItem'
                    ],
                    resources: resources
                })
            ]
        });
        ddbPolicy.attachToRole(managementApiLambda.role!);

        managementApiLambda.addEnvironment(
            USE_CASES_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCasesTable.tableName
        );
        managementApiLambda.addEnvironment(
            USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorage.useCaseConfigTable.tableName
        );

        if (includeModelInfoTable) {
            managementApiLambda.addEnvironment(
                MODEL_INFO_TABLE_NAME_ENV_VAR,
                this.deploymentPlatformStorage.modelInfoTable.tableName
            );
        }

        this.addDynamoDBNagSuppressions(ddbPolicy, `${type.toLowerCase()}Management`);
    }

    private addDynamoDBNagSuppressions(policy: iam.Policy, lambdaType: string): void {
        NagSuppressions.addResourceSuppressions(policy, [
            {
                id: 'AwsSolutions-IAM5',
                reason: `The IAM role allows the ${lambdaType} Lambda function to perform DynamoDB operations. Table name is not known here.`,
                appliesTo: ['Action::dynamodb:Batch*', 'Action::dynamodb:Get*']
            }
        ]);
    }
}
