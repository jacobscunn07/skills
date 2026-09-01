import type { Eval, EvalContext, EvalResult } from './types.js';
import { lintJson, memberPath, messagesFor, type EvalRule } from './eslint-runner.js';
import { makeResult, runEval } from './utils.js';
import { byPath, leafKey, loadWorkflows, splitPath, type WorkflowDoc } from './workflow-json.js';

const EVAL_ID = 'actions-pinned-to-sha';
const EVAL_NAME = 'Third-party actions pinned to a full commit SHA';

const result = makeResult(EVAL_ID, EVAL_NAME);

/** A 40-character hex commit SHA is the only immutable ref GitHub accepts. */
const SHA_RE = /^[0-9a-f]{40}$/;
/** The `# vX.Y.Z` comment beside a pinned SHA is what Dependabot reads to offer a bump. */
const PINNED_RE = /uses:\s*\S+@[0-9a-f]{40}/;
const PINNED_WITH_COMMENT_RE = /uses:\s*\S+@[0-9a-f]{40}\s*#\s*\S/;

/** Reports every `uses:` value in the document, wherever it appears. */
const usesRule: EvalRule = {
  create(context) {
    return {
      Member(node: any) {
        const path = memberPath(context, node);
        if (leafKey(path) !== 'uses') return;
        const value: unknown = node.value?.value;
        if (typeof value !== 'string') return;
        context.report({ node, message: `${splitPath(path).file} ${value}` });
      },
    };
  },
};

type Verdict = 'pinned' | 'unpinned' | 'exempt';

function classify(uses: string): Verdict {
  // A local action is part of this repo; there is no third party to pin.
  if (uses.startsWith('./')) return 'exempt';
  if (uses.startsWith('docker://')) {
    // A digest is the docker equivalent of a SHA pin; a tag is not.
    return uses.includes('@sha256:') ? 'pinned' : 'unpinned';
  }
  const at = uses.lastIndexOf('@');
  if (at === -1) return 'unpinned';
  return SHA_RE.test(uses.slice(at + 1)) ? 'pinned' : 'unpinned';
}

/**
 * How many pinned `uses:` lines carry the version comment. This reads the raw YAML
 * because comments do not survive the parse into the JSON the rules see.
 */
function commentedPins(docs: WorkflowDoc[]): { pinned: number; commented: number } {
  let pinned = 0;
  let commented = 0;
  for (const d of docs) {
    for (const line of d.raw.split('\n')) {
      if (!PINNED_RE.test(line)) continue;
      pinned++;
      if (PINNED_WITH_COMMENT_RE.test(line)) commented++;
    }
  }
  return { pinned, commented };
}

const actionsPinnedEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable workflow or action YAML found - pinning not evaluated.');
    }

    const messages = await lintJson(byPath(docs), { uses: usesRule });
    const found = messagesFor(messages, 'uses').map((m) => {
      const [file, uses] = m.message.split(' ');
      return { file, uses, verdict: classify(uses) };
    });

    const checked = found.filter((u) => u.verdict !== 'exempt');
    if (checked.length === 0) {
      return result(
        0.5,
        found.length === 0
          ? 'No `uses:` steps found - nothing to pin.'
          : `Only local actions used (${found.map((u) => u.uses).join(', ')}) - nothing to pin.`,
      );
    }

    const unpinned = checked.filter((u) => u.verdict === 'unpinned');
    const ratio = (checked.length - unpinned.length) / checked.length;

    if (unpinned.length > 0) {
      const shown = unpinned.slice(0, 4).map((u) => `${u.file}: ${u.uses}`).join('; ');
      return result(
        0.7 * ratio,
        `${unpinned.length}/${checked.length} action reference(s) use a mutable tag or branch instead of a 40-character commit SHA: ${shown}` +
          (unpinned.length > 4 ? ' ...' : ''),
      );
    }

    const { pinned, commented } = commentedPins(docs);
    if (pinned > 0 && commented < pinned) {
      return result(
        0.8,
        `All ${checked.length} action reference(s) are SHA-pinned, but ${pinned - commented} lack the trailing \`# vX.Y.Z\` version comment Dependabot reads.`,
      );
    }
    return result(
      1.0,
      `All ${checked.length} action reference(s) are pinned to a commit SHA with a version comment.`,
    );
  },
};

export default actionsPinnedEval;

runEval((ctx) => actionsPinnedEval.evaluate(ctx));
