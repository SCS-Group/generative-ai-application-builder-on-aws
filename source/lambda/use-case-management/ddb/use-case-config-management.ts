// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
    DeleteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    UpdateItemCommand
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { AWSClientManager } from 'aws-sdk-lib';
import { UseCaseRecord } from '../model/list-use-cases';
import { BaseUseCaseConfiguration } from '../model/types';
import { UseCase } from '../model/use-case';
import { logger, tracer } from '../power-tools-init';
import {
    DeleteConfigItemBuilder,
    GetConfigItemBuilder,
    MarkConfigItemForDeletionCommandBuilder,
    MarkItemForDeletionCommandBuilder,
    PutConfigItemBuilder
} from './use-case-config-operation-builder';
import { GetItemCommandInputBuilder } from './use-case-config-view-builder';

export class UseCaseConfigManagement {
    private client: DynamoDBClient;

    constructor() {
        this.client = AWSClientManager.getServiceClient<DynamoDBClient>('dynamodb', tracer);
    }

    /**
     * Creates a record in the DynamoDB table which stores the configuration of the passed useCase
     *
     * @param useCase the useCase for which this record is being created
     */
    @tracer.captureMethod({ captureResponse: true, subSegmentName: '###createUseCaseConfig' })
    public async createUseCaseConfig(useCase: UseCase): Promise<void> {
        try {
            const input = await new PutConfigItemBuilder(useCase).build();
            logger.debug(JSON.stringify(input));
            await this.client.send(new PutItemCommand(input));
        } catch (error) {
            logger.error(`Failed to create use case config record in DDB: Error: ${error}`);
        }
    }

    /**
     * Retrieves a config DynamoDB record based on the value of the key for the passed useCase object
     *
     * @param useCase the useCase which holds the key which helps retrieve the config
     * @returns The config object
     */
    @tracer.captureMethod({ captureResponse: true, subSegmentName: '###getUseCaseConfigFromTable' })
    public async getUseCaseConfigFromTable(useCase: UseCase): Promise<any> {
        const input = await new GetConfigItemBuilder(useCase).build(); //NOSONAR - without await, input is empty
        try {
            const response = await this.client.send(new GetItemCommand(input));

            if (response.Item === undefined) {
                logger.error(
                    `No use case config found for the key: ${useCase.getUseCaseConfigRecordKey()} in the table}`
                );
                throw new Error('No use case config found for the specified key.');
            }
            const unmarshalledConfig = unmarshall(response.Item).config;
            return unmarshalledConfig as BaseUseCaseConfiguration;
        } catch (error) {
            const errMessage = `Failed to get config: ${error}`;
            logger.error(errMessage);
            throw error;
        }
    }

    /**
     * Method to delete the DynamoDb record which holds the old configuration of the deployed use case
     *
     * @param useCase
     */
    @tracer.captureMethod({ captureResponse: true, subSegmentName: '###deleteUseCaseConfig' })
    public async deleteUseCaseConfig(useCase: UseCase): Promise<void> {
        const input = await new DeleteConfigItemBuilder(useCase).build(); //NOSONAR - without await, input is empty
        try {
            await this.client.send(new DeleteItemCommand(input));
        } catch (error) {
            const errMessage = `Failed to delete Use Case Config: ${error}`;
            logger.error(errMessage);
            throw error;
        }
    }

    /**
     * Method to update an the DynamoDb config table to hold the updated configuration for the deployed use case
     *
     * @param useCase updated use case which is expected to have a validated configuration to be saved in DynamoDb
     */
    @tracer.captureMethod({ captureResponse: true, subSegmentName: '###updateUseCaseConfig' })
    public async updateUseCaseConfig(useCase: UseCase, oldDynamoDbRecordKey: string): Promise<void> {
        // Add the new config to DynamoDb
        const response = await this.createUseCaseConfig(useCase);

        // Set TTL on the old config instead of deleting it
        let existingConfigUseCase = useCase.clone();
        existingConfigUseCase.setUseCaseConfigRecordKey(oldDynamoDbRecordKey);
        await this.markUseCaseConfigForDeletion(existingConfigUseCase);

        return response;
    }

    /**
     * Method to retrieve use case config record from ddb, using use case record from deployments table
     * @param useCaseRecordInput
     * @returns
     */
    @tracer.captureMethod({ captureResponse: true, subSegmentName: '###getUseCaseConfig' })
    public async getUseCaseConfigFromRecord(useCaseRecordInput: UseCaseRecord): Promise<BaseUseCaseConfiguration> {
        try {
            const input = await new GetItemCommandInputBuilder(useCaseRecordInput).build();
            const response = await this.client.send(new GetItemCommand(input));
            const unmarshalledConfig = unmarshall(response.Item!);
            return unmarshalledConfig.config;
        } catch (error) {
            logger.error(`Failed to get use case config record from DDB: Error: ${error}`);
            throw error;
        }
    }

    /**
     * Method for setting the TTL of a use case config in the use case config table
     *
     * @param useCase
     */
    @tracer.captureMethod({ captureResponse: false, subSegmentName: '###markUseCaseConfigForDeletion' })
    public async markUseCaseConfigForDeletion(useCase: UseCase): Promise<void> {
        const input = await new MarkConfigItemForDeletionCommandBuilder(useCase).build(); //NOSONAR - without await, input is empty
        try {
            await this.client.send(new UpdateItemCommand(input));
        } catch (error) {
            const errMessage = `Failed to update Use Case Config Record: ${error}`;
            logger.error(errMessage);
            throw error;
        }
    }

    /**
     * Clears outbound MCP server references from use case config before agent stack delete.
     * Prevents AgentCoreOutboundPermissions from calling UpdateGateway on a gateway being torn down.
     */
    @tracer.captureMethod({ captureResponse: false, subSegmentName: '###detachOutboundMcpServerRefs' })
    public async detachOutboundMcpServerRefs(useCase: UseCase): Promise<void> {
        let config: BaseUseCaseConfiguration;
        try {
            config = await this.getUseCaseConfigFromTable(useCase);
        } catch (error) {
            logger.warn(`Skipping MCP detach — no config for ${useCase.getUseCaseConfigRecordKey()}: ${error}`);
            return;
        }

        const configRecord = config as BaseUseCaseConfiguration & {
            AgentBuilderParams?: { MCPServers?: unknown };
            WorkflowParams?: {
                AgentsAsToolsParams?: {
                    Agents?: Array<{ AgentBuilderParams?: { MCPServers?: unknown } }>;
                };
            };
        };

        let changed = false;
        const agentBuilder = configRecord.AgentBuilderParams;
        if (agentBuilder?.MCPServers) {
            delete agentBuilder.MCPServers;
            changed = true;
        }

        const workflowParams = configRecord.WorkflowParams;
        const agentsAsTools = workflowParams?.AgentsAsToolsParams as Record<string, unknown> | undefined;
        const agents = agentsAsTools?.Agents;
        if (Array.isArray(agents)) {
            for (const agent of agents) {
                const ab = (agent as Record<string, unknown>)?.AgentBuilderParams as
                    | Record<string, unknown>
                    | undefined;
                if (ab?.MCPServers) {
                    delete ab.MCPServers;
                    changed = true;
                }
            }
        }

        if (!changed) {
            return;
        }

        useCase.configuration = configRecord;
        const input = await new PutConfigItemBuilder(useCase).build();
        await this.client.send(new PutItemCommand(input));
        logger.info(`Detached outbound MCP server refs for config key ${useCase.getUseCaseConfigRecordKey()}`);
    }

    /**
     * Method for setting the TTL of a use case in the use cases table
     *
     * @param useCase
     */
    @tracer.captureMethod({ captureResponse: false, subSegmentName: '###markUseCaseRecordForDeletion' })
    public async markUseCaseRecordForDeletion(useCase: UseCase): Promise<void> {
        const input = await new MarkItemForDeletionCommandBuilder(useCase).build(); //NOSONAR - without await, input is empty
        try {
            await this.client.send(new UpdateItemCommand(input));
        } catch (error) {
            const errMessage = `Failed to update Use Case Record: ${error}`;
            logger.error(errMessage);
            throw error;
        }
    }
}
