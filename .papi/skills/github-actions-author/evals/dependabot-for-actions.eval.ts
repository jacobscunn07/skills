import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import type { Eval, EvalContext, EvalResult } from './types.js';
import { makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';
import { actionRepo, actionSteps, isObj, jobsOf, stepsOf, usesOf } from './workflow-walk.js';

const EVAL_ID = 'dependabot-for-actions';
const EVAL_NAME = 'SHA pinning comes with something that updates the pins';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * Pinning to a SHA freezes the action, including its unfixed bugs and its
 * unpatched vulnerabilities. Pinning alone converts a supply-chain risk into a
 * staleness one; it is only the whole answer when something proposes the bumps.
 *
 * `.github/dependabot.yml` with the `github-actions` ecosystem is that something,
 * and it is why the skill requires the `# vX.Y.Z` comment beside each pin -
 * Dependabot reads the comment to know which version the SHA stands for.
 *
 * Scored gently: the file is a recommendation the scenarios never ask for, so a
 * missing one is a gap rather than a defect.
 */

const DEPENDABOT_PATHS = ['.github/dependabot.yml', '.github/dependabot.yaml'];

/** Whether a config enables the `github-actions` ecosystem. */
function coversActions(text: string): boolean {
  try {
    const doc = parse(text);
    if (!isObj(doc) || !Array.isArray(doc.updates)) return false;
    return doc.updates.some((u) => isObj(u) && u['package-ecosystem'] === 'github-actions');
  } catch {
    return /package-ecosystem:\s*["']?github-actions/.test(text);
  }
}

const dependabotEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - pin maintenance not evaluated.');
    }

    // Only third-party pins go stale; a local action has no upstream.
    let pinned = 0;
    for (const doc of docs) {
      const uses =
        doc.kind === 'workflow'
          ? jobsOf(doc.doc).flatMap(({ job }) => stepsOf(job).map((s) => usesOf(s.step)))
          : actionSteps(doc.doc).map((s) => usesOf(s.step));
      pinned += uses.filter((u) => actionRepo(u) && /@[0-9a-f]{40}$/.test(u)).length;
    }

    if (pinned === 0) {
      return result(0.5, 'No SHA-pinned third-party actions - no pins to keep current.');
    }

    for (const rel of DEPENDABOT_PATHS) {
      const path = join(ctx.workDir, rel);
      if (!existsSync(path)) continue;
      let text = '';
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      if (coversActions(text)) {
        return result(1.0, `${pinned} pin(s) kept current by \`${rel}\` with the \`github-actions\` ecosystem enabled.`);
      }
      return result(
        0.6,
        `\`${rel}\` exists but does not enable the \`github-actions\` ecosystem, so the ${pinned} SHA pin(s) will never be offered a bump.`,
      );
    }

    // Proposing the config in the reply is most of the value even unwritten.
    const transcript = ctx.qualityTranscript ?? '';
    if (/dependabot/i.test(transcript) && /github-actions/.test(transcript)) {
      return result(
        0.75,
        `${pinned} SHA pin(s); a \`github-actions\` Dependabot config is described in the reply but not written to \`.github/dependabot.yml\`.`,
      );
    }

    return result(
      0.4,
      `${pinned} action(s) pinned to a SHA with nothing to update them - the pins freeze today's code, including any vulnerability found in it later. Add \`.github/dependabot.yml\` with the \`github-actions\` ecosystem.`,
    );
  },
};

export default dependabotEval;

runEval((ctx) => dependabotEval.evaluate(ctx));
