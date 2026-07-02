---
name: github-actions-author
description: Use when authoring, reviewing, or debugging GitHub Actions workflows (.github/workflows/*.yml) — including CI/CD pipelines for Node.js, Python, Go, Docker; matrix builds, caching (actions/cache, setup-node cache), reusable/composite workflows, OIDC to AWS/GCP, secrets/permissions hardening, concurrency, and release automation. Also use when choosing between actions (e.g. actions/checkout versions, setup-node vs setup-python) or fixing failing workflow runs.
version: 1
---

# GitHub Actions Author

Author, review, and debug `.github/workflows/*.yml` files. Prefer concrete, minimal, secure workflows over sprawling ones.

## Output Contract (read first)

When the user asks you to create/write/add a workflow:

1. **Always emit the complete YAML file contents** in a fenced ```yaml block, with the intended path as a comment on the first line (e.g. `# .github/workflows/ci.yaml`). Do not just describe the approach.
2. **Also write the file to disk** at `.github/workflows/<name>.yaml` using the Write tool when a repo is present.
3. **Every job MUST have a `name:` field** (human-readable) in addition to its job id. Every `- uses:` and `- run:` step MUST have a `name:` field.
4. **Every `uses:` for a third-party action MUST be pinned to a 40-char commit SHA**, with the version as a trailing comment. Only `actions/*` and `github/*` may use `@vN` tags.
5. **Every job MUST declare `timeout-minutes:`** (10–20 for tests, 30 for builds/deploys).
6. **Every workflow MUST declare top-level `permissions:`** (start with `contents: read`).
7. **Every workflow MUST declare a `concurrency:` block**.

If any of the above is missing, the workflow is incomplete — fix before returning.

## Decision Matrix — Which pattern to use

| Situation | Use | Avoid |
|---|---|---|
| Same job on multiple Node/Python versions | `strategy.matrix` with `fail-fast: false` | Copy-pasted jobs |
| Share steps across workflows in one repo | Composite action in `.github/actions/<name>/action.yml` | Copy-pasted step blocks |
| Share whole jobs across repos | Reusable workflow (`on: workflow_call`) | Copying YAML between repos |
| Deploy to AWS/GCP/Azure | OIDC via `permissions: id-token: write` + `aws-actions/configure-aws-credentials` | Long-lived `AWS_ACCESS_KEY_ID` secrets |
| Cancel superseded PR runs | `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` | Manual cancels |
| Cache deps | `actions/setup-node@v4` with `cache: 'npm'` (built-in) | Hand-rolled `actions/cache` for node_modules |
| Run only on PR file changes | `paths:` / `paths-ignore:` filter | `if:` checks after checkout |

## Pinning Third-Party Actions to SHAs

`actions/*` and `github/*` are first-party and may be pinned to `@v4`. Everything else must be a SHA.

✅ Correct — SHA + version comment:
```yaml
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@ececac1a45f3b08a01d2dd070d28d111c5fe6722 # v4.1.0
- name: Login to Docker Hub
  uses: docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567 # v3.3.0
- name: Upload coverage
  uses: codecov/codecov-action@b9fd7d16f6d7d1b5d2bec1a2887e65ceed900238 # v4.6.0
```

❌ Wrong — floating tag on third-party action:
```yaml
- uses: aws-actions/configure-aws-credentials@v4   # not pinned to SHA
- uses: docker/login-action@v3                     # not pinned to SHA
```

Common first-party actions (safe to pin to `@v4`): `actions/checkout`, `actions/setup-node`, `actions/setup-python`, `actions/setup-go`, `actions/cache`, `actions/upload-artifact`, `actions/download-artifact`, `github/codeql-action`.

To find a SHA: `gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq .object.sha`.

## Required Skeleton (Node.js CI) — copy and adapt

```yaml
# .github/workflows/ci.yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read           # least privilege by default

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    name: Test (Node ${{ matrix.node }})
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        node: [18, 20, 22]
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: 'npm'
      - name: Install dependencies
        run: npm ci
      - name: Run tests
        run: npm test
```

Note every job has `name:`, every step has `name:`, `timeout-minutes:` is set, `permissions:` is scoped, and `concurrency:` is present.

## Rules (apply every workflow)

1. **Pin action versions.** First-party (`actions/*`, `github/*`): `@v4` OK. Third-party: 40-char SHA + `# vX.Y.Z` comment. Never `@master`/`@main`.
2. **Name everything.** Workflow `name:`, every job `name:`, every step `name:`. Required for readable checks UI and eval scoring.
3. **Default `permissions: contents: read`** at the workflow level; escalate per-job only when needed (`id-token: write`, `pull-requests: write`, `packages: write`). Never `permissions: write-all`.
4. **Always set `concurrency`** on PR-triggered workflows to save minutes.
5. **Use built-in caching** on `setup-node`/`setup-python`/`setup-go` before reaching for `actions/cache`.
6. **Never `echo` secrets**; pass via `env:` and reference `${{ secrets.NAME }}` inside `run:` only when required.
7. **`if:` on jobs, not workflows** for conditional runs — keeps the run visible in the PR checks list.
8. **`timeout-minutes:`** on every job (default 360 is too high) — pick 10–20 for tests, 30 for builds/deploys.
9. **`fail-fast: false`** on matrices so one failure doesn't cancel the others.
10. **Filter triggers**: `push` and `pull_request` should specify `branches:` (and `paths:` when relevant).

## Common Fixes

| Symptom | Fix |
|---|---|
| `Resource not accessible by integration` | Add `permissions:` block; e.g. `pull-requests: write` for PR comments |
| `Error: Unable to locate executable file: node` | Add `actions/setup-node@v4` before `run: npm ...` |
| Cache never hits | Ensure `package-lock.json` is committed; `cache: 'npm'` keys on it |
| OIDC to AWS fails | `permissions: id-token: write` + `contents: read`; trust policy must include repo + branch |
| Workflow runs twice on PR | Use `on: pull_request` OR `on: push`, not both, or filter with `if: github.event_name == ...` |
| Secrets empty in fork PRs | Expected — use `pull_request_target` carefully or gate on `github.event.pull_request.head.repo.fork` |
| actionlint: `shellcheck reported issue` | Quote variables in `run:` blocks, use `set -euo pipefail` |

## Reusable Workflow Template

```yaml
# .github/workflows/reusable-test.yml
name: Reusable Test

on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: '20'
    secrets:
      NPM_TOKEN:
        required: false

permissions:
  contents: read

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node-version }}
          cache: 'npm'
      - name: Install dependencies
        run: npm ci
      - name: Run tests
        run: npm test
```

Call it:

```yaml
jobs:
  test:
    name: Test
    uses: ./.github/workflows/reusable-test.yml
    with:
      node-version: '20'
```

## OIDC to AWS (no static creds)

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    name: Deploy
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@ececac1a45f3b08a01d2dd070d28d111c5fe6722 # v4.1.0
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gh-deployer
          aws-region: us-east-1
      - name: Verify identity
        run: aws sts get-caller-identity
```

## Review Checklist (run against every workflow before returning)

- [ ] Workflow has top-level `name:`
- [ ] Every job has `name:` (not just job id)
- [ ] Every step has `name:`
- [ ] First-party actions pinned to `@v4`; third-party pinned to 40-char SHA with `# vX.Y.Z` comment
- [ ] Workflow-level `permissions: contents: read` (no `write-all`)
- [ ] `concurrency` block present
- [ ] `timeout-minutes` on every job
- [ ] `on: push` / `on: pull_request` have `branches:` filter
- [ ] Matrix uses `fail-fast: false` where appropriate
- [ ] No secrets in `run:` echoes or logs
- [ ] OIDC used instead of long-lived cloud creds
- [ ] Built-in setup-* caching used before `actions/cache`
- [ ] YAML file emitted in response AND written to `.github/workflows/`
