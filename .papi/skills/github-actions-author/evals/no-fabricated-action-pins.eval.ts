import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows, type WorkflowDoc } from './workflow-json.js';
import { actionRepo, actionSteps, jobsOf, stepsOf, usesOf } from './workflow-walk.js';

const EVAL_ID = 'no-fabricated-action-pins';
const EVAL_NAME = 'SHA pins match the verified table and agree across files';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * `actions-pinned-to-sha` scores the *shape* of a pin: 40 hex characters and a
 * version comment. A fabricated SHA has exactly that shape, so it scores full
 * marks there while producing a workflow that cannot resolve a ref and fails on
 * its first run. This eval scores whether the pin is the *right* 40 characters.
 *
 * Scope note: resolving an arbitrary SHA needs the network, and an eval whose
 * score depends on network reachability would move under an unchanged skill.
 * So this checks the two things that are decidable offline:
 *
 *   1. an action listed in SKILL.md's verified-pin table must carry that table's
 *      SHA, and the version comment must agree with it;
 *   2. one action pinned to two different SHAs across the produced files is a
 *      contradiction regardless of which is right.
 *
 * Actions outside the table are not scored - absence of evidence, not evidence
 * of fabrication.
 */

/** `| `actions/checkout` | `11bd719… # v4.2.2` |` in SKILL.md or any reference. */
const TABLE_ROW_RE =
  /\|\s*`([\w.-]+\/[\w.-]+)`\s*\|\s*`([0-9a-f]{40})\s*#\s*([^`|]+?)\s*`\s*\|/g;

const SHA_RE = /^[0-9a-f]{40}$/;

interface Pin {
  file: string;
  repo: string;
  sha: string;
  /** The `# vX.Y.Z` trailing the pin in the raw YAML, if any. */
  comment: string;
}

function verifiedPins(ctx: EvalContext): Map<string, { sha: string; version: string }> {
  const table = new Map<string, { sha: string; version: string }>();
  const sources = [ctx.skillContent, ...ctx.skillFiles.map((f) => f.content)];
  for (const text of sources) {
    for (const m of text.matchAll(TABLE_ROW_RE)) {
      table.set(m[1], { sha: m[2], version: m[3].trim() });
    }
  }
  return table;
}

/** Every `uses:` in a document, from workflow jobs or a composite action's steps. */
function usesIn(doc: WorkflowDoc): string[] {
  const out: string[] = [];
  if (doc.kind === 'workflow') {
    for (const { job } of jobsOf(doc.doc)) {
      const u = usesOf(job);
      if (u) out.push(u);
      for (const s of stepsOf(job)) {
        const su = usesOf(s.step);
        if (su) out.push(su);
      }
    }
  } else {
    for (const s of actionSteps(doc.doc)) {
      const su = usesOf(s.step);
      if (su) out.push(su);
    }
  }
  return out;
}

/** The comment trailing this exact pin in the raw YAML, which the parse drops. */
function commentFor(raw: string, uses: string): string {
  const escaped = uses.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`uses:\\s*${escaped}\\s*#\\s*(\\S+)`).exec(raw);
  return m ? m[1] : '';
}

const noFabricatedPinsEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - action pins not evaluated.');
    }

    const table = verifiedPins(ctx);
    if (table.size === 0) {
      return result(0.5, 'No verified-pin table found in the skill - nothing to check pins against.');
    }

    const pins: Pin[] = [];
    for (const doc of docs) {
      for (const uses of usesIn(doc)) {
        const repo = actionRepo(uses);
        const sha = uses.split('@')[1] ?? '';
        if (!repo || !SHA_RE.test(sha)) continue;
        pins.push({ file: doc.path, repo, sha, comment: commentFor(doc.raw, uses) });
      }
    }

    if (pins.length === 0) {
      return result(0.5, 'No SHA-pinned third-party actions - nothing to verify.');
    }

    const wrongSha: string[] = [];
    const wrongComment: string[] = [];
    let checked = 0;

    for (const pin of pins) {
      const known = table.get(pin.repo);
      if (!known) continue;
      checked += 1;
      if (pin.sha !== known.sha) {
        wrongSha.push(
          `${pin.file}: \`${pin.repo}\` pinned to \`${pin.sha.slice(0, 12)}…\`, but the verified pin is \`${known.sha.slice(0, 12)}…\` (${known.version})`,
        );
      } else if (pin.comment && pin.comment !== known.version) {
        wrongComment.push(
          `${pin.file}: \`${pin.repo}\` carries \`# ${pin.comment}\` beside the SHA for ${known.version}`,
        );
      }
    }

    // A repo pinned two ways in one answer is wrong somewhere, table or not.
    const bySha = new Map<string, Set<string>>();
    for (const pin of pins) {
      if (!bySha.has(pin.repo)) bySha.set(pin.repo, new Set());
      bySha.get(pin.repo)!.add(pin.sha);
    }
    const inconsistent = [...bySha.entries()]
      .filter(([, shas]) => shas.size > 1)
      .map(([repo, shas]) => `\`${repo}\` pinned to ${shas.size} different SHAs across the produced files`);

    if (checked === 0 && inconsistent.length === 0) {
      return result(
        0.5,
        `${pins.length} SHA-pinned action(s), none of them in the skill's verified table - correctness of these pins is not decidable offline.`,
      );
    }

    const problems = [...wrongSha, ...inconsistent, ...wrongComment];
    if (problems.length === 0) {
      return result(
        1.0,
        `All ${checked} pin(s) drawn from the verified table match it exactly, version comments included.`,
      );
    }

    // A wrong SHA breaks the run; a stale comment only misleads Dependabot.
    const severe = wrongSha.length + inconsistent.length;
    const score = severe > 0 ? clampScore(0.3 * (1 - severe / Math.max(checked, severe))) : 0.8;
    return result(
      score,
      `${problems.join('. ')}. A pin that does not resolve fails the workflow on its first run; never write a SHA that was not looked up.`,
    );
  },
};

export default noFabricatedPinsEval;

runEval((ctx) => noFabricatedPinsEval.evaluate(ctx));
