import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows, type WorkflowDoc } from './workflow-json.js';
import { isObj, jobsOf, str, triggersOf, workflows } from './workflow-walk.js';

const EVAL_ID = 'timeouts-and-concurrency';
const EVAL_NAME = 'Every job bounds its runtime; every workflow bounds its concurrency';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * Rule 5, which is two independent failures with the same cause - an unbounded
 * workflow:
 *
 *   - no `timeout-minutes`: a hung job holds a runner for the default 6 hours.
 *   - no `concurrency`: every push to a branch starts another full run, and the
 *     stale ones keep going.
 *
 * `cancel-in-progress` is the part that needs judgment rather than a presence
 * check. Cancelling superseded PR runs is the point of the feature; cancelling a
 * half-finished deploy leaves whatever it was releasing in an unknown state, so
 * a deploy workflow should queue rather than cancel.
 */

/** A job that delegates to a reusable workflow. `timeout-minutes` is not valid on one. */
function isCall(job: Record<string, unknown>): boolean {
  return str(job.uses) !== '';
}

function isPrTriggered(doc: Record<string, unknown>): boolean {
  const triggers = triggersOf(doc);
  return triggers.includes('pull_request') || triggers.includes('pull_request_target');
}

/**
 * Whether a run of this workflow is one that must be allowed to finish.
 *
 * A PR run is never that: superseding it is the whole point of cancelling, and a
 * PR preview deploy is still a PR run - tearing it down when the author pushes
 * again is correct. What must not be cancelled is a release: a tag push, a
 * `release` event, a deliberate dispatch. So a PR trigger disqualifies the
 * workflow here, and a workflow carrying both needs `cancel-in-progress` gated on
 * the event rather than set flat.
 */
function isDeployWorkflow(doc: Record<string, unknown>): boolean {
  const triggers = triggersOf(doc);
  if (triggers.includes('release')) return true;
  const on = doc.on;
  if (isObj(on) && isObj(on.push) && on.push.tags !== undefined) return true;
  // An `environment:` is the approval gate a deploy goes through; nothing else
  // uses it. On a PR-triggered workflow it means a preview, which may be cancelled.
  if (!isPrTriggered(doc) && jobsOf(doc).some(({ job }) => job.environment !== undefined)) {
    return true;
  }
  return (
    !isPrTriggered(doc) &&
    jobsOf(doc).some(({ id, job }) => /deploy|release|publish|promote/i.test(`${id} ${str(job.name)}`))
  );
}

interface Concurrency {
  score: number;
  note: string;
}

function scoreConcurrency(wf: WorkflowDoc): Concurrency {
  const c = wf.doc.concurrency;
  if (c === undefined) {
    return { score: 0, note: `${wf.path}: no \`concurrency\` - every push starts another full run` };
  }

  // The shorthand `concurrency: <group>` is a bare string; the mapping form
  // carries `cancel-in-progress` alongside.
  const group = typeof c === 'string' ? c : isObj(c) ? str(c.group) : '';
  const cancelRaw = isObj(c) ? c['cancel-in-progress'] : undefined;

  if (!group) {
    return { score: 0.2, note: `${wf.path}: \`concurrency\` has no usable \`group\`` };
  }
  // A group with no expression is one bucket for the whole repository, so
  // unrelated branches serialize behind each other.
  if (!group.includes('${{')) {
    return {
      score: 0.4,
      note: `${wf.path}: \`concurrency.group\` is the constant \`${group}\` - every branch shares one queue. Key it on \`github.workflow\` and \`github.ref\``,
    };
  }

  // Both kinds of trigger in one file: the flat `true` would cancel releases too.
  const deploy = isDeployWorkflow(wf.doc) && !isPrTriggered(wf.doc);
  const mixed = isDeployWorkflow(wf.doc) && isPrTriggered(wf.doc);
  const cancelsAlways = cancelRaw === true || str(cancelRaw).trim() === 'true';
  const gated = typeof cancelRaw === 'string' && cancelRaw.includes('${{');

  if (mixed && cancelsAlways) {
    return {
      score: 0.7,
      note: `${wf.path}: triggers both PR and release runs but cancels unconditionally - gate it, e.g. \`cancel-in-progress: \${{ github.event_name == 'pull_request' }}\``,
    };
  }
  if (deploy && cancelsAlways) {
    return {
      score: 0.5,
      note: `${wf.path}: \`cancel-in-progress: true\` on a deploy workflow - a release cancelled midway leaves the target half-updated. Let deploys queue`,
    };
  }
  if (!deploy && cancelRaw === undefined) {
    return {
      score: 0.8,
      note: `${wf.path}: \`concurrency\` set but no \`cancel-in-progress\` - superseded PR runs keep burning runners`,
    };
  }
  const how = gated ? 'gated by an expression' : `\`${str(cancelRaw) || 'unset'}\``;
  return { score: 1, note: `${wf.path}: grouped per ref, cancel ${how}` };
}

const timeoutsAndConcurrencyEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable workflow YAML found - timeouts and concurrency not evaluated.');
    }
    const wfs = workflows(docs);
    if (wfs.length === 0) {
      return result(0.5, 'No workflow files produced - an action declares neither timeouts nor concurrency.');
    }

    const missingTimeout: string[] = [];
    let eligible = 0;

    for (const wf of wfs) {
      for (const { id, job } of jobsOf(wf.doc)) {
        if (isCall(job)) continue; // `timeout-minutes` is rejected on a `uses:` job
        eligible += 1;
        if (job['timeout-minutes'] === undefined) missingTimeout.push(`${wf.path} job \`${id}\``);
      }
    }

    const timeoutScore = eligible === 0 ? 1 : (eligible - missingTimeout.length) / eligible;

    const concurrency = wfs.map(scoreConcurrency);
    const concurrencyScore =
      concurrency.reduce((sum, c) => sum + c.score, 0) / concurrency.length;

    const score = clampScore(0.5 * timeoutScore + 0.5 * concurrencyScore);

    const problems = concurrency.filter((c) => c.score < 1).map((c) => c.note);
    if (missingTimeout.length > 0) {
      problems.unshift(
        `${missingTimeout.length}/${eligible} job(s) have no \`timeout-minutes\` (${missingTimeout.join(', ')}) - a hang holds the runner for the default 6 hours`,
      );
    }

    if (problems.length === 0) {
      return result(
        1.0,
        `All ${eligible} job(s) bound by \`timeout-minutes\`; ${wfs.length} workflow(s) grouped by \`concurrency\`. ${concurrency.map((c) => c.note).join('; ')}.`,
      );
    }
    return result(score, problems.join('. ') + '.');
  },
};

export default timeoutsAndConcurrencyEval;

runEval((ctx) => timeoutsAndConcurrencyEval.evaluate(ctx));
