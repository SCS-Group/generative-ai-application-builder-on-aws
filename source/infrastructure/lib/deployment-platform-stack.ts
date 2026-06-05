#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { ApplicationAssetBundler } from './framework/bundler/asset-options-factory';
import { ApplicationSetup } from './framework/application-setup';
import { BaseStack, BaseStackProps, BaseParameters } from './framework/base-stack';
import { DashboardType } from './metrics/custom-dashboard';
import { CopyUIAssets } from './s3web/copy-ui-assets-nested-stack';
import { UIDistribution } from './s3web/ui-distribution-nested-stack';
import { DeploymentPlatformStorageSetup } from './storage/deployment-platform-storage-setup';
import { UIInfrastructureBuilder } from './ui/ui-infrastructure-builder';
import { UseCaseManagementSetup } from './use-case-management/setup';
import * as cfn_nag from './utils/cfn-guard-suppressions';
import {
    createAgentExecutionRolePassRoleStatement,
    createDefaultLambdaRole,
    generateSourceCodeMapping,
    useDistOutputBucketForUiAssets
} from './utils/common-utils';
import {
    COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME,
    INTERNAL_EMAIL_DOMAIN,
    LAMBDA_TIMEOUT_MINS,
    OPTIONAL_EMAIL_REGEX_PATTERN,
    POWERTOOLS_METRICS_NAMESPACE_ENV_VAR,
    REST_API_NAME_ENV_VAR,
    SHARED_ECR_CACHE_PREFIX_ENV_VAR,
    TENANTS_TABLE_NAME_ENV_VAR,
    TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR,
    TENANT_PROVISION_MCP_FUNCTION_NAME_ENV_VAR,
    TENANT_PROVISION_WORKFLOW_FUNCTION_NAME_ENV_VAR,
    TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR,
    PLATFORM_REST_API_ID_ENV_VAR,
    PLATFORM_REST_API_ROOT_RESOURCE_ID_ENV_VAR,
    USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
    USE_CASES_TABLE_NAME_ENV_VAR,
    UIAssetFolders,
    USE_CASE_MANAGEMENT_NAMESPACE,
    USE_CASE_UUID_ENV_VAR,
    WEB_CONFIG_PREFIX,
    DEFAULT_AIW_OAUTH_CALLBACK_URL,
    AIW_OAUTH_CALLBACK_URL_SSM_PARAM
} from './utils/constants';
import { VPCSetup } from './vpc/vpc-setup';
import { GaabStrandsAgentImageBuild } from './ecr/gaab-strands-agent-image-build';
import { ECRPullThroughCache } from './use-case-stacks/agent-core/components/ecr-pull-through-cache';

export class DeploymentPlatformParameters extends BaseParameters {
    constructor(stack: cdk.Stack) {
        super(stack);
    }

    protected setupUseCaseConfigTableParams(stack: cdk.Stack): void {
        //override
    }

    protected setupUUIDParams(stack: cdk.Stack): void {
        // override
    }
}

/**
 * The main stack creating the infrastructure
 */
export class DeploymentPlatformStack extends BaseStack {
    /**
     * Construct creating the cloudfront distribution assets in a nested stack.
     */
    public readonly uiDistribution: UIDistribution;

    /**
     * Construct creating the custom resource to copy assets in a nested stack.
     */
    public readonly copyAssetsStack: CopyUIAssets;

    /**
     * Construct managing the deployment of a nested stack with resources related to use case management.
     * Includes cognito, APIs for deployment/management of use cases, and backing lambdas.
     */
    public readonly useCaseManagementSetup: UseCaseManagementSetup;

    /**
     * Construct managing the deployment of a nested stack with resources for storing use case data.
     */
    public readonly deploymentPlatformStorageSetup: DeploymentPlatformStorageSetup;

    /**
     * Shared ECR Pull-Through Cache for AgentCore images used by dashboard-deployed use cases
     */
    public readonly sharedEcrPullThroughCache: ECRPullThroughCache;

    constructor(scope: Construct, id: string, props: BaseStackProps) {
        super(scope, id, props);

        new cdk.CfnMapping(this, 'Solution', {
            mapping: {
                Data: {
                    ID: props.solutionID,
                    Version: props.solutionVersion,
                    SolutionName: props.solutionName
                }
            }
        });

        new cdk.CfnMapping(this, 'FeaturesToDeploy', {
            mapping: {
                Deploy: {
                    CustomDashboard: 'Yes'
                }
            }
        });

        const adminUserEmail = new cdk.CfnParameter(this, 'AdminUserEmail', {
            type: 'String',
            description:
                'Optional - Email used to create the default cognito user for the admin platform. If empty, the Cognito User, Group and Attachment will not be created.',
            allowedPattern: OPTIONAL_EMAIL_REGEX_PATTERN,
            constraintDescription: 'Please provide a valid email'
        });

        new cdk.CfnRule(this, 'CognitoUserPoolAndClientRule', {
            ruleCondition: cdk.Fn.conditionNot(
                cdk.Fn.conditionEquals(this.stackParameters.existingCognitoUserPoolId.valueAsString, '')
            ),
            assertions: [
                {
                    assert: cdk.Fn.conditionNot(
                        cdk.Fn.conditionEquals(this.stackParameters.existingUserPoolClientId.valueAsString, '')
                    ),
                    assertDescription:
                        'If an existing User Pool Id is provided, then an existing User Pool Client Id must also be provided.'
                }
            ]
        });

        new cdk.CfnRule(this, 'CognitoDomainNotProvidedIfPoolIsRule', {
            ruleCondition: cdk.Fn.conditionNot(
                cdk.Fn.conditionEquals(this.stackParameters.existingCognitoUserPoolId.valueAsString, '')
            ),
            assertions: [
                {
                    assert: cdk.Fn.conditionEquals(this.stackParameters.cognitoUserPoolClientDomain.valueAsString, ''),
                    assertDescription:
                        'If an existing User Pool Id is provided, then a domain name for the User Pool Client must not be provided.'
                }
            ]
        });

        const stack = cdk.Stack.of(this);
        const existingParameterGroups =
            stack.templateOptions.metadata !== undefined &&
            Object.hasOwn(stack.templateOptions.metadata, 'AWS::CloudFormation::Interface') &&
            stack.templateOptions.metadata['AWS::CloudFormation::Interface'].ParameterGroups !== undefined
                ? stack.templateOptions.metadata['AWS::CloudFormation::Interface'].ParameterGroups
                : [];

        existingParameterGroups.unshift({
            Label: { default: 'Please provide admin user email' },
            Parameters: [adminUserEmail.logicalId]
        });

        /**
         * this CfnParameter is defined in the base stack. The deployment stack only adds it to a parameter group
         */
        existingParameterGroups.push({
            Label: {
                default:
                    'Optional: If you would like to provide a sub domain for the UserPoolClient configuration. If not provided, a hashed value using the AWS Account number, current region, and stack name, will be used as sub-domain name'
            },
            Parameters: [this.stackParameters.cognitoUserPoolClientDomain.logicalId]
        });

        /**
         * parameter group for bringing your own cognito user pool and client
         */
        existingParameterGroups.push({
            Label: {
                default:
                    'Optional: Provide existing Cognito UserPool and UserPoolClient IDs if you want to use your own managed resources. If left empty, the solution will manage these resources for you. Note: To prevent the creation of Cognito resources within the user pool (Users/Groups), simply leave the AdminUserEmail parameter empty.'
            },
            Parameters: [
                this.stackParameters.existingCognitoUserPoolId.logicalId,
                this.stackParameters.existingUserPoolClientId.logicalId
            ]
        });

        // internal users are identified by being of the form "X@amazon.Y"
        const isInternalUserCondition: cdk.CfnCondition = new cdk.CfnCondition(this, 'IsInternalUserCondition', {
            expression: cdk.Fn.conditionEquals(
                cdk.Fn.select(
                    0,
                    cdk.Fn.split(
                        '.',
                        cdk.Fn.select(
                            1,
                            cdk.Fn.split('@', cdk.Fn.join('', [adminUserEmail.valueAsString, '@example.com']))
                        )
                    )
                ),
                INTERNAL_EMAIL_DOMAIN
            )
        });

        const uuid: string = this.applicationSetup.addUUIDGeneratorCustomResource().getAttString('UUID');
        this.applicationSetup.scheduledMetricsLambda.addEnvironment(USE_CASE_UUID_ENV_VAR, uuid);

        const uiInfrastructureBuilder = new UIInfrastructureBuilder({
            uiAssetFolder: UIAssetFolders.DEPLOYMENT_PLATFORM,
            deployWebApp: this.deployWebApp.valueAsString
        });

        this.uiDistribution = uiInfrastructureBuilder.createDistribution(this, 'WebApp', {
            parameters: {
                CustomResourceLambdaArn: this.applicationSetup.customResourceLambda.functionArn,
                CustomResourceRoleArn: this.applicationSetup.customResourceLambda.role!.roleArn,
                AccessLoggingBucketArn: this.applicationSetup.accessLoggingBucket.bucketArn,
                UseCaseUUID: uuid
            },
            description: `Nested stack that deploys UI components that include an S3 bucket for web assets and a CloudFront distribution - Version ${props.solutionVersion}`
        });

        const webConfigSsmKey: string = `${WEB_CONFIG_PREFIX}/${cdk.Aws.STACK_NAME}`;

        this.deploymentPlatformStorageSetup = new DeploymentPlatformStorageSetup(this, 'DeploymentPlatformStorage', {
            customResourceLambda: this.applicationSetup.customResourceLambda,
            customResourceRole: this.applicationSetup.customResourceRole,
            accessLoggingBucket: this.applicationSetup.accessLoggingBucket,
            ...this.baseStackProps
        });

        // Create shared ECR Pull-Through Cache for AgentCore images
        // This cache will be used by all agent builder and workflow use cases deployed through the dashboard
        const solutionVersion = process.env.VERSION ?? this.node.tryGetContext('solution_version');
        this.sharedEcrPullThroughCache = new ECRPullThroughCache(this, 'SharedECRPullThroughCache', {
            gaabVersion: solutionVersion,
            customResourceLambda: this.applicationSetup.customResourceLambda
            // No useCaseShortId provided - will generate from stack name (shared cache)
        });

        new GaabStrandsAgentImageBuild(this, 'AgentStrandsEcrImagePublish', {
            gaabVersion: solutionVersion,
            ecrRepositoryPrefix: this.sharedEcrPullThroughCache.getRepositoryPrefix(),
            customResourceLambda: this.applicationSetup.customResourceLambda
        });

        this.useCaseManagementSetup = new UseCaseManagementSetup(this, 'UseCaseManagementSetup', {
            defaultUserEmail: adminUserEmail.valueAsString,
            webConfigSSMKey: webConfigSsmKey,
            customInfra: this.applicationSetup.customResourceLambda,
            securityGroupIds: this.transpiredSecurityGroupIds,
            privateSubnetIds: this.transpiredPrivateSubnetIds,
            cognitoDomainPrefix: this.stackParameters.cognitoUserPoolClientDomain.valueAsString,
            cloudFrontUrl: uiInfrastructureBuilder.getCloudFrontUrlWithCondition(),
            deployWebApp: this.deployWebApp.valueAsString,
            deployWebAppCondition: uiInfrastructureBuilder.deployWebAppCondition,
            accessLoggingBucket: this.applicationSetup.accessLoggingBucket,
            existingCognitoUserPoolId: this.stackParameters.existingCognitoUserPoolId.valueAsString,
            existingCognitoUserPoolClientId: this.stackParameters.existingUserPoolClientId.valueAsString,
            llmConfigTable: this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCaseConfigTable,
            ...this.baseStackProps
        });

        this.deploymentPlatformStorageSetup.configureDeploymentApiLambda(
            this.useCaseManagementSetup.useCaseManagement.useCaseManagementApiLambda
        );
        this.deploymentPlatformStorageSetup.configureModelInfoApiLambda(
            this.useCaseManagementSetup.useCaseManagement.modelInfoApiLambda
        );
        this.deploymentPlatformStorageSetup.configureFeedbackApiLambda(
            this.useCaseManagementSetup.feedbackSetupStack.feedbackAPILambda
        );
        this.deploymentPlatformStorageSetup.configureUseCaseManagementApiLambda(
            this.useCaseManagementSetup.useCaseManagement.mcpManagementApiLambda,
            'MCP'
        );
        this.deploymentPlatformStorageSetup.configureUseCaseManagementApiLambda(
            this.useCaseManagementSetup.useCaseManagement.agentManagementApiLambda,
            'Agent',
            true
        );
        this.deploymentPlatformStorageSetup.configureUseCaseManagementApiLambda(
            this.useCaseManagementSetup.useCaseManagement.workflowManagementApiLambda,
            'Workflow',
            true
        );
        this.deploymentPlatformStorageSetup.configureUseCaseManagementApiLambda(
            this.useCaseManagementSetup.useCaseManagement.useCaseUsageApiLambda,
            'UseCaseUsage'
        );
        this.deploymentPlatformStorageSetup.configureTemplatesApiLambda(
            this.useCaseManagementSetup.useCaseManagement.templatesManagementApiLambda,
            this.useCaseManagementSetup.useCaseManagement.agentManagementApiLambda
        );
        this.deploymentPlatformStorageSetup.configureTenantsApiLambda(
            this.useCaseManagementSetup.useCaseManagement.tenantsManagementApiLambda
        );
        this.deploymentPlatformStorageSetup.configureFilesHandlerLambda(
            this.useCaseManagementSetup.multimodalSetup.filesHandlerLambda
        );

        const toolConnectionOAuthProvidersJson = new ssm.StringParameter(this, 'ToolConnectionOAuthProviders', {
            description:
                'Map oauthProviderName → { credentialProviderArn } for AIW tenant tool connections (AgentCore Identity)',
            stringValue: JSON.stringify({
                'platform-google-drive': { credentialProviderArn: 'REPLACE_WITH_PLATFORM_GOOGLE_ARN' },
                'platform-gmail': { credentialProviderArn: 'REPLACE_WITH_PLATFORM_GOOGLE_ARN' },
                'platform-dropbox': { credentialProviderArn: 'REPLACE_WITH_PLATFORM_DROPBOX_ARN' },
                'platform-figma': { credentialProviderArn: 'REPLACE_WITH_PLATFORM_FIGMA_ARN' }
            }),
            tier: ssm.ParameterTier.STANDARD
        });

        const toolConnectionMcpSchemaUrisJson = new ssm.StringParameter(this, 'ToolConnectionMcpSchemaUris', {
            description:
                'Map mcpTargetName → S3 schema key (under GAAB deployments bucket) for prewired OpenAPI gateway targets',
            stringValue: JSON.stringify({
                gmail: 'mcp/schemas/openApiSchema/00000000-0000-0000-0000-000000000101.yaml',
                'google-drive': 'mcp/schemas/openApiSchema/00000000-0000-0000-0000-000000000102.yaml',
                dropbox: 'mcp/schemas/openApiSchema/00000000-0000-0000-0000-000000000103.yaml',
                figma: 'mcp/schemas/openApiSchema/00000000-0000-0000-0000-000000000104.yaml',
                discord: 'mcp/schemas/openApiSchema/00000000-0000-0000-0000-000000000105.yaml'
            }),
            tier: ssm.ParameterTier.STANDARD
        });

        const aiwOAuthCallbackUrl = new ssm.StringParameter(this, 'AiwOAuthCallbackUrl', {
            parameterName: AIW_OAUTH_CALLBACK_URL_SSM_PARAM,
            description: 'AIW OAuth callback URL for MCP gateway OpenAPI targets (authorization code grant)',
            stringValue: DEFAULT_AIW_OAUTH_CALLBACK_URL,
            tier: ssm.ParameterTier.STANDARD
        });

        new ssm.StringParameter(this, 'AiwFigmaToolProxyLambdaName', {
            parameterName: '/gaab-deployment-platform/AiwFigmaToolProxyLambdaName',
            description:
                'AIW figma-tool-proxy Lambda function name (overwritten by AIW Amplify deploy; used for agent runtime env sync)',
            stringValue: 'aiw-figma-tool-proxy',
            tier: ssm.ParameterTier.STANDARD
        });

        this.applicationSetup.customResourceLambda.addEnvironment(
            'AIW_OAUTH_CALLBACK_URL',
            aiwOAuthCallbackUrl.stringValue
        );

        // AIW Phase 1: seed minimal OpenAPI schemas into the deployments bucket so tenant provisioning
        // can deploy a per-tenant MCP gateway without a manual UI “upload schema” step.
        const seedSchemas = new s3deploy.BucketDeployment(this, 'AiwSeedOpenApiSchemas', {
            destinationBucket: this.useCaseManagementSetup.useCaseManagement.deploymentPlatformBucket,
            destinationKeyPrefix: 'mcp/schemas/openApiSchema',
            sources: [
                s3deploy.Source.asset(
                    path.join(__dirname, '..', 'assets', 'aiw-openapi-schemas'),
                    { exclude: ['README.md'] }
                )
            ]
        });

        // BucketDeployment uses a CDK-managed singleton Lambda + role. Suppress the standard nag findings for this known pattern.
        // We only use it to copy a small fixed set of seeded OpenAPI schema files into the deployments bucket.
        NagSuppressions.addStackSuppressions(this, [
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    'CDK BucketDeployment provider uses AWSLambdaBasicExecutionRole managed policy; acceptable for CDK-generated custom resource.'
            },
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'CDK BucketDeployment provider requires wildcard S3 actions on the staging asset and destination bucket to perform copies.'
            }
        ]);

        const tenantProvisionSubscriberRole = createDefaultLambdaRole(this, 'TenantProvisionSubscriberRole');

        const tenantProvisionSubscriber = new lambda.Function(this, 'TenantProvisionSubscriber', {
            description: 'AIW TenantProvisionRequested: upsert tenant and invoke Agent Management deploy',
            role: tenantProvisionSubscriberRole,
            code: lambda.Code.fromAsset(
                '../lambda/tenant-provision-subscriber',
                ApplicationAssetBundler.assetBundlerFactory()
                    .assetOptions(COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME)
                    .options(this, '../lambda/tenant-provision-subscriber')
            ),
            runtime: COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(LAMBDA_TIMEOUT_MINS),
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                [TENANTS_TABLE_NAME_ENV_VAR]:
                    this.deploymentPlatformStorageSetup.deploymentPlatformStorage.tenantsTable.tableName,
                [TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR]:
                    this.useCaseManagementSetup.useCaseManagement.agentManagementApiLambda.functionName,
                [TENANT_PROVISION_MCP_FUNCTION_NAME_ENV_VAR]:
                    this.useCaseManagementSetup.useCaseManagement.mcpManagementApiLambda.functionName,
                [USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]:
                    this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCaseConfigTable.tableName,
                [TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR]: 'system:aiw-tenant-provision',
                EVENT_BUS_NAME: 'default',
                [POWERTOOLS_METRICS_NAMESPACE_ENV_VAR]: USE_CASE_MANAGEMENT_NAMESPACE,
                TOOL_CONNECTION_OAUTH_PROVIDERS_JSON: toolConnectionOAuthProvidersJson.stringValue,
                TOOL_CONNECTION_MCP_SCHEMA_URIS_JSON: toolConnectionMcpSchemaUrisJson.stringValue,
                AIW_OAUTH_CALLBACK_URL: aiwOAuthCallbackUrl.stringValue,
                [PLATFORM_REST_API_ID_ENV_VAR]: this.useCaseManagementSetup.restApi.restApiId,
                [PLATFORM_REST_API_ROOT_RESOURCE_ID_ENV_VAR]:
                    this.useCaseManagementSetup.restApi.restApiRootResourceId
            }
        });

        this.deploymentPlatformStorageSetup.configureTenantProvisionSubscriberLambda(tenantProvisionSubscriber);
        toolConnectionOAuthProvidersJson.grantRead(tenantProvisionSubscriber);
        toolConnectionMcpSchemaUrisJson.grantRead(tenantProvisionSubscriber);
        this.useCaseManagementSetup.useCaseManagement.agentManagementApiLambda.grantInvoke(
            tenantProvisionSubscriber
        );
        this.useCaseManagementSetup.useCaseManagement.mcpManagementApiLambda.grantInvoke(tenantProvisionSubscriber);

        tenantProvisionSubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'bedrock-agentcore:GetAgentRuntime',
                    'bedrock-agentcore:ListAgentRuntimes',
                    'bedrock-agentcore:UpdateAgentRuntime'
                ],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`
                ]
            })
        );
        // Dedicated policy so PassRole survives CDK updates (hotswap cannot change IAM).
        const tenantProvisionPassRolePolicy = new iam.Policy(this, 'TenantProvisionAgentRuntimePassRolePolicy', {
            roles: [tenantProvisionSubscriberRole],
            statements: [createAgentExecutionRolePassRoleStatement(this)]
        });
        NagSuppressions.addResourceSuppressions(tenantProvisionPassRolePolicy, [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'PassRole is scoped to *AgentExecutionRole* (CFN-truncated agent stack roles) and bedrock-agentcore.amazonaws.com only.'
            }
        ]);
        tenantProvisionSubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['ssm:GetParameter'],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/gaab-deployment-platform/*`
                ]
            })
        );

        const tenantProvisionPolicy = tenantProvisionSubscriber.role!.node
            .tryFindChild('DefaultPolicy')!
            .node.tryFindChild('Resource')!;
        NagSuppressions.addResourceSuppressions(tenantProvisionPolicy, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'The IAM role allows the Lambda function to perform x-ray tracing and to invoke the Agent Management Lambda (CDK grant uses ARN:*).'
            }
        ]);

        cfn_nag.addCfnSuppressRules(tenantProvisionSubscriber, [
            {
                id: 'W89',
                reason: 'VPC deployment is not enforced. If the solution is deployed in a VPC, this lambda function will be deployed with VPC enabled configuration'
            },
            {
                id: 'W92',
                reason: 'The solution does not enforce reserved concurrency'
            }
        ]);

        cfn_nag.addCfnSuppressRules(tenantProvisionSubscriberRole, [
            {
                id: 'W89',
                reason: 'VPC deployment is not enforced. If the solution is deployed in a VPC, this lambda function will be deployed with VPC enabled configuration'
            },
            {
                id: 'W92',
                reason: 'The solution does not enforce reserved concurrency'
            }
        ]);

        cfn_nag.addCfnSuppressRules(tenantProvisionSubscriberRole, [
            {
                id: 'F10',
                reason: 'The inline policy avoids a rare race condition between the lambda, Role and the policy resource creation.'
            }
        ]);

        new events.Rule(this, 'AiwTenantProvisionRequestedRule', {
            eventBus: events.EventBus.fromEventBusName(this, 'DefaultEventBusTenantProvision', 'default'),
            description: 'Route AIW tenant provision requests to GAAB subscriber',
            eventPattern: {
                source: ['aiw.tenant'],
                detailType: ['TenantProvisionRequested']
            },
            targets: [
                new events_targets.LambdaFunction(tenantProvisionSubscriber, {
                    // Do not re-run full gateway+agent deploy after Lambda timeout (was causing ghost stacks).
                    retryAttempts: 0
                })
            ]
        });

        const orchestratorProvisionSubscriberRole = createDefaultLambdaRole(
            this,
            'OrchestratorProvisionSubscriberRole'
        );

        const orchestratorProvisionSubscriber = new lambda.Function(this, 'OrchestratorProvisionSubscriber', {
            description:
                'AIW OrchestratorProvisionRequested: read-only specialist snapshots → POST /deployments/workflows',
            role: orchestratorProvisionSubscriberRole,
            code: lambda.Code.fromAsset(
                '../lambda/orchestrator-provision-subscriber',
                ApplicationAssetBundler.assetBundlerFactory()
                    .assetOptions(COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME)
                    .options(this, '../lambda/orchestrator-provision-subscriber')
            ),
            runtime: COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(LAMBDA_TIMEOUT_MINS),
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                [USE_CASES_TABLE_NAME_ENV_VAR]:
                    this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCasesTable.tableName,
                [USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]:
                    this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCaseConfigTable.tableName,
                [TENANT_PROVISION_WORKFLOW_FUNCTION_NAME_ENV_VAR]:
                    this.useCaseManagementSetup.useCaseManagement.workflowManagementApiLambda.functionName,
                [TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR]: 'system:aiw-orchestrator-provision',
                EVENT_BUS_NAME: 'default',
                [PLATFORM_REST_API_ID_ENV_VAR]: this.useCaseManagementSetup.restApi.restApiId,
                [PLATFORM_REST_API_ROOT_RESOURCE_ID_ENV_VAR]:
                    this.useCaseManagementSetup.restApi.restApiRootResourceId,
                DEFAULT_ORCHESTRATOR_MODEL_ID: 'anthropic.claude-3-5-sonnet-20241022-v2:0'
            }
        });

        this.deploymentPlatformStorageSetup.configureOrchestratorProvisionSubscriberLambda(
            orchestratorProvisionSubscriber
        );
        this.useCaseManagementSetup.useCaseManagement.workflowManagementApiLambda.grantInvoke(
            orchestratorProvisionSubscriber
        );

        orchestratorProvisionSubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'OrchestratorProvisionAgentCoreRuntime',
                effect: iam.Effect.ALLOW,
                actions: [
                    'bedrock-agentcore:GetAgentRuntime',
                    'bedrock-agentcore:ListAgentRuntimes',
                    'bedrock-agentcore:UpdateAgentRuntime'
                ],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`
                ]
            })
        );
        const orchestratorProvisionPassRolePolicy = new iam.Policy(this, 'OrchestratorProvisionAgentRuntimePassRolePolicy', {
            roles: [orchestratorProvisionSubscriberRole],
            statements: [createAgentExecutionRolePassRoleStatement(this)]
        });
        NagSuppressions.addResourceSuppressions(orchestratorProvisionPassRolePolicy, [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'PassRole is scoped to *AgentExecutionRole* (CFN-truncated workflow/agent stack roles) and bedrock-agentcore.amazonaws.com only.'
            }
        ]);
        orchestratorProvisionSubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'OrchestratorProvisionSsmPlatformParams',
                effect: iam.Effect.ALLOW,
                actions: ['ssm:GetParameter'],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/gaab-deployment-platform/*`
                ]
            })
        );

        const orchestratorProvisionPolicy = orchestratorProvisionSubscriber.role!.node
            .tryFindChild('DefaultPolicy')!
            .node.tryFindChild('Resource')!;
        NagSuppressions.addResourceSuppressions(orchestratorProvisionPolicy, [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'Orchestrator provision subscriber invokes Workflow Management Lambda and polls CloudFormation stack status.'
            }
        ]);

        cfn_nag.addCfnSuppressRules(orchestratorProvisionSubscriber, [
            {
                id: 'W89',
                reason: 'VPC deployment is not enforced for orchestrator provision subscriber.'
            },
            {
                id: 'W92',
                reason: 'The solution does not enforce reserved concurrency'
            }
        ]);

        cfn_nag.addCfnSuppressRules(orchestratorProvisionSubscriberRole, [
            {
                id: 'W89',
                reason: 'VPC deployment is not enforced for orchestrator provision subscriber role.'
            },
            {
                id: 'W92',
                reason: 'The solution does not enforce reserved concurrency'
            },
            {
                id: 'F10',
                reason: 'Inline policy avoids race between lambda, role, and policy resource creation.'
            }
        ]);

        new events.Rule(this, 'AiwOrchestratorProvisionRequestedRule', {
            eventBus: events.EventBus.fromEventBusName(this, 'DefaultEventBusOrchestratorProvision', 'default'),
            description: 'Route AIW orchestrator provision requests to GAAB workflow deploy subscriber',
            eventPattern: {
                source: ['aiw.tenant'],
                detailType: ['OrchestratorProvisionRequested', 'OrchestratorDeprovisionRequested']
            },
            targets: [
                new events_targets.LambdaFunction(orchestratorProvisionSubscriber, {
                    retryAttempts: 0
                })
            ]
        });

        const tenantToolConnectionSubscriberRole = createDefaultLambdaRole(
            this,
            'TenantToolConnectionSubscriberRole'
        );

        const tenantToolConnectionSubscriber = new lambda.Function(this, 'TenantToolConnectionSubscriber', {
            description: 'AIW TenantToolConnectionRequested → AgentCore OAuth authorization URL',
            role: tenantToolConnectionSubscriberRole,
            code: lambda.Code.fromAsset(
                '../lambda/tenant-tool-connection-subscriber',
                ApplicationAssetBundler.assetBundlerFactory()
                    .assetOptions(COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME)
                    .options(this, '../lambda/tenant-tool-connection-subscriber')
            ),
            runtime: COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(2),
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                EVENT_BUS_NAME: 'default',
                TOOL_CONNECTION_OAUTH_PROVIDERS_JSON: toolConnectionOAuthProvidersJson.stringValue,
                AIW_TOOL_CONNECTION_WORKLOAD_NAME: 'aiw-platform-tool-oauth'
            }
        });

        toolConnectionOAuthProvidersJson.grantRead(tenantToolConnectionSubscriber);

        this.deploymentPlatformStorageSetup.configureTenantToolConnectionSubscriberLambda(
            tenantToolConnectionSubscriber,
            tenantToolConnectionSubscriberRole.roleArn
        );

        new ssm.StringParameter(this, 'TenantToolConnectionSubscriberRoleArnParam', {
            parameterName: '/DeploymentPlatformStack/TenantToolConnectionSubscriberRoleArn',
            stringValue: tenantToolConnectionSubscriberRole.roleArn,
            description: 'GAAB role allowed to assume MCP gateway roles for AIW OAuth token binding',
            tier: ssm.ParameterTier.STANDARD
        });

        tenantToolConnectionSubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'AgentCoreOAuthChallengeGateway',
                effect: iam.Effect.ALLOW,
                actions: [
                    'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
                    'bedrock-agentcore:GetWorkloadAccessToken',
                    'bedrock-agentcore:GetResourceOauth2Token',
                    'bedrock-agentcore:CreateWorkloadIdentity',
                    'bedrock-agentcore:GetWorkloadIdentity',
                    'bedrock-agentcore:UpdateWorkloadIdentity',
                    'bedrock-agentcore:GetOauth2CredentialProvider',
                    'events:PutEvents'
                ],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workload-identity-directory/default`,
                    `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workload-identity-directory/default/workload-identity/*`,
                    `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:token-vault/default`,
                    `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:token-vault/default/oauth2credentialprovider/*`
                ]
            })
        );

        // AIW Phase 2: install tool targets onto an existing gateway (catalog-style, post-deploy).
        const tenantToolIntegrationInstallerRole = createDefaultLambdaRole(
            this,
            'TenantToolIntegrationInstallerRole'
        );
        const tenantToolIntegrationInstaller = new lambda.Function(this, 'TenantToolIntegrationInstaller', {
            description: 'AIW TenantToolIntegrationInstallRequested → attach gateway target',
            role: tenantToolIntegrationInstallerRole,
            code: lambda.Code.fromAsset(
                '../lambda/tenant-tool-integration-installer',
                ApplicationAssetBundler.assetBundlerFactory()
                    .assetOptions(COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME)
                    .options(this, '../lambda/tenant-tool-integration-installer')
            ),
            runtime: COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(2),
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                EVENT_BUS_NAME: 'default',
                TOOL_CONNECTION_OAUTH_PROVIDERS_JSON: toolConnectionOAuthProvidersJson.stringValue,
                TOOL_CONNECTION_MCP_SCHEMA_URIS_JSON: toolConnectionMcpSchemaUrisJson.stringValue,
                AIW_OAUTH_CALLBACK_URL: aiwOAuthCallbackUrl.stringValue,
                DEPLOYMENTS_BUCKET_NAME: this.useCaseManagementSetup.useCaseManagement.deploymentPlatformBucket.bucketName
            }
        });
        toolConnectionOAuthProvidersJson.grantRead(tenantToolIntegrationInstaller);
        toolConnectionMcpSchemaUrisJson.grantRead(tenantToolIntegrationInstaller);
        // Installer reads seeded schemas and may also upload per-tenant custom OpenAPI schemas (BYO tools).
        this.useCaseManagementSetup.useCaseManagement.deploymentPlatformBucket.grantReadWrite(
            tenantToolIntegrationInstaller
        );
        tenantToolIntegrationInstallerRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'bedrock-agentcore:ListGateways',
                    'bedrock-agentcore:ListGatewayTargets',
                    'bedrock-agentcore:CreateGatewayTarget',
                    'bedrock-agentcore:UpdateGatewayTarget',
                    'bedrock-agentcore:GetGateway',
                    'bedrock-agentcore:GetApiKeyCredentialProvider'
                ],
                resources: ['*']
            })
        );
        tenantToolIntegrationInstallerRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['iam:PutRolePolicy', 'iam:GetRolePolicy'],
                resources: [`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/*MCPGatewayRole*`]
            })
        );
        tenantToolIntegrationInstaller.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['events:PutEvents'],
                resources: ['*']
            })
        );
        this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCasesTable.grantReadData(
            tenantToolIntegrationInstaller
        );
        this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCaseConfigTable.grantReadWriteData(
            tenantToolIntegrationInstaller
        );
        tenantToolIntegrationInstaller.addEnvironment(
            USE_CASES_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCasesTable.tableName
        );
        tenantToolIntegrationInstaller.addEnvironment(
            USE_CASE_CONFIG_TABLE_NAME_ENV_VAR,
            this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCaseConfigTable.tableName
        );
        new events.Rule(this, 'AiwTenantToolIntegrationInstallRequestedRule', {
            eventBus: events.EventBus.fromEventBusName(this, 'DefaultEventBusToolIntegrationInstall', 'default'),
            description: 'Route AIW integration installs to GAAB installer',
            eventPattern: {
                source: ['aiw.tenant'],
                detailType: ['TenantToolIntegrationInstallRequested']
            },
            targets: [new events_targets.LambdaFunction(tenantToolIntegrationInstaller)]
        });

        tenantToolConnectionSubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'AgentCoreOAuthResolveAgentRuntime',
                effect: iam.Effect.ALLOW,
                actions: ['bedrock-agentcore:ListAgentRuntimes', 'bedrock-agentcore:GetAgentRuntime'],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:runtime/*`
                ]
            })
        );

        tenantToolConnectionSubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'AgentCoreOAuthChallengeEventBridge',
                effect: iam.Effect.ALLOW,
                actions: ['events:PutEvents'],
                resources: ['*']
            })
        );

        tenantToolConnectionSubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'AgentCoreIdentitySecrets',
                effect: iam.Effect.ALLOW,
                actions: ['secretsmanager:GetSecretValue'],
                resources: [
                    `arn:${cdk.Aws.PARTITION}:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:bedrock-agentcore-identity!*`
                ]
            })
        );

        const tenantToolConnectionPolicy = tenantToolConnectionSubscriberRole.node
            .tryFindChild('DefaultPolicy')!
            .node.tryFindChild('Resource')!;
        NagSuppressions.addResourceSuppressions(tenantToolConnectionPolicy, [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'EventBridge PutEvents for cross-account AIW challenge delivery uses a bus ARN that is not known at synth time.'
            }
        ]);

        cfn_nag.addCfnSuppressRules(tenantToolConnectionSubscriber, [
            {
                id: 'W89',
                reason: 'VPC deployment is not enforced for this EventBridge subscriber.'
            },
            {
                id: 'W92',
                reason: 'The solution does not enforce reserved concurrency'
            }
        ]);

        cfn_nag.addCfnSuppressRules(tenantToolConnectionSubscriberRole, [
            {
                id: 'W89',
                reason: 'VPC deployment is not enforced for this EventBridge subscriber.'
            },
            {
                id: 'W92',
                reason: 'The solution does not enforce reserved concurrency'
            },
            {
                id: 'F10',
                reason: 'The inline policy avoids a rare race condition between the lambda, Role and the policy resource creation.'
            }
        ]);

        new events.Rule(this, 'AiwTenantToolConnectionRequestedRule', {
            eventBus: events.EventBus.fromEventBusName(this, 'DefaultEventBusToolConnection', 'default'),
            description: 'Route AIW tool connection requests to GAAB OAuth challenge worker',
            eventPattern: {
                source: ['aiw.tenant'],
                detailType: ['TenantToolConnectionRequested']
            },
            targets: [new events_targets.LambdaFunction(tenantToolConnectionSubscriber)]
        });

        const tenantDeprovisionSubscriberRole = createDefaultLambdaRole(this, 'TenantDeprovisionSubscriberRole');

        const tenantDeprovisionSubscriber = new lambda.Function(this, 'TenantDeprovisionSubscriber', {
            description:
                'AIW TenantDeprovisionRequested: MCP gateway stack first, then agent; emit deprovision lifecycle to AIW',
            role: tenantDeprovisionSubscriberRole,
            code: lambda.Code.fromAsset(
                '../lambda/tenant-deprovision-subscriber',
                ApplicationAssetBundler.assetBundlerFactory()
                    .assetOptions(COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME)
                    .options(this, '../lambda/tenant-deprovision-subscriber')
            ),
            runtime: COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(LAMBDA_TIMEOUT_MINS),
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                [TENANT_PROVISION_AGENT_FUNCTION_NAME_ENV_VAR]:
                    this.useCaseManagementSetup.useCaseManagement.agentManagementApiLambda.functionName,
                [TENANT_PROVISION_MCP_FUNCTION_NAME_ENV_VAR]:
                    this.useCaseManagementSetup.useCaseManagement.mcpManagementApiLambda.functionName,
                [TENANT_PROVISION_SYSTEM_USER_ID_ENV_VAR]: 'system:aiw-tenant-deprovision',
                [POWERTOOLS_METRICS_NAMESPACE_ENV_VAR]: USE_CASE_MANAGEMENT_NAMESPACE,
                EVENT_BUS_NAME: 'default'
            }
        });

        this.useCaseManagementSetup.useCaseManagement.agentManagementApiLambda.grantInvoke(
            tenantDeprovisionSubscriber
        );
        this.useCaseManagementSetup.useCaseManagement.mcpManagementApiLambda.grantInvoke(
            tenantDeprovisionSubscriber
        );

        tenantDeprovisionSubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'TenantDeprovisionStackPollAndStatus',
                effect: iam.Effect.ALLOW,
                actions: ['cloudformation:DescribeStacks', 'events:PutEvents'],
                resources: ['*']
            })
        );

        cfn_nag.addCfnSuppressRules(tenantDeprovisionSubscriber, [
            {
                id: 'W89',
                reason: 'VPC deployment is not enforced. If the solution is deployed in a VPC, this lambda function will be deployed with VPC enabled configuration'
            },
            {
                id: 'W92',
                reason: 'The solution does not enforce reserved concurrency'
            }
        ]);

        const tenantDeprovisionPolicy = tenantDeprovisionSubscriber.role!.node
            .tryFindChild('DefaultPolicy')!
            .node.tryFindChild('Resource')!;
        NagSuppressions.addResourceSuppressions(tenantDeprovisionPolicy, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'The IAM role allows the Lambda function to perform x-ray tracing and to invoke the Agent Management Lambda (CDK grant uses ARN:*).'
            }
        ]);

        cfn_nag.addCfnSuppressRules(tenantDeprovisionSubscriberRole, [
            {
                id: 'W89',
                reason: 'VPC deployment is not enforced. If the solution is deployed in a VPC, this lambda function will be deployed with VPC enabled configuration'
            },
            {
                id: 'W92',
                reason: 'The solution does not enforce reserved concurrency'
            },
            {
                id: 'F10',
                reason: 'The inline policy avoids a rare race condition between the lambda, Role and the policy resource creation.'
            }
        ]);

        new events.Rule(this, 'AiwTenantDeprovisionRequestedRule', {
            eventBus: events.EventBus.fromEventBusName(this, 'DefaultEventBusTenantDeprovision', 'default'),
            description: 'Route AIW tenant deprovision requests to GAAB subscriber',
            eventPattern: {
                source: ['aiw.tenant'],
                detailType: ['TenantDeprovisionRequested']
            },
            targets: [new events_targets.LambdaFunction(tenantDeprovisionSubscriber)]
        });

        const tenantPolicyApplySubscriberRole = createDefaultLambdaRole(this, 'TenantPolicyApplySubscriberRole');

        const tenantPolicyApplySubscriber = new lambda.Function(this, 'TenantPolicyApplySubscriber', {
            description:
                'AIW TenantPolicyApplyRequested: compile Cedar, upsert AgentCore Policy engine, associate MCP gateway (LOG_ONLY)',
            role: tenantPolicyApplySubscriberRole,
            code: lambda.Code.fromAsset(
                '../lambda/tenant-policy-apply-subscriber',
                ApplicationAssetBundler.assetBundlerFactory()
                    .assetOptions(COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME)
                    .options(this, '../lambda/tenant-policy-apply-subscriber')
            ),
            runtime: COMMERCIAL_REGION_LAMBDA_NODE_RUNTIME,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(5),
            tracing: lambda.Tracing.ACTIVE,
            environment: {
                [USE_CASE_CONFIG_TABLE_NAME_ENV_VAR]:
                    this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCaseConfigTable.tableName,
                [USE_CASES_TABLE_NAME_ENV_VAR]:
                    this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCasesTable.tableName,
                EVENT_BUS_NAME: 'default',
                [POWERTOOLS_METRICS_NAMESPACE_ENV_VAR]: USE_CASE_MANAGEMENT_NAMESPACE,
                AIW_OAUTH_CALLBACK_URL: aiwOAuthCallbackUrl.stringValue
            }
        });

        this.deploymentPlatformStorageSetup.configureTenantPolicyApplySubscriberLambda(tenantPolicyApplySubscriber);

        tenantPolicyApplySubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'TenantPolicyApplyAgentCorePolicyAndGateway',
                effect: iam.Effect.ALLOW,
                actions: [
                    'bedrock-agentcore:ListGateways',
                    'bedrock-agentcore:GetGateway',
                    'bedrock-agentcore:ListGatewayTargets',
                    'bedrock-agentcore:UpdateGateway',
                    'bedrock-agentcore:CreatePolicyEngine',
                    'bedrock-agentcore:GetPolicyEngine',
                    'bedrock-agentcore:ListPolicyEngines',
                    'bedrock-agentcore:CreatePolicy',
                    'bedrock-agentcore:UpdatePolicy',
                    'bedrock-agentcore:GetPolicy',
                    'bedrock-agentcore:ListPolicies',
                    'bedrock-agentcore:ManageResourceScopedPolicy'
                ],
                resources: ['*']
            })
        );

        tenantPolicyApplySubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'TenantPolicyApplyMcpGatewayPassRole',
                effect: iam.Effect.ALLOW,
                actions: ['iam:PassRole'],
                resources: [`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/*MCPGatewayRole*`],
                conditions: {
                    StringEquals: {
                        'iam:PassedToService': 'bedrock-agentcore.amazonaws.com'
                    }
                }
            })
        );
        tenantPolicyApplySubscriber.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'TenantPolicyApplyMcpGatewayInlinePolicy',
                effect: iam.Effect.ALLOW,
                actions: ['iam:PutRolePolicy', 'iam:GetRolePolicy'],
                resources: [`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/*MCPGatewayRole*`]
            })
        );

        cfn_nag.addCfnSuppressRules(tenantPolicyApplySubscriber, [
            {
                id: 'W89',
                reason: 'VPC deployment is not enforced for tenant policy apply subscriber.'
            },
            {
                id: 'W92',
                reason: 'The solution does not enforce reserved concurrency'
            }
        ]);

        const tenantPolicyApplyPolicy = tenantPolicyApplySubscriber.role!.node
            .tryFindChild('DefaultPolicy')!
            .node.tryFindChild('Resource')!;
        NagSuppressions.addResourceSuppressions(tenantPolicyApplyPolicy, [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'Policy apply subscriber manages AgentCore Policy engines, Cedar policies, and MCP gateway associations (wildcard ARNs).'
            }
        ]);

        new events.Rule(this, 'AiwTenantPolicyApplyRequestedRule', {
            eventBus: events.EventBus.fromEventBusName(this, 'DefaultEventBusTenantPolicyApply', 'default'),
            description: 'Route AIW workspace policy apply requests to GAAB light-apply subscriber',
            eventPattern: {
                source: ['aiw.tenant'],
                detailType: ['TenantPolicyApplyRequested']
            },
            targets: [
                new events_targets.LambdaFunction(tenantPolicyApplySubscriber, {
                    retryAttempts: 1
                })
            ]
        });

        // Create SSM parameter for Strands tools configuration
        const strandsToolsParameter = new ssm.StringParameter(this, 'StrandsToolsParameter', {
            parameterName: `/gaab/${cdk.Aws.STACK_NAME}/strands-tools`,
            stringValue: JSON.stringify([
                {
                    name: 'Calculator',
                    description: 'Perform mathematical calculations and operations',
                    value: 'calculator',
                    category: 'Math',
                    isDefault: true
                },
                {
                    name: 'Current Time',
                    description: 'Get current date and time information',
                    value: 'current_time',
                    category: 'Utilities',
                    isDefault: true
                },
                {
                    name: 'Environment',
                    description: 'Access environment variables and system information',
                    value: 'environment',
                    category: 'System',
                    isDefault: false
                }
            ]),
            description: 'Available Strands SDK tools for Agent Builder and Workflow use cases',
            simpleName: false
        });

        // Grant MCP Management Lambda permission to read Strands tools parameter and set environment variable
        strandsToolsParameter.grantRead(this.useCaseManagementSetup.useCaseManagement.mcpManagementApiLambda.role!);
        this.useCaseManagementSetup.useCaseManagement.mcpManagementApiLambda.addEnvironment(
            'STRANDS_TOOLS_SSM_PARAM',
            strandsToolsParameter.parameterName
        );

        this.applicationSetup.scheduledMetricsLambda.addEnvironment(
            REST_API_NAME_ENV_VAR,
            `${this.useCaseManagementSetup.useCaseManagement.stackName}-UseCaseManagementAPI`
        );

        // Add shared ECR cache prefix to agent management lambda
        this.useCaseManagementSetup.useCaseManagement.agentManagementApiLambda.addEnvironment(
            SHARED_ECR_CACHE_PREFIX_ENV_VAR,
            this.sharedEcrPullThroughCache.getRepositoryPrefix()
        );

        // Add shared ECR cache prefix to workflow management lambda
        this.useCaseManagementSetup.useCaseManagement.workflowManagementApiLambda.addEnvironment(
            SHARED_ECR_CACHE_PREFIX_ENV_VAR,
            this.sharedEcrPullThroughCache.getRepositoryPrefix()
        );

        const userPoolId = this.useCaseManagementSetup.userPool.userPoolId;
        const userPoolClientId = this.useCaseManagementSetup.userPoolClient.userPoolClientId;

        this.applicationSetup.addCustomDashboard(
            {
                apiName: `${this.useCaseManagementSetup.useCaseManagement.stackName}-UseCaseManagementAPI`,
                userPoolId: userPoolId,
                userPoolClientId: userPoolClientId
            },
            DashboardType.DeploymentPlatform
        );

        this.applicationSetup.createWebConfigStorage(
            {
                restApiEndpoint: this.useCaseManagementSetup.restApi.url,
                userPoolId: userPoolId,
                userPoolClientId: userPoolClientId,
                cognitoRedirectUrl: uiInfrastructureBuilder.getCloudFrontUrlWithCondition(),
                isInternalUserCondition: isInternalUserCondition,
                deployWebAppCondition: uiInfrastructureBuilder.deployWebAppCondition
            },
            webConfigSsmKey
        );
        this.applicationSetup.webConfigCustomResource.node.addDependency(this.useCaseManagementSetup.useCaseManagement);

        this.copyAssetsStack = uiInfrastructureBuilder.createUIAssetsCustomResource(this, 'CopyUICustomResource', {
            parameters: {
                CustomResourceRoleArn: this.applicationSetup.customResourceLambda.role!.roleArn,
                CustomResourceLambdaArn: this.applicationSetup.customResourceLambda.functionArn,
                WebConfigKey: webConfigSsmKey,
                WebS3BucketArn: this.uiDistribution.websiteBucket.bucketArn,
                AccessLoggingBucketArn: this.applicationSetup.accessLoggingBucket.bucketArn
            },
            description: `Custom resource that copies UI assets to S3 bucket - Version ${props.solutionVersion}`
        });

        this.uiDistribution.node.defaultChild?.node.addDependency(
            this.applicationSetup.accessLoggingBucket.node
                .tryFindChild('Policy')
                ?.node.tryFindChild('Resource') as cdk.CfnResource
        );

        this.copyAssetsStack.node.defaultChild?.node.addDependency(this.applicationSetup.webConfigCustomResource);
        this.copyAssetsStack.node.defaultChild?.node.addDependency(
            this.applicationSetup.accessLoggingBucket.node
                .tryFindChild('Policy')
                ?.node.tryFindChild('Resource') as cdk.CfnResource
        );

        if (useDistOutputBucketForUiAssets()) {
            generateSourceCodeMapping(this, props.solutionName, props.solutionVersion);
            generateSourceCodeMapping(this.uiDistribution, props.solutionName, props.solutionVersion);
            generateSourceCodeMapping(this.copyAssetsStack, props.solutionName, props.solutionVersion);
            generateSourceCodeMapping(
                this.deploymentPlatformStorageSetup.deploymentPlatformStorage,
                props.solutionName,
                props.solutionVersion
            );
        }

        const cloudfrontUrlOutput = new cdk.CfnOutput(cdk.Stack.of(this), 'CloudFrontWebUrl', {
            value: `https://${this.uiDistribution.cloudFrontDistribution.domainName}`
        });
        cloudfrontUrlOutput.condition = uiInfrastructureBuilder.deployWebAppCondition;

        const deploymentWebUiBucketOutput = new cdk.CfnOutput(cdk.Stack.of(this), 'DeploymentWebUIBucketName', {
            value: this.uiDistribution.websiteBucket.bucketName,
            description:
                'Deployment dashboard static website bucket; sync ui-deployment/build here after UI changes (see publish-deployment-ui.sh)'
        });
        deploymentWebUiBucketOutput.condition = uiInfrastructureBuilder.deployWebAppCondition;

        const deploymentWebUiDistributionOutput = new cdk.CfnOutput(cdk.Stack.of(this), 'DeploymentWebUIDistributionId', {
            value: this.uiDistribution.cloudFrontDistribution.distributionId,
            description: 'CloudFront distribution ID for the deployment dashboard (for cache invalidation after UI sync)'
        });
        deploymentWebUiDistributionOutput.condition = uiInfrastructureBuilder.deployWebAppCondition;

        new cdk.CfnOutput(cdk.Stack.of(this), 'SharedECRCachePrefix', {
            value: this.sharedEcrPullThroughCache.getRepositoryPrefix(),
            description: 'Shared ECR Pull-Through Cache repository prefix for AgentCore images'
        });

        new cdk.CfnOutput(cdk.Stack.of(this), 'CognitoClientId', {
            value: userPoolClientId
        });

        new cdk.CfnOutput(cdk.Stack.of(this), 'CognitoUserPoolId', {
            value: userPoolId
        });

        new cdk.CfnOutput(cdk.Stack.of(this), 'RestEndpointUrl', {
            value: this.useCaseManagementSetup.restApi.url
        });

        new cdk.CfnOutput(cdk.Stack.of(this), 'LLMConfigTableName', {
            value: this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCaseConfigTable.tableName
        });

        new cdk.CfnOutput(cdk.Stack.of(this), 'UseCasesTableName', {
            value: this.deploymentPlatformStorageSetup.deploymentPlatformStorage.useCasesTable.tableName
        });

        new cdk.CfnOutput(cdk.Stack.of(this), 'MultimodalDataBucketName', {
            value: this.useCaseManagementSetup.multimodalSetup.multimodalDataBucket.bucketName,
            description: 'S3 bucket for storing multimodal files'
        });

        new cdk.CfnOutput(cdk.Stack.of(this), 'MultimodalDataMetadataTable', {
            value: this.useCaseManagementSetup.multimodalSetup.multimodalDataMetadataTable.tableName,
            description: 'DynamoDB table for storing multimodal files metadata'
        });

        this.applicationSetup.addMetricsCustomLambda(props.solutionID, props.solutionVersion, {
            UUID: uuid,
            VPC_ENABLED: this.vpcEnabled.valueAsString,
            CREATE_VPC: this.createNewVpc.valueAsString
        });
    }
    protected initializeCfnParameters(): void {
        this.stackParameters = new DeploymentPlatformParameters(this);
    }
    protected setupVPC(): VPCSetup {
        return new VPCSetup(this, 'VPC', {
            stackType: 'deployment-platform',
            deployVpcCondition: this.deployVpcCondition,
            customResourceLambdaArn: this.applicationSetup.customResourceLambda.functionArn,
            customResourceRoleArn: this.applicationSetup.customResourceLambda.role!.roleArn,
            iPamPoolId: this.iPamPoolId.valueAsString,
            accessLogBucket: this.applicationSetup.accessLoggingBucket,
            ...this.baseStackProps
        });
    }

    protected createApplicationSetup(props: BaseStackProps): ApplicationSetup {
        return new ApplicationSetup(this, 'DeploymentPlatformSetup', {
            solutionID: props.solutionID,
            solutionVersion: props.solutionVersion
        });
    }
}
