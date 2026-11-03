# Workflow Security

SKILL.md holds the non-negotiable rules. This file has the reasoning and worked patterns behind them.

## 1. Pin third-party actions to a full commit SHA

`uses: some/action@v4` resolves a **mutable tag**. Whoever controls that repo can repoint
`v4` at new code, and that code runs with your `GITHUB_TOKEN` and secrets. The
`tj-actions/changed-files` compromise worked exactly this way.

```yaml
# WRONG - mutable
- uses: actions/checkout@v4

# RIGHT - immutable, with the human-readable version alongside
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

Dependabot reads the trailing `# vX.Y.Z` comment. **Never invent a SHA**:

```bash
gh api repos/actions/checkout/commits/v4.2.2 --jq .sha
```

To pin a whole file: `pinact run` or `ratchet pin .github/workflows/ci.yml`.

## 1b. Dependabot is required

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule: {interval: weekly}
    groups:
      actions:
        patterns: ['*']
```

Add one entry per package ecosystem you use (`npm`, `pip`, `docker`).
Exempt from pinning: local `./.github/actions/<name>`. For `docker://image@sha256:<digest>`, pin the digest.

## 2. Least-privilege `permissions`

```yaml
permissions:
  contents: read          # workflow-wide floor

jobs:
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
| upload SARIF | `security-events: write` |
| assume a cloud role via OIDC | `id-token: write` |
| Pages deploy | `pages: write` + `id-token: write` |

The block is **exhaustive**. A job that declares only `id-token: write` cannot check out the
repo, so it needs `contents: read` too. Both `write-all` and a top-level `{}` are wrong.

## 3. Never interpolate untrusted input into a shell

```yaml
# WRONG - script injection
- run: echo "PR ${{ github.event.pull_request.title }}"

# RIGHT
- run: echo "PR $PR_TITLE"
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
```

These values are attacker-controlled: `github.event.pull_request.title`, `.body`, `.head.ref`,
`.head.label`, `github.head_ref`, `github.event.issue.title`, `.body`,
`github.event.comment.body`, `github.event.review.body`, `github.event.commits.*.message`,
`github.event.commits.*.author.email`, `github.event.discussion.*`, and any label or branch
name a contributor can set. The same applies inside `actions/github-script`. Read
`context.payload` instead.

Safe as-is: `github.sha`, `github.repository`, `github.run_id`, `github.actor`,
`github.event_name`.

## 4. `pull_request_target` is a loaded gun

`pull_request_target` runs the workflow from the base branch with a read-write token and secrets, even for
fork PRs. It is safe only when the job never executes fork code.

```yaml
# WRONG - runs attacker code with a write token
on: pull_request_target
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: npm ci && npm test
```

- Default to `pull_request`.
- Use `pull_request_target` only for jobs that touch no PR content, such as labelling or greeting.
- If fork code must be built with secrets, split the work. An unprivileged `pull_request` job uploads
  an artifact, and a `workflow_run` job consumes it as data and never executes it.

## 4b. `persist-credentials: false`

By default, `actions/checkout` writes `GITHUB_TOKEN` into `.git/config`, where any code that runs later in the job can
read it. Set `persist-credentials: false` on every CI checkout. Omit it only when a
later step needs to `git push` with the workflow token.

## OIDC instead of long-lived cloud keys

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4.0.2
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
      - name: Verify identity
        run: aws sts get-caller-identity
```

- `id-token: write` goes on the deploying job only.
- The trust policy's `sub` condition pins both the repo **and** the ref or environment:
  `repo:org/repo:environment:production` or `repo:org/repo:ref:refs/heads/main`. Never use
  `repo:org/repo:*`.
- Azure: use `azure/login` with `client-id`/`tenant-id`/`subscription-id` and no `creds:`. GCP: use
  `google-github-actions/auth` with `workload_identity_provider`.

## Environments and approvals

```yaml
environment:
  name: production
  url: https://example.com
```

This gives you required reviewers, a wait timer, branch restrictions, and secrets scoped to the environment. It is the only
approval gate Actions has.

## Secret handling

- Masking works by exact match only. Derived values, such as base64 or a substring, print in the clear.
- Never `echo` a secret or pass it as a CLI argument. Use step-level `env:`.
- Fork PRs never receive secrets.
- Give each secret only to the step that needs it, by putting `env:` on the step rather than the job.

## Hardening checklist for a review

Fix every item, then write the corrected file in place **and** paste it in full as a
```yaml block, followed by an itemized change log.

1. Every non-local `uses:` is on a 40-character SHA with a version comment.
2. `.github/dependabot.yml` exists. Create it if the repo lacks one.
3. There is an explicit workflow-level `permissions` floor, widened per job only where needed.
4. No attacker-controlled `${{ }}` appears inside `run:` or `script:`.
5. There is no `pull_request_target`. If it is present, nothing checks out or runs PR code.
6. Every `actions/checkout` sets `persist-credentials: false`, unless a later step pushes with the token.
7. Every job has `timeout-minutes`.
8. Every workflow sets `concurrency`. A reusable callee uses a suffixed group. `cancel-in-progress`
   is on only where cancelling is safe.
9. `defaults.run.shell: bash -euo pipefail {0}` is set.
10. Every install step is cached and lockfile-based (`npm ci`, `cache: npm`).
11. Deploy jobs use OIDC and an `environment`, not static cloud keys.
12. The workflow has a `name:`, job ids are kebab-case, and every multi-line step has a `name:`.
