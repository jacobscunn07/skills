import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';
import { actionRepo, isObj, jobsOf, runOf, stepsOf, str, usesOf, workflows } from './workflow-walk.js';

const EVAL_ID = 'environment-approval-gate';
const EVAL_NAME = 'Deploys gate on an environment, not on a condition';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * "Someone approves it first" has exactly one implementation on GitHub: an
 * `environment:` with required reviewers. The job then pauses and waits for a
 * human.
 *
 * `if: github.actor == '...'` is not an approval. It is a condition evaluated
 * against whoever triggered the run - nobody is asked anything, the job proceeds
 * unattended, and on several trigger types `github.actor` is not the person who
 * caused the change. An environment also scopes the deployment secrets and is
 * what an OIDC trust policy can key on.
 */

/** Contexts people reach for when hand-rolling an approval. */
const PSEUDO_GATE = /github\.(?:actor|triggering_actor)\b|github\.event\.sender\.login/;

const DEPLOYING = /deploy|release|publish|promote|rollout/i;

/** Steps that actually push something outward. */
function deploysSomething(job: Record<string, unknown>): boolean {
  for (const s of stepsOf(job)) {
    const repo = actionRepo(usesOf(s.step));
    if (/deploy|pages|npm-publish|docker\/build-push/i.test(repo)) return true;
    if (/\b(?:aws\s+s3\s+sync|aws\s+deploy|kubectl\s+apply|helm\s+upgrade|terraform\s+apply|npm\s+publish|docker\s+push|gh\s+release\s+create|serverless\s+deploy)\b/.test(runOf(s.step))) {
      return true;
    }
  }
  return false;
}

const environmentGateEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable workflow YAML found - approval gating not evaluated.');
    }

    const gated: string[] = [];
    const pseudo: string[] = [];
    const ungated: string[] = [];

    for (const wf of workflows(docs)) {
      for (const { id, job } of jobsOf(wf.doc)) {
        const looksDeploy = DEPLOYING.test(`${id} ${str(job.name)}`) || deploysSomething(job);
        if (!looksDeploy) continue;

        const where = `${wf.path} job \`${id}\``;
        const hasEnvironment = job.environment !== undefined;
        const condition = str(job.if);

        if (hasEnvironment) {
          gated.push(where);
          continue;
        }
        if (PSEUDO_GATE.test(condition)) {
          pseudo.push(`${where}: \`if: ${condition.trim().slice(0, 60)}\``);
        } else {
          ungated.push(where);
        }
      }
    }

    if (gated.length === 0 && pseudo.length === 0 && ungated.length === 0) {
      return result(0.5, 'No deploying job found - nothing to gate.');
    }

    if (pseudo.length > 0) {
      return result(
        clampScore(0.2),
        `${pseudo.join('; ')} gates a deploy on who triggered the run. That is a condition, not an approval - nobody is prompted and the job proceeds unattended. Use \`environment:\` with required reviewers.`,
      );
    }

    if (ungated.length > 0) {
      const score = clampScore(gated.length / (gated.length + ungated.length) || 0.4);
      return result(
        Math.min(score, 0.6),
        `${ungated.join(', ')} deploy(s) with no \`environment:\` - there is no approval step and the deployment secrets are not scoped. Add an environment with required reviewers.`,
      );
    }

    return result(
      1.0,
      `${gated.join(', ')} gate on an \`environment:\`, which is where required reviewers, deployment secrets, and OIDC trust-policy scoping all attach.`,
    );
  },
};

export default environmentGateEval;

runEval((ctx) => environmentGateEval.evaluate(ctx));
