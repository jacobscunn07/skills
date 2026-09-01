import type { EvalContext, EvalResult } from './types.js';

/** A fenced markdown code block with its info string (```yaml -> lang "yaml"). */
export interface TaggedCodeBlock {
  lang: string;
  code: string;
}

/** Extracts all fenced code blocks along with their language tag. */
export function extractTaggedCodeBlocks(text: string): TaggedCodeBlock[] {
  const blocks: TaggedCodeBlock[] = [];
  const re = /```([\w-]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    blocks.push({ lang: match[1].toLowerCase(), code: match[2] });
  }
  return blocks;
}

/** Clamps a computed score into the 0..1 range evals must report. */
export function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0.5));
}

/** Builds the EvalResult shape, so each eval keeps one `result(score, why)` helper. */
export function makeResult(evalId: string, name: string) {
  return (score: number, reasoning: string): EvalResult => ({
    evalId,
    name,
    score: clampScore(score),
    reasoning,
  });
}

/** Subprocess entry point: reads EvalContext JSON from stdin, writes EvalResult to stdout. */
export function runEval(evaluate: (ctx: EvalContext) => Promise<EvalResult>): void {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (c: Buffer) => chunks.push(c));
  process.stdin.on('end', async () => {
    try {
      const ctx: EvalContext = JSON.parse(Buffer.concat(chunks).toString());
      process.stdout.write(JSON.stringify(await evaluate(ctx)));
    } catch (err) {
      process.stderr.write(String(err));
      process.exit(1);
    }
  });
}
