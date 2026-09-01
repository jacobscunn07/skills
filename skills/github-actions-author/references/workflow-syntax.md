# Workflow Syntax

Everything here assumes the output contract in SKILL.md: the file is written to
`.github/workflows/<name>.yml` **and** emitted as a fenced ```yaml block.

## Triggers

| Need | `on:` |
|---|---|
| CI on PRs and the default branch | `pull_request:` + `push: {branches: [main]}` |
| Only when certain files change | `paths: ['src/**', '!**/*.md']` |
| Release on a version tag | `push: {tags: ['v*.*.*']}` |
| Manual run with parameters | `workflow_dispatch: {inputs: {...}}` |
| Nightly | `schedule: [{cron: '0 3 * * *'}]` (UTC, no guaranteed start minute) |
| Called by another workflow | `workflow_call:` (see `references/reusable-and-actions.md`) |
| After another workflow finishes | `workflow_run: {workflows: [CI], types: [completed]}` |

`push` and `pull_request` on the same workflow double-runs a PR from the same repo. Filter
with `if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main'`, or list
only `pull_request` plus `push: {branches: [main]}` as above (that pair does not double-run:
the push event only fires on merge).

`pull_request` from a fork gets a **read-only** `GITHUB_TOKEN` and no secrets. That is the
correct default. Do not reach for `pull_request_target` to work around it - read
`references/security.md` first.

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

jobs:
  test:
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [20, 22, 24]
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm test
```

`cancel-in-progress: true` on `main` throws away pushes that were mid-deploy. Gate it on the
event as above, or set it to `true` only for PR workflows.

## Matrix

- `matrix.<key>: [a, b]` - full cross product of every key.
- `include:` adds or extends combinations. An `include` entry whose keys match an existing
  combination **adds fields to it**; one that does not match **appends a new job**.
- `exclude:` removes combinations from the cross product; it is applied before `include`.
- `fail-fast: true` (the default) kills every sibling on the first failure. Set `false` for
  test matrices, where you want to see all failures at once.
- `max-parallel: N` when the jobs contend over a shared external resource.

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

Prefer the built-in cache of the `setup-*` action - it knows the lockfile and the cache
paths already:

| Ecosystem | Built-in |
|---|---|
| Node | `actions/setup-node` with `cache: npm` \| `yarn` \| `pnpm` |
| Python | `actions/setup-python` with `cache: pip` \| `poetry` |
| Go | `actions/setup-go` (module + build cache on by default) |
| Java | `actions/setup-java` with `cache: maven` \| `gradle` |

Reach for `actions/cache` only for something the setup action does not cover:

```yaml
- uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0
  with:
    path: ~/.cache/my-tool
    key: ${{ runner.os }}-mytool-${{ hashFiles('**/lockfile') }}
    restore-keys: |
      ${{ runner.os }}-mytool-
```

- The `key` must contain a hash of whatever invalidates the cache. A key without
  `hashFiles(...)` never invalidates and silently serves stale content forever.
- `restore-keys` is the prefix fallback chain - it makes a cold key a partial hit rather
  than a miss.
- Include `${{ runner.os }}`: caches are not portable across runner images.
- Caches are immutable once written and scoped per branch, with reads falling back to the
  default branch. A PR cannot poison main's cache, but it can read it.

## Jobs, dependencies, outputs

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      version: ${{ steps.meta.outputs.version }}
    steps:
      - id: meta
        run: echo "version=$(cat VERSION)" >> "$GITHUB_OUTPUT"

  publish:
    needs: [build]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: echo "publishing ${{ needs.build.outputs.version }}"
```

- Step output: `echo "key=value" >> "$GITHUB_OUTPUT"`. The `set-output` command is removed.
- Job output: declare it under `jobs.<id>.outputs`, read it as `needs.<id>.outputs.<name>`.
- Multi-line output needs a delimiter:
  ```bash
  {
    echo "body<<EOF"
    cat notes.md
    echo "EOF"
  } >> "$GITHUB_OUTPUT"
  ```
- Env for later steps: `echo "KEY=value" >> "$GITHUB_ENV"`. Summary: `>> "$GITHUB_STEP_SUMMARY"`.
- A matrix job used in `needs` gates on **all** its combinations finishing.
- `if: always()` / `if: failure()` / `if: cancelled()` re-enable a job or step after a
  failure upstream. `if: success()` is the implicit default.

## Contexts and expressions

| Context | Available where | Note |
|---|---|---|
| `github.*` | everywhere | `github.ref`, `github.sha`, `github.event_name`, `github.repository` |
| `env.*` | steps, most job keys | not in `jobs.<id>.if` at the job level |
| `secrets.*` | `with:`/`env:`/`if:` on jobs and steps | never in `runs-on` |
| `needs.*` | dependent jobs | outputs of prerequisites |
| `matrix.*` | inside the job | |
| `runner.*` | steps | `runner.os`, `runner.temp`, `runner.arch` |
| `steps.<id>.*` | later steps of the same job | `outputs`, `outcome`, `conclusion` |

`if:` is already an expression - write `if: github.event_name == 'push'`, not
`if: ${{ ... }}`. Both work; the bare form is the convention.

Useful functions: `contains()`, `startsWith()`, `endsWith()`, `format()`, `join()`,
`hashFiles()`, `toJSON()`, `fromJSON()`. `fromJSON` is how a matrix gets built dynamically
from a previous job's output: `matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}`.

## Artifacts and services

```yaml
- uses: actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3
  if: always()
  with:
    name: test-results-${{ matrix.os }}-${{ matrix.node }}
    path: reports/
    retention-days: 7
```

v4 artifacts are **immutable**: every matrix leg must upload under a distinct `name`, or the
second upload fails. `if: always()` is what makes failure artifacts actually get collected.

Service containers for integration tests:

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

Without a `--health-cmd`, steps start racing the container's boot.

## Shell defaults

```yaml
defaults:
  run:
    shell: bash
```

`bash` on the runner means `bash -e` (not `-o pipefail`). For any pipeline whose first
command can fail, set it explicitly:

```yaml
defaults:
  run:
    shell: bash -euo pipefail {0}
```
