import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';
import { actionRepo, isObj, jobsOf, stepsOf, str, usesOf, withOf, workflows } from './workflow-walk.js';

const EVAL_ID = 'matrix-and-artifact-correctness';
const EVAL_NAME = 'Matrix covers what was asked and its legs do not collide';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * A matrix is easy to write and easy to write uselessly:
 *
 *   - `fail-fast` defaults to true, so the first red leg cancels the rest and
 *     hides whether the failure is general or specific to one combination;
 *   - a dimension nothing references produces N identical runs;
 *   - v4 artifacts are immutable, so two legs uploading the same `name:` means
 *     the second leg fails the whole job - after its tests passed.
 *
 * Where the request enumerated versions or platforms, this also checks they are
 * actually in the matrix, since a matrix that quietly drops one is worse than
 * none: it reports green for coverage that never ran.
 */

/** Version numbers named in the same sentence as a toolchain word. */
function requestedVersions(prompt: string): number[] {
  const sentence = prompt
    .split(/(?<=[.?!])\s/)
    .find((s) => /\bnode|python|go|java|ruby|php\b/i.test(s));
  if (!sentence) return [];
  const nums = [...sentence.matchAll(/\b(\d{1,2})(?:\.\d+)?\b/g)].map((m) => Number(m[1]));
  // Two or more is an enumeration worth checking; one is probably prose.
  return nums.length >= 2 ? [...new Set(nums)] : [];
}

const OS_WORDS: [RegExp, RegExp][] = [
  [/\bubuntu|linux\b/i, /ubuntu/i],
  [/\bmac ?os|osx|darwin\b/i, /macos/i],
  [/\bwindows\b/i, /windows/i],
];

const matrixEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable workflow YAML found - matrix correctness not evaluated.');
    }

    const matrixJobs: { file: string; id: string; job: Record<string, unknown>; matrix: Record<string, unknown> }[] = [];
    for (const wf of workflows(docs)) {
      for (const { id, job } of jobsOf(wf.doc)) {
        const strategy = isObj(job.strategy) ? job.strategy : null;
        if (!strategy || !isObj(strategy.matrix)) continue;
        matrixJobs.push({ file: wf.path, id, job, matrix: strategy.matrix });
      }
    }

    if (matrixJobs.length === 0) {
      return result(0.5, 'No matrix jobs produced - nothing to score for matrix correctness.');
    }

    const problems: string[] = [];

    for (const mj of matrixJobs) {
      const strategy = mj.job.strategy as Record<string, unknown>;
      const body = JSON.stringify(mj.job);

      // Dimensions, excluding the two keys that configure rather than multiply.
      const dims = Object.entries(mj.matrix).filter(
        ([k, v]) => k !== 'include' && k !== 'exclude' && Array.isArray(v),
      );
      const legs = dims.reduce((n, [, v]) => n * (v as unknown[]).length, 1);

      if (legs > 1 && strategy['fail-fast'] !== false) {
        problems.push(
          `${mj.file} job \`${mj.id}\`: ${legs} legs with \`fail-fast\` left at its default - the first failure cancels the rest, hiding whether the others pass`,
        );
      }

      for (const [dim] of dims) {
        if (!new RegExp(`matrix\\.${dim}\\b`).test(body)) {
          problems.push(
            `${mj.file} job \`${mj.id}\`: matrix dimension \`${dim}\` is never referenced, so its legs are identical runs`,
          );
        }
      }

      // Two legs writing one artifact name: v4 rejects the second.
      const uploads = stepsOf(mj.job).filter(
        (s) => actionRepo(usesOf(s.step)) === 'actions/upload-artifact',
      );
      for (const up of uploads) {
        const name = str(withOf(up.step).name);
        if (legs > 1 && !/\$\{\{\s*matrix\./.test(name)) {
          problems.push(
            `${mj.file} job \`${mj.id}\`: uploads artifact \`${name || '(default name)'}\` from ${legs} legs without a per-leg name - v4 artifacts are immutable, so the second leg fails`,
          );
        }
      }
    }

    // Coverage the request named explicitly.
    const prompt = ctx.scenario?.prompt ?? '';
    const allMatrixText = JSON.stringify(matrixJobs.map((m) => m.matrix));
    const wanted = requestedVersions(prompt);
    const missingVersions = wanted.filter((v) => !new RegExp(`\\b${v}\\b`).test(allMatrixText));
    if (wanted.length > 0 && missingVersions.length > 0) {
      problems.push(
        `the request named ${wanted.join(', ')} but the matrix omits ${missingVersions.join(', ')}`,
      );
    }
    const missingOs = OS_WORDS.filter(
      ([inPrompt, inMatrix]) => inPrompt.test(prompt) && !inMatrix.test(allMatrixText),
    );
    if (missingOs.length > 0) {
      problems.push(`the request named ${missingOs.length} platform(s) the matrix does not cover`);
    }

    if (problems.length === 0) {
      return result(
        1.0,
        `${matrixJobs.length} matrix job(s): every dimension is referenced, \`fail-fast: false\` keeps failing legs from hiding each other, artifact names are per-leg, and the requested coverage is present.`,
      );
    }
    return result(clampScore(1 - 0.35 * problems.length), `${problems.join('. ')}.`);
  },
};

export default matrixEval;

runEval((ctx) => matrixEval.evaluate(ctx));
