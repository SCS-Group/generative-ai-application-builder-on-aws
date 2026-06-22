# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import uuid

import boto3
from aws_lambda_powertools import Logger, Tracer
from cfn_response import send_response
from operations import operation_types
from operations.operation_types import (
    FAILED,
    PHYSICAL_RESOURCE_ID,
    RESOURCE,
    RESOURCE_PROPERTIES,
    SUCCESS,
)

logger = Logger(utc=True)
tracer = Tracer()

SYNC_ALL_WORKFLOW_RUNTIMES = operation_types.SYNC_ALL_WORKFLOW_RUNTIMES


def verify_properties(event):
    if event[RESOURCE_PROPERTIES][RESOURCE] != SYNC_ALL_WORKFLOW_RUNTIMES:
        raise ValueError(
            f"Expected Resource={SYNC_ALL_WORKFLOW_RUNTIMES}, "
            f"got {event[RESOURCE_PROPERTIES].get(RESOURCE)}"
        )
    fn = event[RESOURCE_PROPERTIES].get("OrchestratorSubscriberFunction")
    if not fn or not str(fn).strip():
        raise ValueError("Missing required property: OrchestratorSubscriberFunction")


@tracer.capture_method
def execute(event, context):
    physical_resource_id = event.get(PHYSICAL_RESOURCE_ID, uuid.uuid4().hex[:12])

    try:
        verify_properties(event)
        props = event[RESOURCE_PROPERTIES]

        if event.get("RequestType") == "Delete":
            send_response(event, context, SUCCESS, {}, physical_resource_id=physical_resource_id)
            return

        function_name = str(props["OrchestratorSubscriberFunction"]).strip()
        image_build_version = str(props.get("ImageBuildVersion", "")).strip()
        lambda_client = boto3.client("lambda")

        payload = {
            "source": "gaab.platform",
            "detail-type": "SyncAllWorkflowRuntimes",
            "detail": {
                "trigger": "platform-deploy",
                "imageBuildVersion": image_build_version,
            },
        }

        logger.info(
            "Invoking orchestrator subscriber to sync all workflow runtimes",
            extra={"function": function_name, "imageBuildVersion": image_build_version},
        )

        lambda_client.invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps(payload).encode("utf-8"),
        )

        physical_resource_id = f"sync-workflow-runtimes-{image_build_version or uuid.uuid4().hex[:8]}"
        send_response(
            event,
            context,
            SUCCESS,
            {"InvokedFunction": function_name, "ImageBuildVersion": image_build_version},
            physical_resource_id=physical_resource_id,
        )
    except Exception as ex:
        logger.error(f"SyncAllWorkflowRuntimes invoke failed: {ex}")
        send_response(event, context, FAILED, {}, physical_resource_id=physical_resource_id, reason=str(ex))
