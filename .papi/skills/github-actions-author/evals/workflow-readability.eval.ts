import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';
import { jobsOf, runOf, stepsOf, str, usesOf, workflows } from './workflow-walk.js';

const EVAL_ID = 'workflow-readability';
const EVAL_NAME = 'Workflows and their steps are named for the run log';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * Names are the interface of a failed run. Without them the Actions UI falls back
 * to rendering the script itself, so a red check leads to a job called `build` and
 * a step called `run: |\n  set -euo pipefail\n  ...` - and finding what broke means
 * reading YAML rather than the log.
 *
 * Deliberately light: this is a guard against the loop optimizing toward terse,
 * unreadable YAML because nothing else scored readability, not a style rule with
 * strong opinions. Trivial one-line steps and `uses:` steps, which the UI renders
 * legibly on their own, are not scored.
 */

/** A step whose rendered label would be a wall of script. */
function needsName(step: Record<string, unknown>): boolean {
  const script = runOf(step);
  if (!script) return false; // a `uses:` step renders as the action name
  const lines = script.split('\n').filter((l) => l.trim()).length;
  return lines > 1;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const readabilityEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable workflow YAML found - readability not evaluated.');
    }
    const wfs = workflows(docs);
    if (wfs.length === 0) {
      return result(0.5, 'No workflow files produced - readability of an action is scored by its contract instead.');
    }

    const unnamedWorkflows: string[] = [];
    const oddJobIds: string[] = [];
    const unnamedSteps: string[] = [];
    let scriptSteps = 0;

    for (const wf of wfs) {
      if (!str(wf.doc.name)) unnamedWorkflows.push(wf.path);

      for (const { id, job } of jobsOf(wf.doc)) {
        if (!KEBAB.test(id)) {
          oddJobIds.push(`${wf.path}: job id \`${id}\``);
        }
        for (const s of stepsOf(job)) {
          if (!needsName(s.step)) continue;
          scriptSteps += 1;
          if (!str(s.step.name)) {
            unnamedSteps.push(`${wf.path} job \`${id}\` (${str(usesOf(s.step)) || 'script'} step ${s.index + 1})`);
          }
        }
      }
    }

    const problems: string[] = [];
    if (unnamedWorkflows.length > 0) {
      problems.push(
        `${unnamedWorkflows.join(', ')} has no \`name:\`, so the Actions sidebar lists it by file path`,
      );
    }
    if (unnamedSteps.length > 0) {
      problems.push(
        `${unnamedSteps.length}/${scriptSteps} multi-line script step(s) have no \`name:\`, so a failure renders as the script body: ${unnamedSteps.slice(0, 3).join(', ')}${unnamedSteps.length > 3 ? ' ...' : ''}`,
      );
    }
    if (oddJobIds.length > 0) {
      problems.push(`${oddJobIds.join(', ')} is not kebab-case, unlike the rest`);
    }

    if (problems.length === 0) {
      return result(
        1.0,
        `${wfs.length} workflow(s) named, job ids kebab-case, and every multi-line script step carries a \`name:\`.`,
      );
    }

    // Named steps matter most; the rest are conventions.
    const stepScore = scriptSteps === 0 ? 1 : (scriptSteps - unnamedSteps.length) / scriptSteps;
    const score = clampScore(
      0.6 * stepScore +
        0.25 * (1 - unnamedWorkflows.length / wfs.length) +
        0.15 * (oddJobIds.length === 0 ? 1 : 0),
    );
    return result(score, `${problems.join('. ')}.`);
  },
};

export default readabilityEval;

runEval((ctx) => readabilityEval.evaluate(ctx));
