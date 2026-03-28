#!/usr/bin/env bash
# Mirrors .github/workflows/ci.yml so you can validate before/without pushing.
# Usage: from repo root: bash source/scripts/verify-ci-parity.sh
#    or: cd source && bash scripts/verify-ci-parity.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> CDK infrastructure (build, unit-test, synth)"
cd source/infrastructure
export SKIP_ECR_PREBUILD=1
npm ci
npm run build
npm run unit-test
npx cdk synth

echo "==> UI deployment dashboard (build)"
cd "$ROOT/source/ui-deployment"
npm ci
npm run build

echo "==> UI chat (build)"
cd "$ROOT/source/ui-chat"
npm ci
npm run build

echo "All CI parity checks passed."
