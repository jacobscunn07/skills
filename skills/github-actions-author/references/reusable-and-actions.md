# Reusable Workflows and Custom Actions

## Which one to build

| You want to share | Build | Lives at |
|---|---|---|
| Whole jobs, including `runs-on`, `permissions`, `environment` | **reusable workflow** | `.github/workflows/<name>.yml` |
| A sequence of steps inside somebody else's job | **composite action** | `<dir>/action.yml` |
| Logic that needs an API client, retries, or real data structures | **JavaScript action** | `<dir>/action.yml` + `dist/` |
| A toolchain that is already a container image | **Docker action** | `<dir>/action.yml` (`using: docker`) |

Rule of thumb: anything you factor out that includes `runs-on` is a reusable workflow. A
sequence of steps is a composite action.

## Reusable workflow - ALWAYS emit a caller alongside

A request for a reusable workflow gets **two files**: the callee and at least one caller.
A reusable workflow that nothing calls has never been tested.

```yaml
# .github/workflows/build.yml  (the reusable callee)
name: Build

on:
  workflow_call:
    inputs:
      node-version:
        description: Node major version to build with
        type: string          # string | number | boolean
        required: false
        default: '22'
      environment:
        description: Deployment environment the build targets
        type: string
        required: true
    secrets:
      NPM_TOKEN:
        description: Token for the private npm registry
        required: false
    outputs:
      artifact-name:
        description: Name of the uploaded build artifact
        value: ${{ jobs.build.outputs.artifact-name }}

permissions:
  contents: read

# The callee gets its own concurrency group. github.workflow resolves to the CALLER's
# name here, so the suffix keeps this group distinct from the caller's own group.
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}-build-${{ inputs.environment }}
  cancel-in-progress: false

defaults:
  run:
    shell: bash -euo pipefail {0}

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: ${{ inputs.environment }}
    outputs:
      artifact-name: ${{ steps.pack.outputs.name }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: ${{ inputs.node-version }}
          cache: npm
      - name: Install dependencies
        run: npm ci
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - name: Build
        run: npm run build
      - id: pack
        name: Name the artifact
        run: echo "name=build-${GITHUB_SHA}" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3
        with:
          name: ${{ steps.pack.outputs.name }}
          path: dist/
          retention-days: 7
```

```yaml
# .github/workflows/ci.yml  (the caller - REQUIRED, always emit it)
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
  build:
    uses: ./.github/workflows/build.yml          # same repo
    with:
      node-version: '22'
      environment: staging
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
    permissions:
      contents: read

  report:
    needs: [build]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Show artifact name
        run: echo "built $ARTIFACT"
        env:
          ARTIFACT: ${{ needs.build.outputs.artifact-name }}
```

Cross-repo call: `uses: my-org/workflows/.github/workflows/build.yml@<40-char-sha> # v1.2.0`.

Rules that bite:
- Call a reusable workflow with `uses:` **at job level**, not inside `steps:`.
- A job that has `uses:` cannot also have `steps:`, `runs-on`, or `container`.
- Pin cross-repo calls like any other third-party code: full SHA plus a version comment.
- `secrets: inherit` passes every secret the caller has. That is the wrong default for a
  workflow you do not own. Name the secrets explicitly instead.
- The callee's permissions can only be **narrower** than the caller's token.
- Workflows nest at most 4 levels deep.
- Use `${{ inputs.x }}` in the callee and `with:` in the caller. `env` does **not** cross the
  boundary.
- Every input, secret, and output gets a `description`. Wire every output through
  `jobs.<id>.outputs` to a step that writes `$GITHUB_OUTPUT`, and have the caller consume it.
- **Both files get `concurrency`**. Use the caller's normal group. Give the callee a group with
  a distinct suffix so it never collides with the caller's.

## Composite action

```yaml
# .github/actions/setup-toolchain/action.yml
name: Setup Toolchain
description: Installs Node, restores the npm cache, installs dependencies, and reports what it resolved.

inputs:
  node-version:
    description: Node version to install
    required: false
    default: '22'
  install:
    description: Whether to run npm ci
    required: false
    default: 'true'          # inputs are always strings, so quote the booleans

outputs:
  node-version:
    description: The Node version actually installed
    value: ${{ steps.setup.outputs.node-version }}
  cache-hit:
    description: Whether node_modules was restored from cache
    value: ${{ steps.cache.outputs.cache-hit }}     # EVERY output needs a value: wired to an id'd step

runs:
  using: composite
  steps:
    - id: setup
      uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
      with:
        node-version: ${{ inputs.node-version }}

    - id: cache
      uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0
      with:
        path: node_modules
        key: ${{ runner.os }}-node-${{ steps.setup.outputs.node-version }}-${{ hashFiles('**/package-lock.json') }}
        restore-keys: |
          ${{ runner.os }}-node-${{ steps.setup.outputs.node-version }}-

    - name: Install dependencies
      if: inputs.install == 'true' && steps.cache.outputs.cache-hit != 'true'
      shell: bash              # REQUIRED on every run step in a composite action
      run: |
        set -euo pipefail
        npm ci
        echo "installed with node $NODE_VERSION"
      env:
        NODE_VERSION: ${{ steps.setup.outputs.node-version }}
```

Used as:

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
  with:
    persist-credentials: false
- uses: ./.github/actions/setup-toolchain
  id: toolchain
  with:
    node-version: '22'
- name: Report toolchain
  run: echo "node $NODE_VERSION, cache hit $CACHE_HIT"
  env:
    NODE_VERSION: ${{ steps.toolchain.outputs.node-version }}
    CACHE_HIT: ${{ steps.toolchain.outputs.cache-hit }}
```

Rules that bite:
- **Every declared output needs `value: ${{ steps.<id>.outputs.<key> }}`**. The referenced step
  must have that `id:` and either write the key to `$GITHUB_OUTPUT` or be an action that
  exposes it. An output without `value:` is always empty.
- `shell:` is mandatory on every `run` step. Use `shell: bash` and make `set -euo pipefail`
  the first line of the script.
- Reference inputs as `${{ inputs.name }}` and pass them to scripts through `env:`. Do not
  write `env.INPUT_NAME`, which is a JS/Docker convention.
- Every input value is a string, so compare with `== 'true'`.
- `secrets` are not available inside a composite action. Pass them in as inputs.
- A composite action cannot set `permissions` or `runs-on`.
- A local action needs `actions/checkout` to run first.
- Helper scripts that ship next to `action.yml` are addressed through `${{ github.action_path }}`, and
  each one must be written out in full in the reply.

## JavaScript action

```yaml
# action.yml
name: My Action
description: Does the thing.
author: my-org

inputs:
  token:
    description: GitHub token
    required: true

outputs:
  result:
    description: What came back

runs:
  using: node24            # node20 is deprecated; node24 is current
  main: dist/index.js
  post: dist/cleanup.js    # optional, runs at job end even on failure

branding:
  icon: check-circle
  color: green
```

- `main` points at a **bundled** file (`ncc build src/index.js -o dist`). Commit `dist/`, and
  add a CI check that rebuilds it and fails on a diff.
- Read inputs with `core.getInput('token')`, set outputs with `core.setOutput`, and fail with `core.setFailed`.
- Mask anything sensitive you compute with `core.setSecret(value)`.

## Publishing and versioning an action

- Tag `v1.2.3`, then move the floating `v1` tag to it:
  `git tag -fa v1 -m "update v1 tag" && git push origin v1 --force`.
- Publish the SHA in the README usage example, because consumers should pin to it.
- An `action.yml` at the repo root makes the action usable as `org/repo@ref`. An action in a
  subdirectory is `org/repo/path@ref`.
- Every input needs a `description`.
