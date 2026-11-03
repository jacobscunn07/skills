import type { Eval, EvalContext, EvalResult } from './types.js';
import { makeResult, runEval } from './utils.js';

const EVAL_ID = 'skill-hygiene';
const EVAL_NAME = 'Skill has no dated wording or Windows paths';

/**
 * Two lint checks from Anthropic's authoring guide, 0.5 each, over the SKILL.md body and
 * every reference file:
 * - no time-sensitive wording ("before August 2025"), which goes stale silently. It is
 *   allowed under a heading that marks the section as old patterns, legacy or deprecated;
 * - no backslash paths, which break on Unix.
 */
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATED_RE = new RegExp(`\\b(?:before|after|until|as of|since) (?:${MONTH} )?20\\d\\d\\b`, 'i');
const BACKSLASH_PATH_RE = /\w+\\[\w.-]+\.\w{1,4}/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const EXEMPT_HEADING_RE = /old patterns|legacy|deprecated/i;
const MAX_EXAMPLES = 5;

const result = makeResult(EVAL_ID, EVAL_NAME);

interface Hit {
  where: string;
  text: string;
}

/** Collects dated-wording and backslash-path hits in one markdown file. */
function scan(path: string, content: string, dated: Hit[], paths: Hit[]): void {
  let exempt = false;
  let inFence = false;
  content.split(/\r?\n/).forEach((line, i) => {
    const where = `${path}:${i + 1}`;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : line.match(HEADING_RE);
    if (heading) exempt = EXEMPT_HEADING_RE.test(heading[1]);

    const date = line.match(DATED_RE);
    if (date && !exempt) dated.push({ where, text: date[0] });
    const backslash = line.match(BACKSLASH_PATH_RE);
    if (backslash) paths.push({ where, text: backslash[0] });
  });
}

function describe(hits: Hit[]): string {
  const shown = hits.slice(0, MAX_EXAMPLES).map((h) => `${h.where} ${JSON.stringify(h.text)}`);
  const more = hits.length > MAX_EXAMPLES ? ` and ${hits.length - MAX_EXAMPLES} more` : '';
  return shown.join(', ') + more;
}

const skillHygieneEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    const dated: Hit[] = [];
    const paths: Hit[] = [];
    scan('SKILL.md', ctx.skillContent ?? '', dated, paths);
    for (const file of ctx.skillFiles ?? []) scan(file.path, file.content, dated, paths);

    const reasons: string[] = [];
    let score = 0;
    if (dated.length === 0) {
      score += 0.5;
      reasons.push('no dated wording');
    } else {
      reasons.push(
        `dated wording goes stale: ${describe(dated)}; drop the date or move it under an "Old patterns" heading`,
      );
    }
    if (paths.length === 0) {
      score += 0.5;
      reasons.push('no backslash paths');
    } else {
      reasons.push(`backslash paths break on Unix, use forward slashes: ${describe(paths)}`);
    }
    return result(score, reasons.join('; '));
  },
};

export default skillHygieneEval;

runEval((ctx) => skillHygieneEval.evaluate(ctx));
