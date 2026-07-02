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
4. **Every `uses:` MUST be pinned to a 40-char commit SHA**, with the version as a trailing comment (`# v4.1.7`). This applies to first-party (`actions/*`, `github/*`) AND third-party actions. Never `@v4`, `@main`, `@master`.
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
| Cache deps | `actions/setup-node@<sha>` with `cache: 'npm'` (built-in) | Hand-rolled `actions/cache` for node_modules |
| Run only on PR file changes | `paths:` / `paths-ignore:` filter | `if:` checks after checkout |

## Pinning ALL Actions to SHAs (mandatory)

**Every `uses:` line must be pinned to a 40-char commit SHA** — including first-party `actions/*` and `github/*`. This is required for supply-chain safety and passes the `pin-external-uses` check. Always include a trailing `# vX.Y.Z` comment for readability.

✅ Correct — SHA + version comment on every action:
```yaml
- name: Checkout
  uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
- name: Setup Node.js
  uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
- name: Setup Python
  uses: actions/setup-python@f677139bbe7f9c59b41e40162b753c062f5d49a3 # v5.2.0
- name: Setup Go
  uses: actions/setup-go@41dfa10bad2bb2ae585af6ee5bb4d7d973ad74ed # v5.1.0
- name: Cache
  uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0
- name: Upload artifact
  uses: actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3
- name: Download artifact
  uses: actions/download-artifact@fa0a91b85d4f404e444e00e005971372dc801d16 # v4.1.8
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@ececac1a45f3b08a01d2dd070d28d111c5fe6722 # v4.1.0
- name: Login to Docker Hub
  uses: docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567 # v3.3.0
- name: Upload coverage
  uses: codecov/codecov-action@b9fd7d16f6d7d1b5d2bec1a2887e65ceed900238 # v4.6.0
- name: CodeQL init
  uses: github/codeql-action/init@f779452ac5af1c261dce0346a8f964149f49322b # v3.26.13
```

❌ Wrong — floating tags (any action, first-party OR third-party):
```yaml
- uses: actions/checkout@v4                        # not pinned to SHA — FAILS
- uses: actions/setup-node@v4                      # not pinned to SHA — FAILS
- uses: aws-actions/configure-aws-credentials@v4   # not pinned to SHA — FAILS
```

To find a SHA: `gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq .object.sha`.

### Ready-to-copy SHA reference table

| Action | Pin |
|---|---|
| actions/checkout | `@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2` |
| actions/setup-node | `@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0` |
| actions/setup-python | `@f677139bbe7f9c59b41e40162b753c062f5d49a3 # v5.2.0` |
| actions/setup-go | `@41dfa10bad2bb2ae585af6ee5bb4d7d973ad74ed # v5.1.0` |
| actions/cache | `@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0` |
| actions/upload-artifact | `@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3` |
| actions/download-artifact | `@fa0a91b85d4f404e444e00e005971372dc801d16 # v4.1.8` |
| aws-actions/configure-aws-credentials | `@ececac1a45f3b08a01d2dd070d28d111c5fe6722 # v4.1.0` |
| docker/login-action | `@9780b0c442fbb1117ed29e0efdff1e18412f7567 # v3.3.0` |
| docker/build-push-action | `@4f58ea79222b3b9dc2c8bbdd6debcef730109a75 # v6.9.0` |
| codecov/codecov-action | `@b9fd7d16f6d7d1b5d2bec1a2887e65ceed900238 # v4.6.0` |
| pypa/gh-action-pypi-publish | `@f7600683efdcb7656dec5b29656edb7bc586e597 # v1.10.3` |

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
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Setup Node.js
        uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: ${{ matrix.node }}
          cache: 'npm'
      - name: Install dependencies
        run: npm ci
      - name: Run tests
        run: npm test
```

Note every action pinned to SHA, every job has `name:`, every step has `name:`, `timeout-minutes:` is set, `permissions:` is scoped, and `concurrency:` is present.

## Rules (apply every workflow)

1. **Pin EVERY action version to a 40-char SHA + `# vX.Y.Z` comment.** No exceptions for first-party. Never `@master`/`@main`/`@vN`.
2. **Name everything.** Workflow `name:`, every job `name:`, every step `name:`. Required for readable checks UI and eval scoring.
3. **Default `permissions: contents: read`** at the workflow level; escalate per-job only when needed (`id-token: write`, `pull-requests: write`, `packages: write`). Never `permissions: write-all`.
4. **Always set `concurrency`** on PR-triggered workflows to save minutes. For release workflows, use `cancel-in-progress: false` so tag pushes don't cancel each other.
5. **Use built-in caching** on `setup-node`/`setup-python`/`setup-go` before reaching for `actions/cache`.
6. **Never `echo` secrets**; pass via `env:` and reference `${{ secrets.NAME }}` inside `run:` only when required.
7. **`if:` on jobs, not workflows** for conditional runs — keeps the run visible in the PR checks list.
8. **`timeout-minutes:`** on every job (default 360 is too high) — pick 10–20 for tests, 30 for builds/deploys.
9. **`fail-fast: false`** on matrices so one failure doesn't cancel the others.
10. **Filter triggers**: `push` and `pull_request` should specify `branches:` (and `paths:` when relevant). `on: push: tags:` for release workflows.

## Common Fixes

| Symptom | Fix |
|---|---|
| `Resource not accessible by integration` | Add `permissions:` block; e.g. `pull-requests: write` for PR comments |
| `Error: Unable to locate executable file: node` | Add `actions/setup-node@<sha>` before `run: npm ...` |
| Cache never hits | Ensure `package-lock.json` is committed; `cache: 'npm'` keys on it |
| OIDC to AWS fails | `permissions: id-token: write` + `contents: read`; trust policy must include repo + branch |
| Workflow runs twice on PR | Use `on: pull_request` OR `on: push`, not both, or filter with `if: github.event_name == ...` |
| Secrets empty in fork PRs | Expected — use `pull_request_target` carefully or gate on `github.event.pull_request.head.repo.fork` |
| actionlint: `shellcheck reported issue` | Quote variables in `run:` blocks, use `set -euo pipefail` |
| `pin-external-uses` check fails | Replace every `@v4` / `@main` with a 40-char SHA + `# vX.Y.Z` comment — includes actions/checkout |

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
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Setup Node.js
        uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
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

## Python Release Workflow (tag-triggered, PyPI)

```yaml
# .github/workflows/release.yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: read
  id-token: write            # for PyPI trusted publishing

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false  # never cancel an in-flight release

jobs:
  release:
    name: Build and publish
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Setup Python
        uses: actions/setup-python@f677139bbe7f9c59b41e40162b753c062f5d49a3 # v5.2.0
        with:
          python-version: '3.12'
      - name: Build distribution
        run: |
          python -m pip install --upgrade build
          python -m build
      - name: Publish to PyPI
        uses: pypa/gh-action-pypi-publish@f7600683efdcb7656dec5b29656edb7bc586e597 # v1.10.3
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
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
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
- [ ] **Every action (first-party AND third-party) pinned to 40-char SHA with `# vX.Y.Z` comment** — no `@v4`, no `@main`
- [ ] Workflow-level `permissions: contents: read` (no `write-all`)
- [ ] `concurrency` block present
- [ ] `timeout-minutes` on every job
- [ ] `on: push` / `on: pull_request` have `branches:` (or `tags:`) filter
- [ ] Matrix uses `fail-fast: false` where appropriate
- [ ] No secrets in `run:` echoes or logs
- [ ] OIDC used instead of long-lived cloud creds
- [ ] Built-in setup-* caching used before `actions/cache`
- [ ] YAML file emitted in response AND written to `.github/workflows/`
