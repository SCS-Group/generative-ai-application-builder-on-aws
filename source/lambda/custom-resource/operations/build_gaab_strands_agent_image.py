# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import time
import uuid

import boto3
from botocore.exceptions import ClientError
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

BUILD_GAAB_STRANDS_AGENT_IMAGE = operation_types.BUILD_GAAB_STRANDS_AGENT_IMAGE
AGENT_IMAGE_NAME = "gaab-strands-agent"
WORKFLOW_IMAGE_NAME = "gaab-strands-workflow-agent"
GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM = "/gaab-deployment-platform/GaabStrandsAgentImageUri"
GAAB_STRANDS_WORKFLOW_IMAGE_URI_SSM_PARAM = "/gaab-deployment-platform/GaabStrandsWorkflowAgentImageUri"
ORCHESTRATOR_PROVISION_SUBSCRIBER_FUNCTION_SSM_PARAM = (
    "/gaab-deployment-platform/OrchestratorProvisionSubscriberFunction"
)
POLL_SECONDS = 15
MAX_WAIT_SECONDS = 45 * 60


def _publish_image_uri_to_ssm(ssm_client, param_name: str, image_uri: str, description: str) -> None:
    ssm_client.put_parameter(
        Name=param_name,
        Value=image_uri,
        Type="String",
        Overwrite=True,
        Description=description,
    )
    logger.info("Published container image URI to SSM", extra={"param": param_name, "uri": image_uri})


def _load_ssm_param(ssm_client, param_name: str) -> str | None:
    try:
        resp = ssm_client.get_parameter(Name=param_name)
        value = (resp.get("Parameter") or {}).get("Value")
        return value.strip() if isinstance(value, str) and value.strip() else None
    except ClientError as ex:
        if ex.response.get("Error", {}).get("Code") == "ParameterNotFound":
            return None
        logger.warning(
            "Could not load SSM parameter for workflow runtime sync",
            extra={"param": param_name, "error": str(ex)},
        )
        return None
    except Exception as ex:
        logger.warning(
            "Could not load SSM parameter for workflow runtime sync",
            extra={"param": param_name, "error": str(ex)},
        )
        return None


def _invoke_sync_all_workflow_runtimes(lambda_client, function_name: str, image_tag: str) -> None:
    payload = {
        "source": "gaab.platform",
        "detail-type": "SyncAllWorkflowRuntimes",
        "detail": {
            "trigger": "platform-image-build",
            "imageBuildVersion": image_tag,
        },
    }
    logger.info(
        "Invoking orchestrator subscriber to sync all workflow runtimes",
        extra={"function": function_name, "imageBuildVersion": image_tag},
    )
    lambda_client.invoke(
        FunctionName=function_name,
        InvocationType="Event",
        Payload=json.dumps(payload).encode("utf-8"),
    )


@tracer.capture_method
def verify_properties(event):
    if event[RESOURCE_PROPERTIES][RESOURCE] != BUILD_GAAB_STRANDS_AGENT_IMAGE:
        err = (
            f"Expected Resource={BUILD_GAAB_STRANDS_AGENT_IMAGE}, "
            f"got {event[RESOURCE_PROPERTIES].get(RESOURCE)}"
        )
        logger.error(f"{err}. Properties: {json.dumps(event[RESOURCE_PROPERTIES])}")
        raise ValueError(err)
    for key in ("ProjectName", "ImageTag", "EcrRepositoryPrefix"):
        if not event[RESOURCE_PROPERTIES].get(key):
            raise ValueError(f"Missing required property: {key}")


def _wait_for_build(codebuild, build_id: str) -> None:
    deadline = time.time() + MAX_WAIT_SECONDS
    while time.time() < deadline:
        resp = codebuild.batch_get_builds(ids=[build_id])
        builds = resp.get("builds") or []
        if not builds:
            time.sleep(POLL_SECONDS)
            continue
        status = builds[0].get("buildStatus")
        if status == "SUCCEEDED":
            return
        if status in ("FAILED", "FAULT", "STOPPED", "TIMED_OUT"):
            msg = builds[0].get("buildStatusMessage") or "no message"
            raise RuntimeError(f"CodeBuild {build_id} failed: {status} — {msg}")
        time.sleep(POLL_SECONDS)
    raise TimeoutError(f"CodeBuild {build_id} did not finish within {MAX_WAIT_SECONDS}s")


@tracer.capture_method
def execute(event, context):
    physical_resource_id = event.get(PHYSICAL_RESOURCE_ID, uuid.uuid4().hex[:12])

    try:
        verify_properties(event)
        props = event[RESOURCE_PROPERTIES]
        project_name = props["ProjectName"]
        image_tag = props["ImageTag"]
        ecr_prefix = props["EcrRepositoryPrefix"]
        region = os.environ.get("AWS_REGION", "us-east-1")
        account = boto3.client("sts").get_caller_identity()["Account"]
        image_uri = f"{account}.dkr.ecr.{region}.amazonaws.com/{ecr_prefix}/{AGENT_IMAGE_NAME}:{image_tag}"
        workflow_image_uri = (
            f"{account}.dkr.ecr.{region}.amazonaws.com/{ecr_prefix}/{WORKFLOW_IMAGE_NAME}:{image_tag}"
        )

        if event.get("RequestType") == "Delete":
            send_response(
                event,
                context,
                SUCCESS,
                {"ImageUri": image_uri, "WorkflowImageUri": workflow_image_uri},
                physical_resource_id=physical_resource_id,
            )
            return

        codebuild = boto3.client("codebuild", region_name=region)
        logger.info(
            "Starting gaab-strands-agent and gaab-strands-workflow-agent CodeBuild",
            extra={"project": project_name, "tag": image_tag, "prefix": ecr_prefix},
        )

        start = codebuild.start_build(
            projectName=project_name,
            environmentVariablesOverride=[
                {"name": "IMAGE_TAG", "value": image_tag, "type": "PLAINTEXT"},
                {"name": "ECR_REPOSITORY_PREFIX", "value": ecr_prefix, "type": "PLAINTEXT"},
            ],
        )
        build_id = start.get("build", {}).get("id")
        if not build_id:
            raise RuntimeError("CodeBuild start_build did not return a build id")

        _wait_for_build(codebuild, build_id)
        ssm_client = boto3.client("ssm", region_name=region)
        _publish_image_uri_to_ssm(
            ssm_client,
            GAAB_STRANDS_AGENT_IMAGE_URI_SSM_PARAM,
            image_uri,
            "gaab-strands-agent ECR URI built by DeploymentPlatformStack CodeBuild",
        )
        _publish_image_uri_to_ssm(
            ssm_client,
            GAAB_STRANDS_WORKFLOW_IMAGE_URI_SSM_PARAM,
            workflow_image_uri,
            "gaab-strands-workflow-agent ECR URI built by DeploymentPlatformStack CodeBuild",
        )

        orchestrator_fn = _load_ssm_param(ssm_client, ORCHESTRATOR_PROVISION_SUBSCRIBER_FUNCTION_SSM_PARAM)
        if orchestrator_fn:
            try:
                _invoke_sync_all_workflow_runtimes(
                    boto3.client("lambda", region_name=region), orchestrator_fn, image_tag
                )
            except Exception as ex:
                logger.warning(
                    "Workflow runtime sync invoke failed after image build; image publish still succeeded",
                    extra={"function": orchestrator_fn, "error": str(ex)},
                )
        else:
            logger.info(
                "Skipping workflow runtime sync — orchestrator subscriber SSM param not set yet",
                extra={"param": ORCHESTRATOR_PROVISION_SUBSCRIBER_FUNCTION_SSM_PARAM},
            )

        physical_resource_id = f"gaab-strands-agent-image-{image_tag}"

        send_response(
            event,
            context,
            SUCCESS,
            {"ImageUri": image_uri, "WorkflowImageUri": workflow_image_uri, "BuildId": build_id},
            physical_resource_id=physical_resource_id,
        )
    except Exception as ex:
        logger.error(f"Agent image CodeBuild failed: {ex}")
        send_response(event, context, FAILED, {}, physical_resource_id=physical_resource_id, reason=str(ex))
