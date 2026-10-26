# Global Agent Instructions

## GitHub

When interacting with GitHub (github.com), ALWAYS use `gh` on the command line instead of the GitHub MCP server. The GitHub MCP server exposes too many tools and bloats the LLM context, degrading performance. The `gh` CLI is well-known to models and is the preferred interface.

## Shell Environment

- Always use the `--context` flag when running `kubectl` commands to explicitly specify the cluster context
- to interact with aws cli, use aws-vault exec sso-prod-engineering.

## GitLab Authentication

- `ddtool auth gitlab login` - Refreshes GitLab OAuth credentials via browser PKCE flow
- `ddtool auth gitlab token` - Generates a short-lived OAuth access token (use with `Authorization: Bearer` header)
- Note: `trigger-ci` requires a Personal Access Token (PAT) in `GITLAB_TOKEN` env var, not an OAuth token
  - Generate a PAT at: <https://gitlab.ddbuild.io/-/profile/personal_access_tokens>
  - The OAuth token from `ddtool` uses Bearer auth, but trigger-ci uses PRIVATE-TOKEN header

## Docker

- Connect to the workspace with: `ssh workspace-matthieu-neau2`
- If the SSH connection fails, notify the user so they can recreate the workspace
- Run all Docker build, push, pull, and other Docker-related commands inside the workspace session
- When interacting with the `727006795293.dkr.ecr.us-east-1.amazonaws.com` image registry, use the `aws-vault exec sso-staging-engineering --` prefix for authentication (e.g. `aws-vault exec sso-staging-engineering -- docker push 727006795293.dkr.ecr.us-east-1.amazonaws.com/...`)
- **Never build images intended for Kubernetes deployment locally or in the workspace.** A workspace/local `docker build` produces an unsigned, unattested image — cluster admission policy rejects it. Any image that needs to run in a cluster (e.g. custom builds from the `DataDog/images` repo, like `dynamo-planner`) must go through that repo's GitLab CI pipeline instead, which signs and attests it. This does not require merging to main: push a feature branch (with a new Dockerfile/version directory if needed), then trigger a pipeline via the GitLab UI or API with `IMAGE_NAME`/`IMAGE_VERSION` set to the image's directory/version-directory names (see "Triggering GitLab pipelines with OAuth token" below for the API form). The workspace is still correct for ordinary local Docker dev/iteration that is never deployed to a cluster.

### Triggering GitLab pipelines with OAuth token (bypassing trigger-ci)

When trigger-ci fails due to token issues, use curl with the OAuth token directly:

```bash
TOKEN=$(ddtool auth gitlab token)
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ref": "YOUR_BRANCH_NAME",
    "variables": [
      {"key": "DYNAMIC_BUILD_RENDER_TARGET", "value": "//path/to/bazel:target"}
    ]
  }' \
  "https://gitlab.ddbuild.io/api/v4/projects/DataDog%2Fdd-source/pipeline"
```

### Kubernetes deployments

- Gatekeeper does not allow images from external Docker registries. All container images must come from internal Docker registries.
- Datadog does **not** use plain k8s `Secret` objects for app secrets. Secrets are managed in HashiCorp Vault and pulled at runtime — never hand-author a `kind: Secret` manifest or a `secretRef`/`envFrom` pointing at one that isn't Vault-backed.
  - Standard path convention: `kv/k8s/rapid-<team>/<app>/<secret-name>` (e.g. `kv/k8s/rapid-ai-platform/llm-benchmark/hf-token`).
  - Write a secret: `export VAULT_ADDR=https://vault.us1.staging.dog && vault login -method=oidc && vault kv put kv/k8s/rapid-<team>/<app>/<secret-name> <field>="<value>" && unset VAULT_ADDR` (always `unset VAULT_ADDR` after — some internal tools like `ddtool` refuse to start if it's set).
  - Read a secret: `vault kv get -field=<field> kv/k8s/rapid-<team>/<app>/<secret-name>`.
  - **Primary/current pattern — emissary sidecar** (works for both raw manifests and Helm charts, confirmed via `domains/atlas/shared/libs/emissary/emissary.go` and used across `domains/ai_platform/apps/llm-benchmark/k8s/*.yaml`, `domains/atlas/**`, etc.): add annotation `emissary.datadoghq.com/inject-lifecycle: "inject"` to the pod template — this injects a sidecar that acts as a local Vault proxy and sets `VAULT_ADDR` in the main container automatically. From app code or a shell script, hit it like the real Vault HTTP API:

    ```bash
    curl -sS -H "X-Vault-Request: true" "$VAULT_ADDR/v1/kv/data/k8s/rapid-<team>/<app>/<secret-name>"
    # => {"data":{"data":{"<field>":"<value>", ...}}}  (KV v2 double-nested "data")
    ```

    In Go, prefer `domains/atlas/shared/libs/emissary` (`emissary.GetSecret(ctx, path, key)` / `GetSecrets` / `GetEnvOrSecret`) over hand-rolling the HTTP call.
  - Older/alternate pattern seen in one Helm-based app (`domains/obs-pipelines/apps/obs-pipelines-synthetic-worker/templates/{configmap,deployment}.yaml`): a **consul-template init container** that renders the secret into a file (`keys.env`) via a shared `emptyDir`, sourced by the main container's entrypoint. Don't default to this — it hasn't been seen elsewhere; prefer the emissary sidecar unless there's a reason to match that specific app's existing convention.
  - Do not use Vault Agent Injector annotations or an `ExternalSecret`/`VaultSecret` CRD — neither pattern used in this repo relies on those.
  - Beware: some existing manifests in this repo (e.g. found in `llm-benchmark/k8s/qwen3-5-27b-sglang-dflash-raw.yaml`) have the emissary annotation added but _still_ reference a plain `secretRef: {name: hf-token-secret}` that doesn't exist anywhere as a real k8s Secret object — that's leftover/unmigrated, not a valid pattern to copy.
  - Vault docs: <https://datadoghq.atlassian.net/wiki/spaces/RUNTIME/pages/2701559033/Vault>

## Creating git branches

When creating git branches, prefix them with "matthieu.neau/". For example, "matthieu.neau/deploy-new-model"

## Creating pull requests

Always do PR work (branch, commits, `gh pr create`) in a separate git worktree, not directly in the primary checkout. This keeps the primary working directory free for other in-progress work and avoids branch-switch conflicts.

## GitHub Authentication

- Two `gh` accounts logged in: `matthieu-n` and `matthieu-neau_ddog`.
- `DataDog` org repos → switch to `matthieu-n` (`gh auth switch --user matthieu-n`).
- `ddoghq` org repos → switch to `matthieu-neau_ddog` (`gh auth switch --user matthieu-neau_ddog`).

## Obsidian Notes

- Vault path: `/Users/matthieu.neau/obsidian-vault/`
- When the user references an Obsidian note like `Model Compilation.md`, the full path is `/Users/matthieu.neau/obsidian-vault/Model Compilation.md`
