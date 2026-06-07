#!/usr/bin/env bash
# Build + push gaab-strands-agent to ECR, then optionally sync a workspace runtime from SSM image URI.
#
# Usage:
#   ./scripts/deploy-platform-agent.sh                    # build + push only
#   AGENT_USE_CASE_ID=5c87d3f4-c05e-486f-b345-3b49179c13c2 ./scripts/deploy-platform-agent.sh
#
# Prerequisites: Docker, uv, AWS credentials, ECR repo deploymentplatformstack/gaab-strands-agent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SRC="$(cd "$AGENT_DIR/../gaab-strands-common" && pwd)"
COMMON_COPY="$AGENT_DIR/gaab-strands-common"
GAAB_ROOT="$(cd "$AGENT_DIR/../../.." && pwd)"

IMAGE_TAG="${IMAGE_TAG:-v4.1.9-platform}"
PLATFORM="${PLATFORM:-linux/arm64}"
ECR_REPOSITORY="${ECR_REPOSITORY:-deploymentplatformstack/gaab-strands-agent}"

log() { echo "==> $*"; }

if [ -z "${AWS_ACCOUNT_ID:-}" ]; then
  AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  if [ -n "$AWS_ACCOUNT_ID" ]; then
    export AWS_ACCOUNT_ID
  fi
fi

log "Sync gaab-strands-common into agent build context"
rsync -a --delete "$COMMON_SRC/" "$COMMON_COPY/"

export PLATFORM IMAGE_TAG
if [ -z "${DOCKER_HOST:-}" ]; then
  if docker info &>/dev/null; then
    DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
    if [ -n "$DOCKER_HOST" ]; then
      export DOCKER_HOST
    fi
  elif [ -S /var/run/docker.sock ]; then
    export DOCKER_HOST="unix:///var/run/docker.sock"
  fi
fi
log "Build image ($PLATFORM)"
"$SCRIPT_DIR/build-container.sh"

export ECR_REPOSITORY IMAGE_NAME=gaab-strands-agent IMAGE_TAG
log "Push to ECR ($IMAGE_TAG)"
"$SCRIPT_DIR/deploy-ecr.sh"

if [ -n "${AGENT_USE_CASE_ID:-}" ]; then
  SYNC="$GAAB_ROOT/source/scripts/sync-runtime-platform-env.sh"
  if [ ! -x "$SYNC" ]; then
    echo "WARN: $SYNC not found; skip runtime sync. Set AGENT_USE_CASE_ID after push to sync manually." >&2
    exit 0
  fi
  REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
  export AGENT_USE_CASE_ID
  export AGENT_IMAGE_URI="${AGENT_IMAGE_URI:-${AWS_ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPOSITORY}:${IMAGE_TAG}}"
  log "Sync runtime gaab_agent_${AGENT_USE_CASE_ID%%-*} to $AGENT_IMAGE_URI"
  bash "$SYNC"
fi

log "Done. Image tag: $IMAGE_TAG"
