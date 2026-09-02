---
name: github-actions-author
description: 'Use when writing, reviewing, debugging, or hardening GitHub Actions - .github/workflows YAML, jobs and matrix builds, caching, concurrency, permissions and GITHUB_TOKEN scope, OIDC cloud deploys, reusable workflows (workflow_call), and custom composite/JavaScript actions (action.yml). Trigger on any mention of .github/workflows, runs-on, uses:, action.yml, workflow_dispatch, pull_request_target, actions/checkout, CI pipeline on GitHub, or a request to write/fix/review/harden a GitHub Actions workflow.'
version: 0.1.0
license: MIT
---

# GitHub Actions Author

## MANDATORY OUTPUT CONTRACT

**Every response writes each file to disk with the Write tool at its real path AND emits it
as a fenced ```yaml block.**

| Asked for | Write to | Also emit |
|---|---|---|
| a workflow / CI / pipeline | `.github/workflows/<name>.yml` **+ `.github/dependabot.yml`** | ```yaml block each |
| a reusable workflow | **both the callee AND a caller** under `.github/workflows/` + `.github/dependabot.yml` | one ```yaml block each |
| a composite or JS action | `<dir>/action.yml` (+ `README.md`) | ```yaml block |
| "review / fix / harden this workflow" | **the corrected file, in place, same path** + `.github/dependabot.yml` if missing | full corrected ```yaml + a change log |

Never skip the write. A markdown-only answer is a failure even when the YAML is perfect.
Never abbreviate: no `# ...rest of the jobs`, no "the other jobs follow the same pattern",
no step lists in prose where YAML belongs. Emit whole, runnable files.

**Dependabot is not optional.** Any workflow that pins third-party actions to a SHA must
ship with `.github/dependabot.yml` in the same response, or the pins freeze today's code
(including tomorrow's CVE) forever:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule: {interval: weekly}
```

Before emitting any workflow, read the reference file for the task in the routing table
below. Do not answer from this page alone.

## THE 6 NON-NEGOTIABLE RULES

Apply to every workflow, action, review, and snippet. No exceptions - a hardening review
that fixes rule 1 but leaves rules 5 or 6 broken is not a passing review.

### RULE 1: Pin every third-party `uses:` to a full 40-character commit SHA

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2   # RIGHT
- uses: actions/checkout@v4                                                  # WRONG
- uses: actions/checkout@main                                                # WRONG
```

A tag is mutable: whoever owns the action can repoint it at code that runs with your token
and your secrets. The trailing `# vX.Y.Z` comment is required - Dependabot reads it.

Never invent a SHA. Resolve with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`,
or use one of the verified pins below. Exempt: local `./.github/actions/<name>`.

| Action | Pin |
|---|---|
| `actions/checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2` |
| `actions/setup-node` | `39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0` |
| `actions/setup-python` | `0b93645e9fea7318ecaed2b359559ac225c90a2b # v5.3.0` |
| `actions/cache` | `1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0` |
| `actions/upload-artifact` | `b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3` |
| `actions/github-script` | `60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1` |
| `aws-actions/configure-aws-credentials` | `e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4.0.2` |

### RULE 2: Declare explicit least-privilege `permissions`

Every workflow gets a top-level floor; jobs widen it only where they must.

```yaml
permissions:
  contents: read        # workflow-wide floor

jobs:
  release:
    permissions:
      contents: write   # this job only
      id-token: write   # OIDC belongs on the job that deploys, never workflow-wide
```

A `permissions:` block is exhaustive - everything unlisted becomes `none`. `write-all` is
never an acceptable answer, and neither is omitting the block.

### RULE 3: Never interpolate attacker-controlled input into a shell

```yaml
- run: echo "PR ${{ github.event.pull_request.title }}"   # WRONG - script injection
- run: echo "PR $PR_TITLE"                                # RIGHT
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
```

`${{ }}` is substituted before the shell parses the line. Anything a contributor can type -
PR/issue title and body, comment body, branch name, `github.head_ref`, commit message - goes
through `env:` as data, never into the script text.

### RULE 4: `pull_request_target` never checks out PR code; `checkout` sheds its token when PR code runs

`pull_request_target` runs privileged, with secrets. Default to `pull_request`. Use
`pull_request_target` only for jobs that touch no PR content, and never with
`ref: ${{ github.event.pull_request.head.sha }}`.

Any `actions/checkout` in a job that then runs contributor code (a PR from any source, a
release built from a tag pushed by a maintainer, etc.) MUST set `persist-credentials: false`
- otherwise `GITHUB_TOKEN` stays in `.git/config` for that code to read:

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
  with:
    persist-credentials: false
```

### RULE 5: Every job gets `timeout-minutes`; every non-reusable workflow gets `concurrency`

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

A job with no timeout burns the default 6 hours on a hang. Cancel in-progress PR runs; do
not cancel deploys. **Reusable workflows (`on: workflow_call`) do NOT set `concurrency` -
the caller does**, otherwise concurrent callers serialize on each other.

### RULE 6: Every multi-command `run:` step uses a strict shell

```yaml
defaults:
  run:
    shell: bash -euo pipefail {0}
```

or per-step: `shell: bash -euo pipefail {0}`. The runner's default `bash` is `bash -e` -
a failure inside a pipeline (`npm ci && npm test`, `cmd | grep`) is silently ignored.
This rule applies to hardening fixes too: if you touch a workflow with multi-command
steps, add `defaults.run.shell` before returning it.

## READ BEFORE YOU WRITE

| If the task involves | Read |
|---|---|
| triggers, matrix, caching, job outputs, artifacts, services, contexts, expressions | `references/workflow-syntax.md` |
| permissions, SHA pinning, OIDC to AWS/GCP/Azure, secrets, `pull_request_target`, environments, `persist-credentials`, or **any review/hardening request** | `references/security.md` |
| `workflow_call` reusable workflows, composite actions, JS actions, `action.yml`, publishing an action | `references/reusable-and-actions.md` |

These are mandatory reads, not suggestions. A hardening review answered without
`references/security.md` will miss the checklist it is graded against.

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
      - run: npm ci
      - run: npm test
```

## Quick decisions

| Situation | Do | Don't |
|---|---|---|
| Sharing whole jobs across repos | Reusable workflow (`workflow_call`) + emit a caller | Copy-paste the YAML |
| Sharing steps within a job | Composite action (`action.yml`) | Reusable workflow |
| Dependency caching (any install step) | The `setup-*` action's built-in `cache:` | Skipping cache, or hand-rolled `actions/cache` |
| `actions/cache` key | Include `runner.os` + `hashFiles('**/lock')` | A static key that never invalidates |
| Cloud credentials | OIDC + `id-token: write` + `environment:` | Static `AWS_SECRET_ACCESS_KEY` secrets |
| Step output | `echo "k=v" >> "$GITHUB_OUTPUT"` | `::set-output` (removed) |
| Test matrix | `fail-fast: false` | Default fail-fast hiding other failures |
| Matrix artifact upload | Unique `name:` per leg | One name (v4 artifacts are immutable) |
| Approval gate before deploy | `environment: production` with reviewers | `if:` on an actor name |
| Verifying your YAML | `actionlint .github/workflows/*.yml` | Eyeballing it |

## Self-check before sending

1. Every file written to disk **and** shown as a ```yaml block, complete, no elisions.
2. `.github/dependabot.yml` shipped alongside any workflow with pinned third-party actions.
3. Every non-local `uses:` on a 40-char SHA with a `# vX.Y.Z` comment.
4. Top-level `permissions:` present; `id-token: write` only on the job that needs it.
5. No `${{ github.event.* }}` or `github.head_ref` inside any `run:` or `script:`.
6. No `pull_request_target` checking out PR head; `persist-credentials: false` on any
   checkout whose job then runs contributor code.
7. `timeout-minutes` on every job; `concurrency` on every non-reusable workflow.
8. `defaults.run.shell: bash -euo pipefail {0}` (or per-step) on every multi-command run.
9. Reusable workflow requests emit BOTH the callee AND a caller workflow.
10. The relevant `references/*.md` was actually read for this task.
