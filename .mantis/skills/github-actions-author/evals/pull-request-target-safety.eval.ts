import type { Eval, EvalContext, EvalResult } from './types.js';
import { makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';
import {
  actionRepo,
  interpolations,
  jobsOf,
  runOf,
  stepsOf,
  str,
  triggersOf,
  usesOf,
  withOf,
  workflows,
  type Job,
  type Step,
} from './workflow-walk.js';

const EVAL_ID = 'pull-request-target-safety';
const EVAL_NAME = '`pull_request_target` does not check out or run PR code';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * `pull_request_target` runs in the context of the base repository: it gets the
 * repository's secrets and a write-scoped token, and - unlike `pull_request` -
 * a fork's changes do not sandbox it. Checking out the PR head under that
 * trigger hands an attacker's code both. That is the whole of Rule 4.
 *
 * The trigger itself is legitimate for jobs that touch no PR content (labelling,
 * greeting a first-time contributor), so its presence alone is not the finding.
 * The finding is the combination: privileged trigger + PR-controlled checkout,
 * and worse again when the job then executes what it checked out.
 */

/** Refs that resolve to code the PR author controls. */
const PR_CONTROLLED_REF = [
  /github\.event\.pull_request\.head\.(?:sha|ref)/,
  /github\.event\.pull_request\.merge_commit_sha/,
  /github\.head_ref\b/,
  /refs\/pull\//,
];

function isPrControlledRef(value: string): boolean {
  return PR_CONTROLLED_REF.some((re) => re.test(value));
}

function isCheckout(step: Record<string, unknown>): boolean {
  return actionRepo(usesOf(step)) === 'actions/checkout';
}

/** A checkout that lands PR-authored code in the workspace. */
function checksOutPrCode(step: Record<string, unknown>): boolean {
  if (!isCheckout(step)) return false;
  const w = withOf(step);
  const ref = str(w.ref);
  const repo = str(w.repository);
  if (ref && isPrControlledRef(ref)) return true;
  // `repository: <the fork>` is the other route to the same place.
  return repo !== '' && interpolations(repo).some((e) => /pull_request\.head\.repo/.test(e));
}

/**
 * Whether the job runs what is in the workspace. A `run:` step is the direct
 * case; a local `./...` action is the same thing one level of indirection away,
 * since its own definition came out of the checkout.
 */
function executesWorkspace(steps: Step[]): boolean {
  return steps.some((s) => runOf(s.step).trim() !== '' || usesOf(s.step).startsWith('./'));
}

/**
 * Checklist item 8: `actions/checkout` leaves the token in `.git/config` unless
 * told not to, so anything the job runs afterwards can read it. This matters
 * wherever a job builds or tests contributed code, not only under
 * `pull_request_target`, so it is scored on every PR-triggered workflow.
 */
function leaksCredentials(steps: Step[]): boolean {
  const checkouts = steps.filter((s) => isCheckout(s.step));
  if (checkouts.length === 0 || !executesWorkspace(steps)) return false;
  return checkouts.some((s) => str(withOf(s.step)['persist-credentials']) !== 'false');
}

interface Finding {
  file: string;
  job: string;
  step: string;
}

const prTargetSafetyEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable workflow YAML found - trigger safety not evaluated.');
    }
    const wfs = workflows(docs);
    if (wfs.length === 0) {
      return result(0.5, 'No workflow files produced - only action metadata, which declares no triggers.');
    }

    const privileged: string[] = [];
    const prTriggered: string[] = [];
    const checkoutFindings: Finding[] = [];
    const executingJobs: Finding[] = [];
    const credentialLeaks: Finding[] = [];

    for (const wf of wfs) {
      const triggers = triggersOf(wf.doc);
      const isPrivileged = triggers.includes('pull_request_target');
      const isPr = isPrivileged || triggers.includes('pull_request');
      if (isPrivileged) privileged.push(wf.path);
      if (isPr) prTriggered.push(wf.path);

      for (const { id, job } of jobsOf(wf.doc) as Job[]) {
        const steps = stepsOf(job);
        if (isPrivileged) {
          for (const s of steps) {
            if (!checksOutPrCode(s.step)) continue;
            checkoutFindings.push({ file: wf.path, job: id, step: s.label });
            if (executesWorkspace(steps)) {
              executingJobs.push({ file: wf.path, job: id, step: s.label });
            }
          }
        }
        if (isPr && leaksCredentials(steps)) {
          credentialLeaks.push({ file: wf.path, job: id, step: 'actions/checkout' });
        }
      }
    }

    const where = (f: Finding[]) =>
      [...new Set(f.map((x) => `${x.file} job \`${x.job}\``))].join(', ');

    if (executingJobs.length > 0) {
      return result(
        0.0,
        `${where(executingJobs)} runs under \`pull_request_target\`, checks out PR-controlled code, ` +
          `and then executes it - an attacker's fork gets the repository's secrets and a write token. ` +
          `Use \`pull_request\` for anything that builds or tests contributed code; if privileged work is ` +
          `genuinely needed, split it: \`pull_request\` builds and uploads an artifact, \`workflow_run\` consumes it.`,
      );
    }

    if (checkoutFindings.length > 0) {
      return result(
        0.2,
        `${where(checkoutFindings)} checks out PR-controlled code under \`pull_request_target\`. ` +
          `Nothing in the job appears to execute it, but the code is in the workspace with secrets present ` +
          `and one added step makes it exploitable. Switch the trigger to \`pull_request\`.`,
      );
    }

    if (credentialLeaks.length > 0) {
      return result(
        0.85,
        `Triggers are safe, but ${where(credentialLeaks)} checks out and then runs contributed code without ` +
          `\`persist-credentials: false\` - the token stays in \`.git/config\` for that code to read.`,
      );
    }

    if (privileged.length > 0) {
      return result(
        0.9,
        `\`pull_request_target\` is used in ${privileged.join(', ')} but checks out no PR code, which is the ` +
          `supported use. Confirm the job touches no contributed content at all.`,
      );
    }

    if (prTriggered.length === 0) {
      return result(
        1.0,
        `No PR-triggered workflow among ${wfs.length} file(s) - \`pull_request_target\` is not used.`,
      );
    }
    return result(
      1.0,
      `${prTriggered.length} PR-triggered workflow(s) use \`pull_request\`, not \`pull_request_target\`, ` +
        `and no job leaves the checkout token readable by the code it runs.`,
    );
  },
};

export default prTargetSafetyEval;

runEval((ctx) => prTargetSafetyEval.evaluate(ctx));
