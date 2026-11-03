import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows, type WorkflowDoc } from './workflow-json.js';
import { actionSteps, isObj, jobsOf, runOf, stepsOf, str } from './workflow-walk.js';

const EVAL_ID = 'shell-strictness';
const EVAL_NAME = 'Multi-command scripts fail on the first error and on a broken pipe';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * The distinction this scores is easy to get backwards.
 *
 * With no `shell:`, a Linux `run:` uses `bash -e {0}`: it stops on a failing
 * command, but a failure part-way through a *pipeline* is invisible, because the
 * exit status is the last command's. `foo | tee log` succeeds when `foo` dies.
 *
 * Naming the shell explicitly changes that: `shell: bash` is
 * `bash --noprofile --norc -eo pipefail {0}`, which does catch the pipeline. So
 * an explicit `shell: bash` is already correct, and the skill's
 * `bash -euo pipefail {0}` adds `-u` on top, catching unset variables.
 *
 * A single-command step is unaffected either way and is not scored.
 */

/** More than one command, or a pipeline - the cases where the difference shows. */
function isMultiCommand(code: string): boolean {
  const lines = code
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length > 1) return true;
  return lines.some((l) => /\|(?!\|)/.test(l) || /&&|;/.test(l));
}

function hasPipefail(shell: string): boolean {
  return /pipefail/.test(shell) || /^bash$|^pwsh$/.test(shell.trim());
}

interface Ctx {
  where: string;
  code: string;
  shell: string;
  /** A `defaults.run.shell` inherited from the job or workflow. */
  inherited: string;
}

function defaultShell(node: unknown): string {
  if (!isObj(node) || !isObj(node.defaults) || !isObj(node.defaults.run)) return '';
  return str(node.defaults.run.shell);
}

function collect(doc: WorkflowDoc): Ctx[] {
  const out: Ctx[] = [];
  if (doc.kind === 'workflow') {
    const wfDefault = defaultShell(doc.doc);
    for (const { id, job } of jobsOf(doc.doc)) {
      const inherited = defaultShell(job) || wfDefault;
      for (const s of stepsOf(job)) {
        const code = runOf(s.step);
        if (!code) continue;
        out.push({
          where: `${doc.path} job \`${id}\` step \`${s.label}\``,
          code,
          shell: str(s.step.shell),
          inherited,
        });
      }
    }
  } else {
    for (const s of actionSteps(doc.doc)) {
      const code = runOf(s.step);
      if (!code) continue;
      out.push({ where: `${doc.path} step \`${s.label}\``, code, shell: str(s.step.shell), inherited: '' });
    }
  }
  return out;
}

const shellStrictnessEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - shell strictness not evaluated.');
    }

    const steps = docs.flatMap(collect).filter((s) => isMultiCommand(s.code));
    if (steps.length === 0) {
      return result(0.5, 'No multi-command `run:` steps - the default shell makes no difference here.');
    }

    const implicit: string[] = [];
    const noUnset: string[] = [];
    let strict = 0;

    for (const s of steps) {
      const effective = s.shell || s.inherited;
      if (!effective) {
        // Relies on `bash -e {0}`: a failing stage inside a pipeline passes.
        if (!/set\s+-[a-z]*o?\s*pipefail|set\s+-euo/.test(s.code)) implicit.push(s.where);
        else strict += 1;
        continue;
      }
      if (!hasPipefail(effective)) {
        implicit.push(`${s.where} (\`shell: ${effective}\`)`);
        continue;
      }
      if (!/-[a-z]*u/.test(effective) && !/set\s+-[a-z]*u/.test(s.code)) {
        noUnset.push(s.where);
      }
      strict += 1;
    }

    if (implicit.length === 0 && noUnset.length === 0) {
      return result(
        1.0,
        `All ${steps.length} multi-command script(s) run under a shell that fails on an error and on a broken pipe.`,
      );
    }

    const notes: string[] = [];
    if (implicit.length > 0) {
      notes.push(
        `${implicit.length}/${steps.length} multi-command step(s) rely on the implicit \`bash -e\`, where a failure inside a pipeline is not detected: ${implicit.slice(0, 4).join(', ')}${implicit.length > 4 ? ' ...' : ''}`,
      );
    }
    if (noUnset.length > 0) {
      notes.push(
        `${noUnset.length} step(s) set pipefail but not \`-u\`, so a typo'd variable expands to empty instead of failing: ${noUnset.slice(0, 3).join(', ')}`,
      );
    }

    // Missing pipefail hides real failures; missing -u is a smaller hazard.
    const score = clampScore(1 - (0.7 * implicit.length + 0.2 * noUnset.length) / steps.length);
    return result(score, `${notes.join('. ')}. Declare \`shell: bash -euo pipefail {0}\`.`);
  },
};

export default shellStrictnessEval;

runEval((ctx) => shellStrictnessEval.evaluate(ctx));
