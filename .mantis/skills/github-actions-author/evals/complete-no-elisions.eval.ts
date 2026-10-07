import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, extractTaggedCodeBlocks, makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';

const EVAL_ID = 'complete-no-elisions';
const EVAL_NAME = 'Emitted files are whole, with nothing abbreviated away';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * The output contract says whole runnable files: "no `# ...rest of the jobs`, no
 * 'the other jobs follow the same pattern'". `writes-files-to-disk` checks that a
 * file exists and was shown; it cannot tell a complete file from a sketch, and an
 * elided workflow is worse than no workflow because it looks finished.
 *
 * Deliberately *not* flagged: `# Replace with your deploy command`, `# TODO: set
 * your region`. Those mark a value only the user can supply, which a template is
 * supposed to have. The distinction is content the author omitted for brevity
 * versus content the reader is meant to fill in.
 */

/** Markers inside YAML that stand in for content the author left out. */
const YAML_ELISION = [
  /^\s*#\s*\.\.\.+/m,
  /^\s*#\s*…/m,
  /#\s*(?:and\s+)?(?:the\s+)?(?:rest|remainder|remaining|other)\b[^\n]*/i,
  /#\s*\(?\s*(?:etc|and so on|snip|truncated|omitted|unchanged)\b/i,
  /#\s*same (?:pattern|as above|thing)/i,
  /^\s*(?:\.\.\.|…)\s*$/m,
  /<\s*snip\s*>/i,
];

/** Sentences in the reply that promise content instead of emitting it. */
const PROSE_ELISION = [
  /the (?:other|remaining) (?:jobs?|steps?|workflows?|files?) (?:follow|are|would be|look)[^.\n]*same/i,
  /\bsame pattern (?:for|as)\b/i,
  /\band so on\b/i,
  /\betc\.?\s*(?:for|with)?\s*(?:the )?(?:other|remaining)\b/i,
  /\bfor brevity\b/i,
  /\b(?:abbreviated|truncated|elided|omitted) (?:here|for|above|below)\b/i,
  /\brepeat (?:this|the same) (?:for|pattern)\b/i,
];

const YAML_FENCES = new Set(['yaml', 'yml']);

function firstMatch(text: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0].trim().replace(/\s+/g, ' ').slice(0, 70);
  }
  return '';
}

const completeNoElisionsEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - completeness not evaluated.');
    }

    const transcript = ctx.qualityTranscript ?? '';
    const findings: string[] = [];

    // 1. Files on disk. These are what GitHub would run, so an elision here is
    //    not a presentation problem - the workflow is genuinely incomplete.
    const elidedFiles: string[] = [];
    for (const doc of docs) {
      const hit = firstMatch(doc.raw, YAML_ELISION);
      if (hit) elidedFiles.push(`${doc.path} ("${hit}")`);
    }
    if (elidedFiles.length > 0) {
      findings.push(`file(s) written with content abbreviated away: ${elidedFiles.join(', ')}`);
    }

    // 2. Fenced YAML in the reply, which is what the reader reviews.
    const blocks = extractTaggedCodeBlocks(transcript).filter((b) => YAML_FENCES.has(b.lang));
    const elidedBlocks = blocks
      .map((b, i) => ({ i, hit: firstMatch(b.code, YAML_ELISION) }))
      .filter((b) => b.hit);
    if (elidedBlocks.length > 0) {
      findings.push(
        `${elidedBlocks.length}/${blocks.length} fenced yaml block(s) abbreviated: ${elidedBlocks
          .map((b) => `block ${b.i + 1} ("${b.hit}")`)
          .join(', ')}`,
      );
    }

    // 3. Prose that describes the rest instead of emitting it. Only the text
    //    outside code fences counts, so a comment quoted in an example is not
    //    double-reported.
    const prose = transcript.replace(/```[\s\S]*?```/g, ' ');
    const proseHit = firstMatch(prose, PROSE_ELISION);
    if (proseHit) {
      findings.push(`the reply defers content to prose rather than emitting it: "${proseHit}"`);
    }

    if (findings.length === 0) {
      return result(
        1.0,
        `${docs.length} file(s) and ${blocks.length} fenced block(s) are complete - no elision markers, no deferred content.`,
      );
    }

    // Weighted by where it happened: a truncated file breaks the deliverable, a
    // truncated block only breaks the review, prose alone is the mildest.
    const penalty =
      (elidedFiles.length > 0 ? 0.6 : 0) +
      (elidedBlocks.length > 0 ? 0.3 : 0) +
      (proseHit ? 0.15 : 0);
    return result(
      clampScore(1 - penalty),
      `${findings.join('. ')}. Emit whole, runnable files - an abbreviated workflow reads as finished and is not.`,
    );
  },
};

export default completeNoElisionsEval;

runEval((ctx) => completeNoElisionsEval.evaluate(ctx));
