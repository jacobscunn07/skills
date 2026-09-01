# github-actions-author

A Claude Code skill for writing, reviewing, and hardening GitHub Actions workflows and
custom actions.

## Usage

Once installed, the skill activates automatically when you ask Claude Code about GitHub
Actions. You can also invoke it explicitly:

```
/github-actions-author
```

## What it covers

- Workflow authoring: triggers, jobs, matrix builds, caching, artifacts, service containers
- Supply-chain hardening: SHA-pinned actions, least-privilege `permissions`, script-injection
  avoidance, `pull_request_target` rules
- Cloud deploys via OIDC instead of long-lived credentials, gated on environments
- Reusable workflows (`workflow_call`) and custom composite / JavaScript actions
- Reviewing and fixing an existing workflow in place

## Structure

`SKILL.md` is a router: the output contract, the five non-negotiable rules, and a table
pointing at the reference file for the task at hand. Depth lives in `references/`:

| File | Covers |
|---|---|
| `references/workflow-syntax.md` | triggers, matrix, caching, outputs, contexts, artifacts |
| `references/security.md` | pinning, permissions, injection, `pull_request_target`, OIDC |
| `references/reusable-and-actions.md` | `workflow_call`, composite actions, JS actions |

## Self-improvement

This skill is improved by the papi autoresearch loop in this monorepo. Its test scenarios and
evals live in [`.papi/skills/github-actions-author/`](../../.papi/skills/github-actions-author/).

```bash
papi run github-actions-author --iterations 20 --budget 5.0
```
