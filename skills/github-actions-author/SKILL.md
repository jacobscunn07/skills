---
name: github-actions-author
description: 'Use when writing, reviewing, debugging, or hardening GitHub Actions - .github/workflows YAML, jobs and matrix builds, caching, concurrency, permissions and GITHUB_TOKEN scope, OIDC cloud deploys, reusable workflows (workflow_call), and custom composite/JavaScript actions (action.yml). Trigger on any mention of .github/workflows, runs-on, uses:, action.yml, workflow_dispatch, pull_request_target, actions/checkout, CI pipeline on GitHub, or a request to write/fix/review/harden a GitHub Actions workflow.'
version: 0.1.0
license: MIT
---

# GitHub Actions Author

## MANDATORY OUTPUT CONTRACT

Every response does BOTH: (1) writes each file to disk with the Write tool at its real
path, and (2) pastes the **complete final contents** of each file into the reply as a
fenced ```yaml block. Writing a file without showing it fails. Showing it without writing it also fails.

| Asked for | Write AND show in full |
|---|---|
| workflow / CI / pipeline | `.github/workflows/<name>.yml` + `.github/dependabot.yml` |
| reusable workflow | the callee **and** a caller under `.github/workflows/` + `.github/dependabot.yml` |
| composite or JS action | `<dir>/action.yml` + every script it runs + a caller workflow + `.github/dependabot.yml` |
| review / fix / harden | the corrected file **in place, same path**, shown as one full ```yaml block, then an itemized change log (+ `.github/dependabot.yml` if missing) |

No elisions (`# ...rest of the jobs`, "same pattern as above"). No placeholder steps
(`echo "build here"`, `# TODO`). If the request names steps, implement each one with real
commands. If a detail is unknown, pick a concrete, sensible default and state the assumption.

Ship this with every set of SHA-pinned actions, or the pins freeze today's CVEs forever:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule: {interval: weekly}
```

## READ BEFORE YOU WRITE (mandatory)

| If the task involves | Read first |
|---|---|
| triggers, matrix, caching, job outputs, artifacts, services, contexts, expressions | `references/workflow-syntax.md` |
| permissions, SHA pinning, OIDC to AWS/GCP/Azure, secrets, `pull_request_target`, environments, or **any review/hardening request** | `references/security.md` |
| `workflow_call`, composite actions, JS actions, `action.yml`, publishing an action | `references/reusable-and-actions.md` |

Do not answer from this page alone. A hardening review needs the checklist at the end of `references/security.md`.

## THE 6 NON-NEGOTIABLE RULES

These apply to every file you produce. A review that fixes rule 1 and leaves rule 5 broken does not pass.

### 1. Pin every third-party `uses:` to a 40-char SHA with a `# vX.Y.Z` comment

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2   # RIGHT
- uses: actions/checkout@v4                                                  # WRONG: mutable tag
```

Never invent a SHA. Use this table, or resolve one with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`.
Local `./.github/actions/<name>` is exempt.

| Action | Pin |
|---|---|
| `actions/checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2` |
| `actions/setup-node` | `39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0` |
| `actions/setup-python` | `0b93645e9fea7318ecaed2b359559ac225c90a2b # v5.3.0` |
| `actions/cache` | `1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0` |
| `actions/upload-artifact` | `b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3` |
| `actions/github-script` | `60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1` |
| `aws-actions/configure-aws-credentials` | `e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4.0.2` |

### 2. Explicit least-privilege `permissions`

Set `permissions: {contents: read}` at the top level, then widen it per job only where needed.
Put `id-token: write` only on the job that deploys. The block is exhaustive: anything
unlisted becomes `none`. `write-all` is never acceptable, and omitting the block is never acceptable.

### 3. Never interpolate attacker-controlled input into a shell

```yaml
- run: echo "PR ${{ github.event.pull_request.title }}"   # WRONG: script injection
- run: echo "PR $PR_TITLE"                                # RIGHT
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
```

This covers PR and issue titles and bodies, comments, `github.head_ref`, branch names, and commit
messages. Pass them through `env:` and never put them inside `run:` or `script:`. Pass secrets the same way, at step scope.

### 4. No PR code under `pull_request_target`; checkout sheds its token

Default to `pull_request`. Never pair `pull_request_target` with `ref: ...head.sha`. Every
`actions/checkout` in a job that runs repo or PR code sets `persist-credentials: false`.

### 5. `timeout-minutes` on every job; `concurrency` on every workflow, reusable ones included

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Cancel in-progress PR runs, and never cancel deploys (`cancel-in-progress: false`). In a
`workflow_call` callee, `github.workflow` is the **caller's** name. Give the callee its own
suffixed group, `group: ${{ github.workflow }}-${{ github.ref }}-build`, so it cannot
deadlock against the caller's group.

### 6. Strict shell for every multi-command `run:`

```yaml
defaults:
  run:
    shell: bash -euo pipefail {0}
```

The runner's default is `bash -e` without pipefail, so `cmd | grep` failures are silently ignored. In a composite action,
use `shell: bash` on each step and make `set -euo pipefail` the first line of the script.

## Custom action (`action.yml`) contract

- **Every `outputs.<name>` has `value: ${{ steps.<id>.outputs.<key> }}`**, and the step it
  points at has an `id:` and either writes `echo "key=v" >> "$GITHUB_OUTPUT"` or is an action
  that exposes that output. Wrapping `actions/cache`:
  `cache-hit: {description: ..., value: ${{ steps.cache.outputs.cache-hit }}}`, on a step with `id: cache`.
  An output with no `value:` is broken wiring.
- Every input and output has a `description`. Inputs are strings (`default: 'true'`).
- Read inputs through `env:` (`VERSION: ${{ inputs.version }}`), never inline in the script.
- Ship a caller workflow that checks out the repo first, then `uses: ./<dir>` with an `id:`, and reads one of the outputs.

## Minimum viable workflow

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

defaults:
  run:
    shell: bash -euo pipefail {0}

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: '22'
          cache: npm
      - name: Install and test
        run: |
          npm ci
          npm test
```

## Quick decisions

| Situation | Do | Don't |
|---|---|---|
| Share whole jobs across repos | Reusable workflow (`workflow_call`) + a caller | Copy-paste YAML |
| Share steps within a job | Composite action | Reusable workflow |
| Dependency caching | `setup-*` built-in `cache:` | No cache, or a static `actions/cache` key |
| `actions/cache` key | `runner.os` + `hashFiles('**/<lockfile>')` | A key that never invalidates |
| Installs | `npm ci`, `pip install -r` with a lock, `--frozen-lockfile` | `npm install` |
| Cloud credentials | OIDC + `id-token: write` + `environment:` | Static access-key secrets |
| Step output | `echo "k=v" >> "$GITHUB_OUTPUT"` | `::set-output` (removed) |
| Test matrix | `fail-fast: false`, every dimension used | Default fail-fast |
| Matrix artifacts | Unique `name:` per leg | One shared name (v4 artifacts are immutable) |
| Deploy approval | `environment: production` with reviewers | `if:` on an actor name |
| Readability | Workflow `name:`, kebab-case job ids, `name:` on multi-line steps | Anonymous script steps |
| Validate | `actionlint .github/workflows/*.yml` | Eyeballing it |

## Self-check before sending

1. Every file is written to disk **and** shown in full as a ```yaml block. That includes review and hardening output.
2. `.github/dependabot.yml` is shipped. No elisions, no placeholder steps.
3. Every non-local `uses:` is pinned to a SHA with a `# vX.Y.Z` comment, taken from the table or resolved, never invented.
4. A top-level `permissions:` floor exists. `id-token: write` appears only on the deploy job.
5. No untrusted `${{ }}` appears in `run:` or `script:`. Secrets reach steps through step-level `env:`.
6. No `pull_request_target` checks out the PR head. Checkouts set `persist-credentials: false`.
7. Every job has `timeout-minutes`, and every workflow has `concurrency`. Callees use a suffixed group.
8. `bash -euo pipefail` covers every multi-command step.
9. In action.yml, every output has a `value:` that points at an `id:` step.
10. Reusable workflow requests include a caller. The relevant `references/*.md` was read.
