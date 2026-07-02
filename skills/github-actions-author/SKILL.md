---
name: github-actions-author
description: Use when authoring, reviewing, or debugging GitHub Actions workflows (.github/workflows/*.yml) — including CI/CD pipelines for Node.js, Python, Go, Docker; matrix builds, caching (actions/cache, setup-node cache), reusable/composite workflows, OIDC to AWS/GCP, secrets/permissions hardening, concurrency, and release automation. Also use when choosing between actions (e.g. actions/checkout versions, setup-node vs setup-python) or fixing failing workflow runs.
version: 1
---

# GitHub Actions Author

Author, review, and debug `.github/workflows/*.yml` files. Prefer concrete, minimal, secure workflows over sprawling ones.

## Decision Matrix — Which pattern to use

| Situation | Use | Avoid |
|---|---|---|
| Same job on multiple Node/Python versions | `strategy.matrix` with `fail-fast: false` | Copy-pasted jobs |
| Share steps across workflows in one repo | Composite action in `.github/actions/<name>/action.yml` | Copy-pasted step blocks |
| Share whole jobs across repos | Reusable workflow (`on: workflow_call`) | Copying YAML between repos |
| Deploy to AWS/GCP/Azure | OIDC via `permissions: id-token: write` + `aws-actions/configure-aws-credentials@v4` | Long-lived `AWS_ACCESS_KEY_ID` secrets |
| Cancel superseded PR runs | `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` | Manual cancels |
| Cache deps | `actions/setup-node@v4` with `cache: 'npm'` (built-in) | Hand-rolled `actions/cache` for node_modules |
| Run only on PR file changes | `paths:` / `paths-ignore:` filter | `if:` checks after checkout |

## Required Skeleton (Node.js CI)

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read           # least privilege by default

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: 'npm'
      - run: npm ci
      - run: npm test
```

## Rules (apply every workflow)

1. **Pin action major versions** (`@v4`), or SHAs for third-party actions. Never use `@master`/`@main`.
2. **Default `permissions: contents: read`** at the workflow level; escalate per-job only when needed (`id-token: write`, `pull-requests: write`, `packages: write`).
3. **Always set `concurrency`** on PR-triggered workflows to save minutes.
4. **Use built-in caching** on `setup-node`/`setup-python`/`setup-go` before reaching for `actions/cache`.
5. **Never `echo` secrets**; pass via `env:` and reference `${{ secrets.NAME }}` inside `run:` only when required.
6. **`if:` on jobs, not workflows** for conditional runs — keeps the run visible in the PR checks list.
7. **`timeout-minutes:`** on every job (default 60 is too high) — pick 10–20 for tests.
8. **`fail-fast: false`** on matrices so one failure doesn't cancel the others.

## Common Fixes

| Symptom | Fix |
|---|---|
| `Resource not accessible by integration` | Add `permissions:` block; e.g. `pull-requests: write` for PR comments |
| `Error: Unable to locate executable file: node` | Add `actions/setup-node@v4` before `run: npm ...` |
| Cache never hits | Ensure `package-lock.json` is committed; `cache: 'npm'` keys on it |
| OIDC to AWS fails | `permissions: id-token: write` + `contents: read`; trust policy must include repo + branch |
| Workflow runs twice on PR | Use `on: pull_request` OR `on: push`, not both, or filter with `if: github.event_name == ...` |
| Secrets empty in fork PRs | Expected — use `pull_request_target` carefully or gate on `github.event.pull_request.head.repo.fork` |

## Reusable Workflow Template

```yaml
# .github/workflows/reusable-test.yml
on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: '20'
    secrets:
      NPM_TOKEN:
        required: false

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm test
```

Call it:

```yaml
jobs:
  test:
    uses: ./.github/workflows/reusable-test.yml
    with:
      node-version: '20'
```

## OIDC to AWS (no static creds)

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/gh-deployer
      aws-region: us-east-1
  - run: aws sts get-caller-identity
```

## Review Checklist

- [ ] All actions pinned (`@v4` min, SHA for third-party)
- [ ] Workflow-level `permissions: contents: read`
- [ ] `concurrency` block present
- [ ] `timeout-minutes` on every job
- [ ] Matrix uses `fail-fast: false` where appropriate
- [ ] No secrets in `run:` echoes or logs
- [ ] OIDC used instead of long-lived cloud creds
- [ ] Built-in setup-* caching used before `actions/cache`
