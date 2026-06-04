"use strict";
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitTenantProvisionStatus = emitTenantProvisionStatus;
const client_eventbridge_1 = require("@aws-sdk/client-eventbridge");
const aws_node_user_agent_config_1 = require("aws-node-user-agent-config");
const constants_1 = require("./utils/constants");
const eb = new client_eventbridge_1.EventBridgeClient((0, aws_node_user_agent_config_1.customAwsConfig)());
async function emitTenantProvisionStatus(detail) {
    var _a, _b;
    const instanceId = (_a = detail.tenantTemplateInstanceId) === null || _a === void 0 ? void 0 : _a.trim();
    if (!instanceId) {
        return;
    }
    const bus = (_b = process.env[constants_1.EVENT_BUS_NAME_ENV_VAR]) !== null && _b !== void 0 ? _b : 'default';
    await eb.send(new client_eventbridge_1.PutEventsCommand({
        Entries: [
            {
                EventBusName: bus,
                Source: 'gaab.tenant',
                DetailType: 'TenantProvisionStatus',
                Detail: JSON.stringify({
                    version: '1',
                    tenantTemplateInstanceId: instanceId,
                    phase: detail.phase,
                    ...(detail.message ? { message: detail.message } : {}),
                    ...(detail.gaabUseCaseId ? { gaabUseCaseId: detail.gaabUseCaseId } : {}),
                    ...(detail.gaabMcpGatewayUseCaseId
                        ? { gaabMcpGatewayUseCaseId: detail.gaabMcpGatewayUseCaseId }
                        : {}),
                    ...(detail.runtimeUiUrl ? { runtimeUiUrl: detail.runtimeUiUrl } : {})
                })
            }
        ]
    }));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW1pdC1wcm92aXNpb24tc3RhdHVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZW1pdC1wcm92aXNpb24tc3RhdHVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSxxRUFBcUU7QUFDckUsc0NBQXNDOztBQVV0Qyw4REFvQ0M7QUE1Q0Qsb0VBQWtGO0FBQ2xGLDJFQUE2RDtBQUM3RCxpREFBMkQ7QUFFM0QsTUFBTSxFQUFFLEdBQUcsSUFBSSxzQ0FBaUIsQ0FBQyxJQUFBLDRDQUFlLEdBQUUsQ0FBQyxDQUFDO0FBSTdDLEtBQUssVUFBVSx5QkFBeUIsQ0FBQyxNQU8vQzs7SUFDRyxNQUFNLFVBQVUsR0FBRyxNQUFBLE1BQU0sQ0FBQyx3QkFBd0IsMENBQUUsSUFBSSxFQUFFLENBQUM7SUFDM0QsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1FBQ2QsT0FBTztJQUNYLENBQUM7SUFDRCxNQUFNLEdBQUcsR0FBRyxNQUFBLE9BQU8sQ0FBQyxHQUFHLENBQUMsa0NBQXNCLENBQUMsbUNBQUksU0FBUyxDQUFDO0lBRTdELE1BQU0sRUFBRSxDQUFDLElBQUksQ0FDVCxJQUFJLHFDQUFnQixDQUFDO1FBQ2pCLE9BQU8sRUFBRTtZQUNMO2dCQUNJLFlBQVksRUFBRSxHQUFHO2dCQUNqQixNQUFNLEVBQUUsYUFBYTtnQkFDckIsVUFBVSxFQUFFLHVCQUF1QjtnQkFDbkMsTUFBTSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7b0JBQ25CLE9BQU8sRUFBRSxHQUFHO29CQUNaLHdCQUF3QixFQUFFLFVBQVU7b0JBQ3BDLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSztvQkFDbkIsR0FBRyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO29CQUN0RCxHQUFHLENBQUMsTUFBTSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxhQUFhLEVBQUUsTUFBTSxDQUFDLGFBQWEsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7b0JBQ3hFLEdBQUcsQ0FBQyxNQUFNLENBQUMsdUJBQXVCO3dCQUM5QixDQUFDLENBQUMsRUFBRSx1QkFBdUIsRUFBRSxNQUFNLENBQUMsdUJBQXVCLEVBQUU7d0JBQzdELENBQUMsQ0FBQyxFQUFFLENBQUM7b0JBQ1QsR0FBRyxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxFQUFFLE1BQU0sQ0FBQyxZQUFZLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2lCQUN4RSxDQUFDO2FBQ0w7U0FDSjtLQUNKLENBQUMsQ0FDTCxDQUFDO0FBQ04sQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCBBbWF6b24uY29tLCBJbmMuIG9yIGl0cyBhZmZpbGlhdGVzLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuLy8gU1BEWC1MaWNlbnNlLUlkZW50aWZpZXI6IEFwYWNoZS0yLjBcblxuaW1wb3J0IHsgRXZlbnRCcmlkZ2VDbGllbnQsIFB1dEV2ZW50c0NvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZXZlbnRicmlkZ2UnO1xuaW1wb3J0IHsgY3VzdG9tQXdzQ29uZmlnIH0gZnJvbSAnYXdzLW5vZGUtdXNlci1hZ2VudC1jb25maWcnO1xuaW1wb3J0IHsgRVZFTlRfQlVTX05BTUVfRU5WX1ZBUiB9IGZyb20gJy4vdXRpbHMvY29uc3RhbnRzJztcblxuY29uc3QgZWIgPSBuZXcgRXZlbnRCcmlkZ2VDbGllbnQoY3VzdG9tQXdzQ29uZmlnKCkpO1xuXG5leHBvcnQgdHlwZSBQcm92aXNpb25TdGF0dXNQaGFzZSA9ICdwcm92aXNpb25pbmdfc3RhcnRlZCcgfCAnc3RhY2tfY29tcGxldGUnIHwgJ3J1bnRpbWVfcmVhZHknIHwgJ2ZhaWxlZCc7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBlbWl0VGVuYW50UHJvdmlzaW9uU3RhdHVzKGRldGFpbDoge1xuICAgIHRlbmFudFRlbXBsYXRlSW5zdGFuY2VJZDogc3RyaW5nO1xuICAgIHBoYXNlOiBQcm92aXNpb25TdGF0dXNQaGFzZTtcbiAgICBtZXNzYWdlPzogc3RyaW5nO1xuICAgIGdhYWJVc2VDYXNlSWQ/OiBzdHJpbmc7XG4gICAgZ2FhYk1jcEdhdGV3YXlVc2VDYXNlSWQ/OiBzdHJpbmc7XG4gICAgcnVudGltZVVpVXJsPzogc3RyaW5nO1xufSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGluc3RhbmNlSWQgPSBkZXRhaWwudGVuYW50VGVtcGxhdGVJbnN0YW5jZUlkPy50cmltKCk7XG4gICAgaWYgKCFpbnN0YW5jZUlkKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgYnVzID0gcHJvY2Vzcy5lbnZbRVZFTlRfQlVTX05BTUVfRU5WX1ZBUl0gPz8gJ2RlZmF1bHQnO1xuXG4gICAgYXdhaXQgZWIuc2VuZChcbiAgICAgICAgbmV3IFB1dEV2ZW50c0NvbW1hbmQoe1xuICAgICAgICAgICAgRW50cmllczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgRXZlbnRCdXNOYW1lOiBidXMsXG4gICAgICAgICAgICAgICAgICAgIFNvdXJjZTogJ2dhYWIudGVuYW50JyxcbiAgICAgICAgICAgICAgICAgICAgRGV0YWlsVHlwZTogJ1RlbmFudFByb3Zpc2lvblN0YXR1cycsXG4gICAgICAgICAgICAgICAgICAgIERldGFpbDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgICAgICAgICAgdmVyc2lvbjogJzEnLFxuICAgICAgICAgICAgICAgICAgICAgICAgdGVuYW50VGVtcGxhdGVJbnN0YW5jZUlkOiBpbnN0YW5jZUlkLFxuICAgICAgICAgICAgICAgICAgICAgICAgcGhhc2U6IGRldGFpbC5waGFzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIC4uLihkZXRhaWwubWVzc2FnZSA/IHsgbWVzc2FnZTogZGV0YWlsLm1lc3NhZ2UgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgIC4uLihkZXRhaWwuZ2FhYlVzZUNhc2VJZCA/IHsgZ2FhYlVzZUNhc2VJZDogZGV0YWlsLmdhYWJVc2VDYXNlSWQgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgIC4uLihkZXRhaWwuZ2FhYk1jcEdhdGV3YXlVc2VDYXNlSWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IHsgZ2FhYk1jcEdhdGV3YXlVc2VDYXNlSWQ6IGRldGFpbC5nYWFiTWNwR2F0ZXdheVVzZUNhc2VJZCB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAuLi4oZGV0YWlsLnJ1bnRpbWVVaVVybCA/IHsgcnVudGltZVVpVXJsOiBkZXRhaWwucnVudGltZVVpVXJsIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdXG4gICAgICAgIH0pXG4gICAgKTtcbn1cbiJdfQ==