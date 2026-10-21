import { basename } from 'path';
import type { Eval, EvalContext, EvalResult } from './types.js';
import { makeResult, runEval } from './utils.js';

const EVAL_ID = 'skill-references';
const EVAL_NAME = 'Reference files are one level deep, navigable and well named';

/**
 * Checks each reference file against Anthropic's authoring guide:
 * - one level deep: Claude may only preview a file reached through another reference,
 *   so no reference file points at another `references/*.md`;
 * - a long file opens with a table of contents, so a partial read still shows its scope;
 * - the file name says what is in it.
 *
 * The score is the fraction of (file, check) pairs that pass. A skill with no reference
 * files passes.
 */
const MENTION_RE = /references\/[\w./-]+\.md/g;
const LONG_FILE_LINES = 100;
const CONTENTS_WINDOW = 30;
const CONTENTS_RE = /^#+\s*(contents|table of contents)\b/i;
const VAGUE_NAME_RE = /^(doc|file|notes?|misc|untitled|temp|tmp)\d*\.md$/i;

const result = makeResult(EVAL_ID, EVAL_NAME);

const skillReferencesEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    const files = ctx.skillFiles ?? [];
    if (files.length === 0) return result(1, 'N/A: the skill has no reference files');

    const failures: string[] = [];
    let passed = 0;
    for (const file of files) {
      const lines = file.content.replace(/\r?\n$/, '').split(/\r?\n/);

      const mentions = [...new Set(file.content.match(MENTION_RE) ?? [])];
      if (mentions.length === 0) passed++;
      else failures.push(`${file.path} points at ${mentions.join(', ')}; link it from SKILL.md instead`);

      const hasContents = lines.slice(0, CONTENTS_WINDOW).some((line) => CONTENTS_RE.test(line.trim()));
      if (lines.length <= LONG_FILE_LINES || hasContents) passed++;
      else {
        failures.push(
          `${file.path} is ${lines.length} lines with no Contents heading in its first ${CONTENTS_WINDOW} lines`,
        );
      }

      const name = basename(file.path);
      if (!VAGUE_NAME_RE.test(name)) passed++;
      else failures.push(`${file.path} has a name that does not describe its content`);
    }

    const total = files.length * 3;
    const summary = `${passed}/${total} reference checks pass across ${files.length} file(s)`;
    return result(passed / total, failures.length ? `${summary}; ${failures.join('; ')}` : summary);
  },
};

export default skillReferencesEval;

runEval((ctx) => skillReferencesEval.evaluate(ctx));
