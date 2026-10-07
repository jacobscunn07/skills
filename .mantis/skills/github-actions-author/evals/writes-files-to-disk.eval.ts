import type { Eval, EvalContext, EvalResult } from './types.js';
import { extractTaggedCodeBlocks, makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';

const EVAL_ID = 'writes-files-to-disk';
const EVAL_NAME = 'Workflow and action files are written to disk, not just described';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * SKILL.md's output contract is "write the file at its real path AND show it as a
 * fenced yaml block". Both halves matter: a file on disk is what GitHub would
 * actually run and what every other eval reads, and the fenced block is what the
 * person asking gets to review. This eval is the only one that scores the contract
 * itself, so a scenario whose subject matter no other eval covers - a composite
 * action, a reusable workflow - still produces signal.
 */
const YAML_FENCES = new Set(['yaml', 'yml']);

const writesFilesEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    const shown = extractTaggedCodeBlocks(ctx.qualityTranscript ?? '').some((b) =>
      YAML_FENCES.has(b.lang),
    );

    if (source === 'none') {
      return result(
        0.0,
        'No workflow or action YAML anywhere - neither written to disk nor shown in the reply.',
      );
    }

    if (source === 'transcript') {
      return result(
        0.3,
        `${docs.length} YAML document(s) appear only in the reply. Nothing was written to .github/workflows or an action.yml, so there is no file to run or review.`,
      );
    }

    const paths = docs.map((d) => d.path).join(', ');
    if (!shown) {
      return result(
        0.8,
        `${docs.length} file(s) written to disk (${paths}), but none were shown as a fenced yaml block in the reply.`,
      );
    }
    return result(1.0, `${docs.length} file(s) written to disk (${paths}) and shown in the reply.`);
  },
};

export default writesFilesEval;

runEval((ctx) => writesFilesEval.evaluate(ctx));
