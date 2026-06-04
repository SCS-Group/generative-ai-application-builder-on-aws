// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const USE_CASES_TABLE_NAME = process.env.USE_CASES_TABLE_NAME || "";

function bad(code: number, message: string): APIGatewayProxyResult {
  return { statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) };
}

function ok(body: unknown): APIGatewayProxyResult {
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function ymOrCurrent(raw: string | undefined): string {
  const trimmed = (raw || "").trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return trimmed;
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const useCaseId = event.pathParameters?.useCaseId?.trim() || "";
  const tenantId = (event.queryStringParameters?.tenantId || "").trim();
  const month = ymOrCurrent(event.queryStringParameters?.month);

  if (!USE_CASES_TABLE_NAME) return bad(500, "USE_CASES_TABLE_NAME is not configured");
  if (!useCaseId) return bad(400, "useCaseId is required");
  if (!tenantId) return bad(400, "tenantId is required");

  const useCaseShortId = useCaseId.split("-")[0];
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  // Resolve the stack ARN/id from UseCases table (same backing as /deployments details).
  const useCaseRow = await ddb.send(
    new GetCommand({
      TableName: USE_CASES_TABLE_NAME,
      Key: { UseCaseId: useCaseId },
    }),
  );
  const stackId = (useCaseRow.Item as any)?.StackId?.trim?.() || (useCaseRow.Item as any)?.StackId || "";
  if (!stackId) return bad(404, "Use case not found or missing StackId");

  // Describe stack outputs to find UsageMeteringTableName.
  const cfn = new CloudFormationClient({});
  const stacks = await cfn.send(new DescribeStacksCommand({ StackName: stackId }));
  const outputs = stacks.Stacks?.[0]?.Outputs || [];
  const usageTableName =
    outputs.find((o) => (o.OutputKey || "").toLowerCase().includes("usagemeteringtablename"))?.OutputValue || "";
  if (!usageTableName) return bad(404, "Usage metering table not found in stack outputs");

  const pk = `TENANT#${tenantId}`;
  const skPrefix = `MONTH#${month}#UC#${useCaseShortId}#MODEL#`;

  const out = await ddb.send(
    new QueryCommand({
      TableName: usageTableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": pk,
        ":sk": skPrefix,
      },
    }),
  );

  const items = (out.Items || []).map((it) => ({
    month: (it as any).Month || month,
    tenantId: (it as any).TenantId || tenantId,
    useCaseShortId: (it as any).UseCaseShortId || useCaseShortId,
    modelId: (it as any).ModelId || "",
    requestCount: Number((it as any).RequestCount || 0),
    inputTokens: Number((it as any).InputTokens || 0),
    outputTokens: Number((it as any).OutputTokens || 0),
    totalTokens: Number((it as any).TotalTokens || 0),
    toolEventCount: Number((it as any).ToolEventCount || 0),
  }));

  return ok({ month, tenantId, useCaseId, usageTableName, aggregates: items });
};

