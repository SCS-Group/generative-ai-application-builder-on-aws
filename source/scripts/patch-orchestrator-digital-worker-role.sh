#!/usr/bin/env bash
# Patch published Workflow Orchestrator templates with digitalWorkerRole and re-emit TemplatePublished for AIW.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
TABLE="${GAAB_AGENT_TEMPLATES_TABLE:-DeploymentPlatformStack-DeploymentPlatformStorageDeploymentPlatformStorageNestedStackD-1KQN4QYP7R9AI-AgentTemplatesTable6CA18725-K7R3VWGADDAA}"
BUS="${GAAB_EVENT_BUS_NAME:-default}"

export REGION TABLE BUS
python3 <<'PY'
import json
import os
import subprocess
from datetime import datetime, timezone

REGION = os.environ["REGION"]
TABLE = os.environ["TABLE"]
BUS = os.environ["BUS"]

PATCHES = [
    ("9b20dbd7-24e7-41de-ae33-fd8cd2fc7de5", "portfolio_manager"),
    ("c60a0304-027a-4b28-b78a-c008d2afe1a4", "portfolio_manager"),
    ("a59056d0-56a6-4cce-8ac5-2f53bf814e0e", "marketing_manager"),
]


def aws(*args):
    return subprocess.check_output(["aws", *args, "--region", REGION], text=True)


for template_id, role in PATCHES:
    item = json.loads(
        aws(
            "dynamodb",
            "get-item",
            "--table-name",
            TABLE,
            "--key",
            json.dumps({"TemplateId": {"S": template_id}}),
            "--output",
            "json",
        )
    )
    cur = item.get("Item")
    if not cur:
        print(f"SKIP missing {template_id}")
        continue
    slug = cur["Slug"]["S"]
    marketing = json.loads(cur["Marketing"]["S"])
    devops = json.loads(cur["Devops"]["S"])
    gaab = devops.setdefault("gaab", {})
    orch = gaab.setdefault("orchestrator", {})
    if orch.get("digitalWorkerRole") == role:
        print(f"SKIP {slug} already has {role}")
    else:
        orch["digitalWorkerRole"] = role
        now = datetime.now(timezone.utc).isoformat()
        aws(
            "dynamodb",
            "update-item",
            "--table-name",
            TABLE,
            "--key",
            json.dumps({"TemplateId": {"S": template_id}}),
            "--update-expression",
            "SET Devops = :d, UpdatedAt = :u",
            "--expression-attribute-values",
            json.dumps({":d": {"S": json.dumps(devops)}, ":u": {"S": now}}),
        )
        print(f"Patched GAAB {slug} → {role}")

    now = datetime.now(timezone.utc).isoformat()
    detail = {
        "gaabTemplateId": template_id,
        "slug": slug,
        "schemaVersion": "0.1.0",
        "publishedAt": now,
        "publishedBy": "patch-orchestrator-digital-worker-role",
        "marketing": marketing,
        "devops": devops,
        "source": {"system": "gaab", "gaabTemplateId": template_id},
    }
    aws(
        "events",
        "put-events",
        "--entries",
        json.dumps(
            [
                {
                    "EventBusName": BUS,
                    "Source": "gaab.templates",
                    "DetailType": "TemplatePublished",
                    "Detail": json.dumps(detail),
                }
            ]
        ),
    )
    print(f"Emitted TemplatePublished for {slug}")

print("Done.")
PY
