# CI and deployment (fork operators)

This fork adds **GitHub Actions** for continuous integration. The upstream README still describes the canonical **local** flow (`cdk deploy`, `stage-assets.sh`). Use both: CI proves builds on every PR; humans (or dispatch workflows) ship to AWS.

## What runs in CI

Workflow: `.github/workflows/ci.yml`

| Job | Path | Command |
|-----|------|---------|
| CDK | `source/infrastructure` | `npm ci`, `npm run build`, `npm run unit-test`, `npx cdk synth` |
| Deployment UI | `source/ui-deployment` | `npm ci`, `npm run build` |
| Chat UI | `source/ui-chat` | `npm ci`, `npm run build` |

**Use-case hosted chat (`ui-chat`) and WebSocket invoke Lambda (`agentcore-invocation`)** ship inside each **use-case CloudFormation stack** (not the platform stack alone). After you merge changes to those folders:

1. **Push to `main`** — workflow `stage-assets.yml` runs `cdk synth`, builds `ui-chat`, and uploads fresh CDK asset zips + templates to the bootstrap bucket (and mirrors UI zips to the dist bucket when `GAAB_DIST_BUCKET_BASE` is set).
2. **New orchestrator / specialist provision** (AIW → GAAB `/deployments/workflows`) — CloudFormation **CREATE** pulls the latest staged assets automatically. No hot-patch required.
3. **Existing live use cases** — either run a CloudFormation **UPDATE** on the use-case stack from the GAAB dashboard, or refresh in place:
   ```bash
   GAAB_USE_CASE_STACK=feature-orchestrator-1b309012 bash source/scripts/refresh-use-case-hosted-chat.sh
   ```
   This rebuilds from repo `source/ui-chat` + `source/lambda/agentcore-invocation` and preserves per-use-case `runtimeConfig.json`.

**Invocation stream timeout:** `agentcore-invocation` uses `AGENTCORE_STREAM_READ_TIMEOUT` (default **850** seconds, capped below Lambda 900s). Existing stacks may still run an older zip with **300s** until refreshed — that causes `Read timeout on endpoint URL` during long orchestrator delegations (e.g. sync "save PRD"). After merging timeout or invocation changes to `main`, run step 1 then refresh existing use cases (step 3) — **do not** hot-patch Lambda code in production.

**Ideation session resume** (`aiwSessionKey`, delivery session prepend) lives in those two components; new templates and new provisions inherit it once step 1 has run on `main`.

`SKIP_ECR_PREBUILD=1` is set for the whole CDK job so **`cdk synth` does not require Docker** (see `source/pre-build-ecr-images.sh`). Install Docker locally only if you run full `./stage-assets.sh` or turn off that skip for local synth.

**Agent runtime image (`gaab-strands-agent`):** `DeploymentPlatformStack` includes a **CodeBuild** project that builds and pushes the image to `${SharedECRCachePrefix}/gaab-strands-agent:${solution_version}` on every platform deploy (custom resource `BUILD_GAAB_STRANDS_AGENT_IMAGE`). The build re-runs when `deployment/ecr` sources change (asset hash in `BuildVersion`). The full image URI is written to SSM `/gaab-deployment-platform/GaabStrandsAgentImageUri`; new agent use-case stacks (dashboard / shared deployment) resolve that URI automatically.

**AIW tool connections E2E:**

```bash
export ADMIN_USER_EMAIL=you@example.com
export AIW_OAUTH_CALLBACK_URL=https://<your-amplify-app>/oauth/callback  # optional if already in SSM
bash source/scripts/e2e-aiw-tool-connections.sh platform-deploy   # first time or after code changes (~15–30 min)
bash source/scripts/e2e-aiw-tool-connections.sh verify
bash source/scripts/e2e-aiw-tool-connections.sh aiw-checklist       # AIW tear-down + recreate steps
```

After platform deploy, existing runtimes may need `bash source/scripts/recycle-agent-runtime-image.sh` or an AIW workspace reprovision so the runtime uses the SSM image URI.

**Local parity (same as CI) before you push:**

```bash
bash source/scripts/verify-ci-parity.sh
```

## Full upstream test suite

For **Python Lambdas**, **Poetry**, **Docker-heavy** tests, and **integration** coverage, run locally (requires Docker + AWS credentials where noted):

```bash
cd deployment
chmod +x ./run-unit-tests.sh
./run-unit-tests.sh
```

See root `README.md` → *Creating a custom build*.

## Greenfield deploy order (nothing in AWS yet)

1. **One-time:** `cdk bootstrap aws://ACCOUNT/REGION` (see [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html)).
2. **Platform stack:** from `source/infrastructure`, or use the helper (bootstrap + deploy in one go):
   ```bash
   export ADMIN_USER_EMAIL='you@example.com'
   export AWS_DEFAULT_REGION=us-east-1   # match your variable STAGING_AWS_REGION
   bash source/scripts/first-platform-deploy.sh
   ```
   Manual equivalent:
   ```bash
   npm install && npm run build
   cdk deploy DeploymentPlatformStack --parameters AdminUserEmail=you@example.com
   ```
3. **Dashboard URL:** with AWS CLI configured, run `bash source/scripts/print-dashboard-url.sh` (or in the console: CloudFormation → `DeploymentPlatformStack` → **Outputs** → `CloudFrontWebUrl`).

4. **Stage assets** for the deployment dashboard (so it can create use-case stacks):
   ```bash
   cd source
   ./stage-assets.sh
   ```
   Run from `source/`; choose the **same region** as the platform stack. Re-run whenever CDK assets (Lambdas, templates) change.
5. **Use cases:** deploy via the **Deployment Dashboard** UI (recommended), or CLI with `GAAB_USE_CASE_STACK_NAME` as in `source/infrastructure/bin/gen-ai-app-builder.ts`.

## Optional: deploy platform from GitHub Actions

Workflow: `.github/workflows/deploy-platform-dispatch.yml` (manual `workflow_dispatch`).

- Default **dry run** = synth only, **no AWS secrets** required.
- For real deploy: set repository secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (or switch the step to OIDC + `role-to-assume`), set **dry_run** to false, optionally set **admin_user_email** (matches `ADMIN_USER_EMAIL` in `first-platform-deploy.sh`), and run the workflow.
- From your laptop (with `gh auth login`): `ADMIN_USER_EMAIL=you@company.com bash source/scripts/trigger-platform-deploy-github.sh` — or open the workflow in the Actions tab and click **Run workflow**.

## Automate staging assets (S3 + ECR)

Workflow: `.github/workflows/stage-assets.yml`

- **Triggers:** manual `workflow_dispatch`, and **push to `main`** (disable the `push:` block in the YAML if you only want manual runs).
- **Steps:** `npm ci` / `build` / `cdk synth` in `source/infrastructure` (with `SKIP_ECR_PREBUILD=1`), then `source/stage-assets.sh` from `source/` (non-interactive when `GITHUB_ACTIONS=true`).
- **Secrets:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` with permission to write to the CDK asset bucket `cdk-hnb659fds-assets-<account>-<region>`. For ECR stages, add ECR push permissions. Or replace the configure-aws step with OIDC.
- **Region:** For `workflow_dispatch`, use the **aws_region** input. For **push to main**, set repository variable **`STAGING_AWS_REGION`** (defaults to `us-east-1` if unset).
- **ECR vs push:** On **push to `main`**, the workflow sets **`STAGE_ASSETS_SKIP_ECR`** so only **S3 / templates** are uploaded (avoids Docker/ECR failures on every commit). Set repository variable **`STAGE_ASSETS_ECR_ON_PUSH=true`** to build and push agent images on push as well. **Manual `workflow_dispatch`** runs **S3 + ECR** by default; enable **Skip Docker/ECR** in the form for S3-only. Locally, `STAGE_ASSETS_SKIP_ECR=true ./stage-assets.sh` matches S3-only behavior.

Local alternative: `./stage-assets.sh` from `source/` as in the root README.

## Branch protection (recommended)

On `main` (or your default branch):

- Require PR before merge.
- Require status checks: all three CI jobs green.
- Optional: require reviewers for production deploys via GitHub Environments on the dispatch workflow.
