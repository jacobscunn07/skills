import type { Eval, EvalContext, EvalResult } from './types.js';
import { makeResult, runEval } from './utils.js';

const EVAL_ID = 'skill-length';
const EVAL_NAME = 'SKILL.md body stays within the line budget';

/**
 * The research program's budget for the SKILL.md body. Past it the skill keeps half
 * credit until Anthropic's own limit, and scores 0 only once it is over that.
 */
const LINE_BUDGET = 200;
const LINE_LIMIT = 500;

const result = makeResult(EVAL_ID, EVAL_NAME);

const skillLengthEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    const body = (ctx.skillContent ?? '').replace(/\r?\n$/, '');
    const lines = body === '' ? 0 : body.split(/\r?\n/).length;
    const summary = `SKILL.md body is ${lines} lines (budget ${LINE_BUDGET}, limit ${LINE_LIMIT})`;
    if (lines <= LINE_BUDGET) return result(1, summary);
    if (lines <= LINE_LIMIT) {
      return result(0.5, `${summary}; move detail into references/<topic>.md to get back under ${LINE_BUDGET}`);
    }
    return result(0, `${summary}; it is over Anthropic's ${LINE_LIMIT}-line limit, split it into reference files`);
  },
};

export default skillLengthEval;

runEval((ctx) => skillLengthEval.evaluate(ctx));
