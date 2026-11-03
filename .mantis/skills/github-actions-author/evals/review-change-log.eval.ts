import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';

const EVAL_ID = 'review-change-log';
const EVAL_NAME = 'A review fixes the file in place and says what it changed';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * "Review and fix this workflow" has an output contract of its own: the corrected
 * file at the same path, plus a change log.
 *
 * Both halves are load-bearing. A corrected workflow written to a *new* path
 * leaves the vulnerable one still running, which is the failure mode that looks
 * most like success. And a hardening diff without an itemized rationale cannot be
 * reviewed - the person approving it has to re-derive every finding to know
 * whether the fix is right, which is the work they asked to have done.
 */

/** A fixture that is itself a workflow is the thing under review. */
function reviewTargets(ctx: EvalContext): string[] {
  const fixtures = ctx.scenario?.fixtures ?? {};
  return Object.keys(fixtures).filter((p) => /\.ya?ml$/.test(p) && p.includes('workflow'));
}

/** Lines that read as entries in a list of changes. */
function listItems(text: string): number {
  const prose = text.replace(/```[\s\S]*?```/g, ' ');
  return prose
    .split('\n')
    .filter((l) => /^\s*(?:[-*+]\s+\S|\d+[.)]\s+\S)/.test(l)).length;
}

const reviewChangeLogEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const targets = reviewTargets(ctx);
    if (targets.length === 0) {
      return result(0.5, 'Not a review task - no workflow fixture was supplied to correct.');
    }

    const transcript = ctx.qualityTranscript ?? '';
    const notes: string[] = [];
    let inPlace = 0;

    for (const target of targets) {
      const original = ctx.scenario.fixtures?.[target] ?? '';
      const path = join(ctx.workDir, target);
      if (!existsSync(path)) {
        notes.push(
          `\`${target}\` is gone from the working tree - a corrected copy elsewhere leaves nothing fixed at the path GitHub reads`,
        );
        continue;
      }
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        current = '';
      }
      if (current.trim() === original.trim()) {
        notes.push(`\`${target}\` is byte-for-byte the original - it was reviewed but never actually fixed`);
      } else {
        inPlace += 1;
      }
    }

    const items = listItems(transcript);
    const hasLog = items >= 3;
    if (!hasLog) {
      notes.push(
        `the reply lists ${items} itemized change(s) - a hardening review needs each finding and its fix enumerated, or the reader has to re-derive them`,
      );
    }

    const placeScore = targets.length === 0 ? 1 : inPlace / targets.length;
    const logScore = hasLog ? 1 : clampScore(items / 3);
    const score = clampScore(0.6 * placeScore + 0.4 * logScore);

    if (notes.length === 0) {
      return result(
        1.0,
        `${inPlace} reviewed file(s) corrected in place at their original path, with ${items} itemized changes in the reply.`,
      );
    }
    return result(score, `${notes.join('. ')}.`);
  },
};

export default reviewChangeLogEval;

runEval((ctx) => reviewChangeLogEval.evaluate(ctx));
