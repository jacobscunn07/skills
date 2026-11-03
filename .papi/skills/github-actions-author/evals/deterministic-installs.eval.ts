import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows, type WorkflowDoc } from './workflow-json.js';
import { actionSteps, jobsOf, runOf, stepsOf } from './workflow-walk.js';

const EVAL_ID = 'deterministic-installs';
const EVAL_NAME = 'Dependencies installed from the lockfile, not resolved afresh';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * `npm install` resolves versions again and rewrites the lockfile, so CI can build
 * a different dependency tree than the one that was reviewed, and a run is not
 * reproducible from its commit. `npm ci` installs the lockfile exactly and fails
 * if it disagrees with the manifest - which is the behaviour CI wants.
 *
 * Only install commands are scored. `npm run build`, `npm test` and friends are
 * not installs and are left alone.
 */

interface Rule {
  /** Matches the non-deterministic spelling. */
  bad: RegExp;
  /** Present anywhere in the same command, this makes it deterministic after all. */
  exempt?: RegExp;
  fix: string;
}

const RULES: Rule[] = [
  {
    bad: /\bnpm\s+(?:install|i)\b(?!\s+-g)/,
    fix: '`npm ci` installs exactly what package-lock.json pins',
  },
  {
    bad: /\byarn\s+install\b/,
    exempt: /--(?:frozen-lockfile|immutable)\b/,
    fix: '`yarn install --frozen-lockfile` (v1) or `--immutable` (berry)',
  },
  {
    bad: /\bbundle\s+install\b/,
    exempt: /--deployment\b|frozen/,
    fix: '`bundle install --deployment` honours Gemfile.lock strictly',
  },
  {
    bad: /\bgo\s+get\b/,
    fix: '`go mod download` in CI; `go get` mutates go.mod',
  },
];

/** Every `run:` script in a workflow or composite action, with where it came from. */
function scripts(doc: WorkflowDoc): { where: string; code: string }[] {
  const out: { where: string; code: string }[] = [];
  if (doc.kind === 'workflow') {
    for (const { id, job } of jobsOf(doc.doc)) {
      for (const s of stepsOf(job)) {
        const code = runOf(s.step);
        if (code) out.push({ where: `${doc.path} job \`${id}\` step \`${s.label}\``, code });
      }
    }
  } else {
    for (const s of actionSteps(doc.doc)) {
      const code = runOf(s.step);
      if (code) out.push({ where: `${doc.path} step \`${s.label}\``, code });
    }
  }
  return out;
}

const deterministicInstallsEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - install determinism not evaluated.');
    }

    const findings: string[] = [];
    let installs = 0;

    for (const doc of docs) {
      for (const { where, code } of scripts(doc)) {
        // A script is many commands; judge each line so an exemption on one
        // command does not excuse another.
        for (const line of code.split('\n')) {
          for (const rule of RULES) {
            if (!rule.bad.test(line)) continue;
            installs += 1;
            if (rule.exempt?.test(line)) continue;
            findings.push(`${where}: \`${line.trim().slice(0, 60)}\` - ${rule.fix}`);
          }
        }
      }
    }

    // Count the deterministic spellings too, so "nothing found" is distinguishable
    // from "there were no installs at all".
    const deterministic = docs
      .flatMap((d) => scripts(d))
      .filter(({ code }) => /\bnpm\s+ci\b|--frozen-lockfile|--immutable|\bgo\s+mod\s+download\b|\bpip\s+install\s+-r\b/.test(code)).length;

    if (installs === 0 && deterministic === 0) {
      return result(0.5, 'No dependency installation steps found - nothing to score.');
    }
    if (findings.length === 0) {
      return result(
        1.0,
        `All ${deterministic} install step(s) resolve from the lockfile, so a rerun builds the same tree.`,
      );
    }
    return result(
      clampScore(1 - findings.length / (findings.length + deterministic + 1)),
      `${findings.join('. ')}. A CI run should build the reviewed dependency tree, not re-resolve one.`,
    );
  },
};

export default deterministicInstallsEval;

runEval((ctx) => deterministicInstallsEval.evaluate(ctx));
