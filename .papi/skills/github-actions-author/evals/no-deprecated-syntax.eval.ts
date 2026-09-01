import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows, type WorkflowDoc } from './workflow-json.js';
import { actionRepo, actionSteps, allStrings, isObj, jobsOf, stepsOf, str, usesOf } from './workflow-walk.js';

const EVAL_ID = 'no-deprecated-syntax';
const EVAL_NAME = 'No removed or end-of-life Actions syntax';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * Everything here parses, and actionlint passes it. It fails when GitHub runs it,
 * which is the worst place to find out. These are the constructs that have been
 * switched off rather than merely discouraged.
 */

/** Workflow commands GitHub removed outright; they now do nothing. */
const REMOVED_COMMANDS: [RegExp, string][] = [
  [/::set-output\s+name=/, '`::set-output` was removed - write `"k=v" >> "$GITHUB_OUTPUT"`'],
  [/::save-state\s+name=/, '`::save-state` was removed - write `"k=v" >> "$GITHUB_STATE"`'],
  [/::set-env\s+name=/, '`::set-env` was removed - write `"k=v" >> "$GITHUB_ENV"`'],
  [/::add-path::/, '`::add-path` was removed - write the path to `$GITHUB_PATH`'],
];

/**
 * Lowest major of a first-party action that still runs. Below these the action is
 * not deprecated-but-working, it is switched off (the v3 artifact backend was shut
 * down) or running on an EOL Node the runners no longer provide.
 */
const MIN_MAJOR: Record<string, number> = {
  'actions/upload-artifact': 4,
  'actions/download-artifact': 4,
  'actions/cache': 4,
  'actions/checkout': 4,
  'actions/setup-node': 4,
  'actions/setup-python': 5,
  'actions/setup-java': 4,
  'actions/setup-go': 5,
  'actions/github-script': 7,
};

/** Runner labels that have been retired from GitHub-hosted runners. */
const RETIRED_RUNNERS =
  /^(?:ubuntu-(?:16\.04|18\.04|20\.04)|macos-(?:10\.15|11|12)|windows-(?:2016|2019))$/;

/** Action runtimes the runner no longer ships. */
const DEAD_RUNTIME = /^node(?:12|16)$/;

interface Finding {
  file: string;
  what: string;
  severe: boolean;
}

/** The major version of a `uses:`, from its tag or from the `# vX` pin comment. */
function majorOf(uses: string, raw: string): number | null {
  const ref = uses.split('@')[1] ?? '';
  const tag = /^v(\d+)/.exec(ref);
  if (tag) return Number(tag[1]);
  const escaped = uses.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`uses:\\s*${escaped}\\s*#\\s*v(\\d+)`).exec(raw);
  return m ? Number(m[1]) : null;
}

function usesOfDoc(doc: WorkflowDoc): string[] {
  const out: string[] = [];
  if (doc.kind === 'workflow') {
    for (const { job } of jobsOf(doc.doc)) {
      for (const s of stepsOf(job)) if (usesOf(s.step)) out.push(usesOf(s.step));
    }
  } else {
    for (const s of actionSteps(doc.doc)) if (usesOf(s.step)) out.push(usesOf(s.step));
  }
  return out;
}

const noDeprecatedSyntaxEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - deprecated syntax not evaluated.');
    }

    const findings: Finding[] = [];

    for (const doc of docs) {
      for (const [re, message] of REMOVED_COMMANDS) {
        if (allStrings(doc.doc).some((s) => re.test(s))) {
          findings.push({ file: doc.path, what: message, severe: true });
        }
      }

      for (const uses of usesOfDoc(doc)) {
        const repo = actionRepo(uses);
        const min = MIN_MAJOR[repo];
        if (min === undefined) continue;
        const major = majorOf(uses, doc.raw);
        if (major !== null && major < min) {
          findings.push({
            file: doc.path,
            what: `\`${repo}\` at v${major}; v${min} is the lowest that still runs`,
            severe: repo.includes('artifact') || repo === 'actions/cache',
          });
        }
      }

      if (doc.kind === 'workflow') {
        for (const { id, job } of jobsOf(doc.doc)) {
          const labels = Array.isArray(job['runs-on'])
            ? job['runs-on'].map(str)
            : [str(job['runs-on'])];
          for (const label of labels) {
            if (RETIRED_RUNNERS.test(label)) {
              findings.push({
                file: doc.path,
                what: `job \`${id}\` targets retired runner \`${label}\``,
                severe: true,
              });
            }
          }
        }
      } else if (isObj(doc.doc.runs)) {
        const using = str(doc.doc.runs.using);
        if (DEAD_RUNTIME.test(using)) {
          findings.push({
            file: doc.path,
            what: `\`runs.using: ${using}\` is past end of life on GitHub-hosted runners`,
            severe: true,
          });
        }
      }
    }

    if (findings.length === 0) {
      return result(
        1.0,
        `No removed workflow commands, end-of-life action majors, retired runner labels, or dead action runtimes across ${docs.length} file(s).`,
      );
    }

    const severe = findings.filter((f) => f.severe).length;
    const score = severe > 0 ? clampScore(0.2 - 0.05 * (severe - 1)) : clampScore(0.7 - 0.1 * findings.length);
    return result(
      score,
      `${findings.map((f) => `${f.file}: ${f.what}`).join('. ')}. These parse and pass actionlint, then fail at runtime.`,
    );
  },
};

export default noDeprecatedSyntaxEval;

runEval((ctx) => noDeprecatedSyntaxEval.evaluate(ctx));
