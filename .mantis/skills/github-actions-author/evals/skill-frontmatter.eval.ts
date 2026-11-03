import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import type { Eval, EvalContext, EvalResult } from './types.js';
import { makeResult, runEval } from './utils.js';

const EVAL_ID = 'skill-frontmatter';
const EVAL_NAME = 'SKILL.md frontmatter meets the authoring limits';

/**
 * Checks the frontmatter fields Claude uses to discover the skill against the limits in
 * Anthropic's skill authoring guide. The score is the fraction of checks passed, and the
 * reasoning names each failed check with the offending value.
 */
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED_RE = /anthropic|claude/i;
const XML_TAG_RE = /<[A-Za-z/][^>]*>/;

const result = makeResult(EVAL_ID, EVAL_NAME);

/** Parses the leading `---` block of SKILL.md, or returns null when there is none. */
function readFrontmatter(skillDir: string): Record<string, unknown> | null {
  const path = join(skillDir, 'SKILL.md');
  if (!existsSync(path)) return null;
  const match = readFileSync(path, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    const data = parse(match[1]);
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const skillFrontmatterEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    const notes: string[] = [];
    const frontmatter = readFrontmatter(ctx.skillDir);
    let name = typeof frontmatter?.name === 'string' ? frontmatter.name : null;
    if (name === null) {
      name = ctx.skillName ?? '';
      notes.push(`no frontmatter name in SKILL.md, checked the directory name ${JSON.stringify(name)} instead`);
    }
    const description = (ctx.skillDescription ?? '').trim();

    const checks: Array<[boolean, string]> = [
      [name.length <= NAME_MAX, `name is ${name.length} characters, over ${NAME_MAX}`],
      [NAME_RE.test(name), `name ${JSON.stringify(name)} is not lowercase letters, digits and single hyphens`],
      [!RESERVED_RE.test(name), `name ${JSON.stringify(name)} contains a reserved word (anthropic or claude)`],
      [!XML_TAG_RE.test(name), `name contains an XML tag: ${JSON.stringify(name.match(XML_TAG_RE)?.[0])}`],
      [description.length > 0, 'description is empty'],
      [description.length <= DESCRIPTION_MAX, `description is ${description.length} characters, over ${DESCRIPTION_MAX}`],
      [
        !XML_TAG_RE.test(description),
        `description contains an XML tag: ${JSON.stringify(description.match(XML_TAG_RE)?.[0])}`,
      ],
    ];

    const failures = checks.filter(([ok]) => !ok).map(([, why]) => why);
    const passed = checks.length - failures.length;
    const summary =
      failures.length === 0
        ? `all ${checks.length} frontmatter checks pass`
        : `${passed}/${checks.length} frontmatter checks pass; ${failures.join('; ')}`;
    return result(passed / checks.length, [...notes, summary].join('; '));
  },
};

export default skillFrontmatterEval;

runEval((ctx) => skillFrontmatterEval.evaluate(ctx));
