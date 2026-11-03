# Workflow Syntax

Everything here assumes the output contract in SKILL.md. Each file is written to
`.github/workflows/<name>.yml` **and** shown in full as a fenced ```yaml block, and
`.github/dependabot.yml` ships alongside it.

## Triggers

| Need | `on:` |
|---|---|
| CI on PRs and the default branch | `pull_request:` + `push: {branches: [main]}` |
| Only when certain files change | `paths: ['src/**', '!**/*.md']` |
| Release on a version tag | `push: {tags: ['v*.*.*']}` |
| Manual run with parameters | `workflow_dispatch: {inputs: {...}}` |
| Nightly | `schedule: [{cron: '0 3 * * *'}]` (UTC) |
| Called by another workflow | `workflow_call:` (see `references/reusable-and-actions.md`) |
| After another workflow finishes | `workflow_run: {workflows: [CI], types: [completed]}` |

Pairing `pull_request` with `push: {branches: [main]}` does not double-run, because the push event fires
only on merge. A `pull_request` from a fork gets a read-only token and no secrets. Do not use
`pull_request_target` to work around that. Read `references/security.md` instead.

## Full CI skeleton

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
    name: test (${{ matrix.os }}, node ${{ matrix.node }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [20, 22, 24]
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Test
        run: npm test
      - uses: actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3
        if: always()
        with:
          name: test-results-${{ matrix.os }}-node${{ matrix.node }}
          path: reports/
          if-no-files-found: ignore
          retention-days: 7
```

## Matrix

- `matrix.<key>: [a, b]` produces the full cross product. Every key must be referenced in the job.
- An `include:` entry that matches an existing combination extends it. One that matches nothing appends a new job.
- `exclude:` is applied before `include`.
- Use `fail-fast: false` for test matrices.
- Use `max-parallel: N` when legs contend for a shared external resource.

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, windows-latest]
    node: [20, 22]
    include:
      - os: ubuntu-latest
        node: 24
        experimental: true
    exclude:
      - os: windows-latest
        node: 20
```

## Caching

| Ecosystem | Built-in |
|---|---|
| Node | `actions/setup-node` with `cache: npm` \| `yarn` \| `pnpm` |
| Python | `actions/setup-python` with `cache: pip` \| `poetry` |
| Go | `actions/setup-go` (on by default) |
| Java | `actions/setup-java` with `cache: maven` \| `gradle` |

For anything else, use `actions/cache`:

```yaml
- uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0
  with:
    path: ~/.cache/my-tool
    key: ${{ runner.os }}-mytool-${{ hashFiles('**/lockfile') }}
    restore-keys: |
      ${{ runner.os }}-mytool-
```

- The key must include `hashFiles(...)` of whatever invalidates the cache, plus `runner.os`.
- `restore-keys` turns a cold key into a partial hit.
- Use lockfile-based installs (`npm ci`, `pnpm install --frozen-lockfile`, `pip install -r requirements.txt` with pinned versions).
- If you are hardening a workflow and an install step has no cache, add one.

## Jobs, dependencies, outputs

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      version: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - id: meta
        name: Read version
        run: echo "version=$(cat VERSION)" >> "$GITHUB_OUTPUT"

  publish:
    needs: [build]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Publish
        run: echo "publishing $VERSION"
        env:
          VERSION: ${{ needs.build.outputs.version }}
```

- Step output: `echo "key=value" >> "$GITHUB_OUTPUT"`. The `set-output` command has been removed.
- Declare job outputs under `jobs.<id>.outputs` and read them as `needs.<id>.outputs.<name>`.
- Multi-line output uses a delimiter:
  ```bash
  {
    echo "body<<EOF"
    cat notes.md
    echo "EOF"
  } >> "$GITHUB_OUTPUT"
  ```
- Pass env to later steps with `>> "$GITHUB_ENV"`. Write a job summary with `>> "$GITHUB_STEP_SUMMARY"`.
- `if: always()`, `failure()`, and `cancelled()` let a job or step run after an upstream failure.

## Contexts and expressions

| Context | Available where | Note |
|---|---|---|
| `github.*` | everywhere | `ref`, `sha`, `event_name`, `repository` |
| `env.*` | steps, most job keys | not in job-level `if` |
| `secrets.*` | `with:`/`env:`/`if:` | never in `runs-on` |
| `needs.*` | dependent jobs | outputs of prerequisites |
| `matrix.*` | inside the job | |
| `runner.*` | steps | `os`, `temp`, `arch` |
| `steps.<id>.*` | later steps | `outputs`, `outcome`, `conclusion` |

Write `if: github.event_name == 'push'` without the `${{ }}` wrapper. Useful functions: `contains()`, `startsWith()`,
`format()`, `join()`, `hashFiles()`, `toJSON()`, `fromJSON()`. A dynamic matrix is
`matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}`.

## Artifacts and services

v4 artifacts are **immutable**, so every matrix leg needs a distinct `name`. Put `if: always()` on the upload so it
collects failure reports.

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: postgres
    ports: ['5432:5432']
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-retries 5
```

Without `--health-cmd`, steps race the container's boot.

## Shell defaults

```yaml
defaults:
  run:
    shell: bash -euo pipefail {0}
```

Without `pipefail`, `curl ... | tar x` succeeds even when curl gets a 404.
