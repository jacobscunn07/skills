import type { Eval, EvalContext, EvalResult } from './types.js';
import { makeResult, runEval } from './utils.js';

const EVAL_ID = 'skill-description';
const EVAL_NAME = 'Skill description';

/**
 * Scores the skill's description against Anthropic's authoring guide: half for third
 * person, half for saying when to use the skill as well as what it does. The description
 * is injected into the system prompt, so first or second person reads wrongly there, and
 * a description without a "when" gives Claude nothing to match a request against.
 */
const PERSON = /\b(I|I'm|I'll|me|my|we|our|you|your)\b/i;
const WHEN = /\b(use (it |this )?(when|for|whenever|if)|when (the user|working|asked))\b/i;

const result = makeResult(EVAL_ID, EVAL_NAME);

const skillDescriptionEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    const d = (ctx.skillDescription ?? '').trim();
    if (!d) return result(0, 'the description is empty');

    const reasons: string[] = [];
    let score = 0;
    const person = d.match(PERSON);
    if (person) {
      reasons.push(`description is not third person: it says ${JSON.stringify(person[0])}`);
    } else {
      score += 0.5;
      reasons.push('description is third person');
    }
    if (WHEN.test(d)) {
      score += 0.5;
      reasons.push('description says when to use the skill');
    } else {
      reasons.push('description says what but not when; add a "Use when ..." clause');
    }
    return result(score, reasons.join('; '));
  },
};

export default skillDescriptionEval;

runEval((ctx) => skillDescriptionEval.evaluate(ctx));
