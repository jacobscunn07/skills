# Reusable Workflows and Custom Actions

## Which one to build

| You want to share | Build | Lives at |
|---|---|---|
| Whole jobs, including `runs-on`, `permissions`, `environment` | **reusable workflow** | `.github/workflows/<name>.yml` |
| A sequence of steps inside somebody else's job | **composite action** | `<dir>/action.yml` |
| Logic that needs an API client, retries, or real data structures | **JavaScript action** | `<dir>/action.yml` + `dist/` |
| A toolchain that is already a container image | **Docker action** | `<dir>/action.yml` (`using: docker`) |

Rule of thumb: if the thing you are factoring out includes `runs-on`, it is a reusable
workflow. If it is a run of steps, it is a composite action.

## Reusable workflow

```yaml
# .github/workflows/build.yml  (the reusable one)
name: Build

on:
  workflow_call:
    inputs:
      node-version:
        description: Node major version to build with
        type: string          # string | number | boolean | choice
        required: false
        default: '22'
      environment:
        type: string
        required: true
    secrets:
      NPM_TOKEN:
        required: false
    outputs:
      artifact-name:
        description: Name of the uploaded build artifact
        value: ${{ jobs.build.outputs.artifact-name }}

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: ${{ inputs.environment }}
    outputs:
      artifact-name: ${{ steps.pack.outputs.name }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: ${{ inputs.node-version }}
          cache: npm
      - run: npm ci
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - id: pack
        run: echo "name=build-${{ github.sha }}" >> "$GITHUB_OUTPUT"
```

```yaml
# .github/workflows/ci.yml  (the caller)
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

  build-shared:
    uses: my-org/workflows/.github/workflows/build.yml@<40-char-sha>   # another repo: pin it
    with: {environment: staging}
    secrets: inherit
```

Rules that bite:
- Call it with `uses:` **at job level**, not inside `steps:`.
- A calling job that has a `uses:` cannot also have `steps:`, `runs-on`, or `container`.
- Cross-repo calls are pinned like any other third-party code: full SHA, version comment.
- `secrets: inherit` passes every secret the caller has. Convenient, and the wrong default
  for a workflow you do not own - name them explicitly instead.
- The called workflow's permissions can only be **narrower** than the caller's token; it
  cannot grant itself more.
- Nesting depth is 4, and a reusable workflow cannot use a matrix over itself beyond the
  caller's own `strategy`.
- `${{ inputs.x }}` in the callee, `with:` in the caller. `env` does **not** cross the
  boundary - anything the callee needs has to be an input.

## Composite action

```yaml
# .github/actions/setup-toolchain/action.yml
name: Setup Toolchain
description: Installs the project toolchain and reports the resolved version.

inputs:
  version:
    description: Version to install, or "lts"
    required: false
    default: lts
  cache:
    description: Whether to restore the dependency cache
    required: false
    default: 'true'          # inputs are always strings, quote the booleans

outputs:
  resolved-version:
    description: The version that was actually installed
    value: ${{ steps.install.outputs.version }}

runs:
  using: composite
  steps:
    - id: install
      shell: bash              # REQUIRED on every run step in a composite action
      run: |
        set -euo pipefail
        echo "installing $VERSION"
        echo "version=$VERSION" >> "$GITHUB_OUTPUT"
      env:
        VERSION: ${{ inputs.version }}

    - if: inputs.cache == 'true'
      uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0
      with:
        path: ~/.cache/toolchain
        key: ${{ runner.os }}-toolchain-${{ steps.install.outputs.version }}
```

Used as:

```yaml
- uses: ./.github/actions/setup-toolchain
  id: toolchain
  with:
    version: '22'
- run: echo "got ${{ steps.toolchain.outputs.resolved-version }}"
```

Rules that bite:
- `shell:` is mandatory on every `run` step. Omitting it is the single most common composite
  action error, and the message is unhelpful.
- Inputs are referenced as `${{ inputs.name }}`, **not** `env.INPUT_NAME` (that form is for
  JS/Docker actions only).
- Every input value is a string. `default: 'true'` and compare with `== 'true'`.
- `secrets` are not available inside a composite action. Pass them in as inputs.
- A composite action cannot set `permissions` or `runs-on` - it inherits the calling job's.
- A local action requires `actions/checkout` to have run first, or the file is not there.
- Set `${{ github.action_path }}` when the action ships helper scripts alongside `action.yml`.

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

- `main` must point at a **bundled** file (`ncc build src/index.js -o dist`). The runner does
  not run `npm install` for you, so `node_modules` must be either committed or bundled away.
  Committing `dist/` is the norm; a CI check that rebuilds it and fails on a diff keeps it
  honest.
- Read inputs with `core.getInput('token')` (the runner exposes them as `INPUT_TOKEN`), write
  outputs with `core.setOutput`, fail with `core.setFailed`.
- Mask anything sensitive you compute: `core.setSecret(value)`.
- `pre:`/`post:` steps are how an action cleans up after itself (stopping a service,
  revoking a token).

## Publishing and versioning an action

- Tag a release `v1.2.3`, then move a floating major tag `v1` to it so consumers on `@v1`
  get the update:
  ```bash
  git tag -fa v1 -m "update v1 tag" && git push origin v1 --force
  ```
- That floating tag is exactly why consumers should be pinning to your SHA. Publish the SHA
  in the README's usage example.
- `action.yml` at the repo root is what makes the repo usable as `org/repo@ref`. An action in
  a subdirectory is used as `org/repo/path@ref`.
- Every input needs a `description` - it is what the Marketplace and the editor show.
