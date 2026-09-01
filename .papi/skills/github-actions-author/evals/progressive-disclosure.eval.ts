import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Eval, EvalContext, EvalResult, SkillFile } from './types.js';
import { lintMarkdown, messagesFor, type EvalRule } from './eslint-runner.js';
import { clampScore, makeResult, runEval } from './utils.js';

const EVAL_ID = 'progressive-disclosure';
const EVAL_NAME = 'SKILL.md routes to references instead of growing';

/**
 * Everything in SKILL.md is loaded on every invocation, so a long one spends context
 * on detail the current task does not need. Past LINE_BUDGET the skill is expected to
 * become a router: a short SKILL.md plus `references/<topic>.md` files Claude opens on
 * demand.
 *
 * Below the budget this scores N/A (1.0) - splitting a short skill is pure indirection,
 * and the loop only keeps a change that strictly improves the score, so a neutral
 * result here means "leave it alone".
 */
const LINE_BUDGET = 200;
/** Above this, having split at all is worth half credit and no more. */
const NO_CREDIT_ABOVE = 300;

const result = makeResult(EVAL_ID, EVAL_NAME);

/** Matches a references/<path>.md mention: markdown link target, inline code, or bare text. */
const REFERENCE_RE = /references\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md/g;

function matchesIn(text: string): string[] {
  return text.match(REFERENCE_RE) ?? [];
}

/**
 * Collects the reference paths a markdown file actually points at.
 *
 * The visitor deliberately skips `code` nodes: a `references/x.md` line inside a fenced
 * example is illustration, not a pointer Claude can follow, and counting it would let a
 * skill satisfy this eval without routing anywhere.
 */
const pointerRule: EvalRule = {
  create(context) {
    const report = (node: any, text: string) => {
      for (const path of matchesIn(text)) context.report({ node, message: path });
    };
    return {
      link(node: any) {
        report(node, String(node.url ?? ''));
      },
      inlineCode(node: any) {
        report(node, String(node.value ?? ''));
      },
      text(node: any) {
        report(node, String(node.value ?? ''));
      },
    };
  },
};

async function pointersIn(md: string, filePath: string): Promise<string[]> {
  const messages = await lintMarkdown(md, { pointer: pointerRule }, filePath);
  return messagesFor(messages, 'pointer').map((m) => m.message);
}

/**
 * Reads the SKILL.md that ran. Measuring the file on disk (rather than ctx.skillContent,
 * which has the frontmatter stripped) keeps this eval's line count identical to the
 * budget stated in program.md, so the research agent is scored against the number it
 * was told to hit.
 */
function readSkillMd(ctx: EvalContext): string {
  const path = join(ctx.skillDir ?? '', 'SKILL.md');
  if (ctx.skillDir && existsSync(path)) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      /* fall through to the in-context copy */
    }
  }
  return ctx.skillContent ?? '';
}

/**
 * The skill's reference files. papi supplies them in ctx.skillFiles; the fallback read
 * from disk is what makes this eval runnable standalone against a skill directory.
 */
function readSkillFiles(ctx: EvalContext): SkillFile[] {
  if (ctx.skillFiles?.length) return ctx.skillFiles;
  const dir = join(ctx.skillDir ?? '', 'references');
  if (!ctx.skillDir || !existsSync(dir)) return [];
  const out: SkillFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    try {
      out.push({ path: `references/${name}`, content: readFileSync(join(dir, name), 'utf8') });
    } catch {
      /* unreadable file: treated as missing, which the dangling check reports */
    }
  }
  return out;
}

function countLines(text: string): number {
  const trimmed = text.replace(/\n+$/, '');
  return trimmed === '' ? 0 : trimmed.split('\n').length;
}

const progressiveDisclosureEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    // Judges the skill's own shape, so it does not depend on invocation or output.
    const skillMd = readSkillMd(ctx);
    if (!skillMd) return result(0.0, 'Could not read SKILL.md to measure.');

    const files = readSkillFiles(ctx);
    const linked = [...new Set(await pointersIn(skillMd, 'SKILL.md'))].sort();

    // A reference may route on to another reference, so reachability is computed over
    // SKILL.md plus every reference file - matching the rule the research agent is given.
    const reachable = new Set(linked);
    for (const f of files) {
      for (const p of await pointersIn(f.content, f.path)) reachable.add(p);
    }

    const onDisk = new Set(files.map((f) => f.path));
    const missing = [...reachable].filter(
      (p) => !onDisk.has(p) && !existsSync(join(ctx.skillDir ?? '', p)),
    );
    if (missing.length > 0) {
      return result(
        0.0,
        `SKILL.md points at ${missing.length} reference file(s) that do not exist: ${missing.join(', ')}. ` +
          `A dangling pointer is worse than a long file - Claude follows it and finds nothing.`,
      );
    }

    const orphans = [...onDisk].filter((p) => !reachable.has(p)).sort();
    if (orphans.length > 0) {
      return result(
        0.0,
        `Reference file(s) nothing links to: ${orphans.join(', ')}. ` +
          `Content moved out of SKILL.md without a routing entry is content Claude never reads.`,
      );
    }

    const lines = countLines(skillMd);
    if (lines <= LINE_BUDGET) {
      const routing = linked.length > 0 ? ` It routes to ${linked.length} reference file(s).` : '';
      return result(
        1.0,
        `N/A: SKILL.md is ${lines} lines, within the ${LINE_BUDGET}-line budget, so progressive disclosure is not required.${routing}`,
      );
    }

    if (linked.length === 0) {
      return result(
        0.0,
        `SKILL.md is ${lines} lines (over the ${LINE_BUDGET}-line budget) and links no reference files. ` +
          `Move the task-specific depth into references/<topic>.md and leave a routing table behind.`,
      );
    }

    const overflow = (NO_CREDIT_ABOVE - lines) / (NO_CREDIT_ABOVE - LINE_BUDGET);
    return result(
      0.5 + 0.5 * clampScore(overflow),
      `SKILL.md is ${lines} lines (budget ${LINE_BUDGET}) and routes to ${linked.length} reference file(s): ${linked.join(', ')}. ` +
        `Score rises toward 1.0 as SKILL.md shrinks to ${LINE_BUDGET} lines.`,
    );
  },
};

export default progressiveDisclosureEval;

runEval((ctx) => progressiveDisclosureEval.evaluate(ctx));
