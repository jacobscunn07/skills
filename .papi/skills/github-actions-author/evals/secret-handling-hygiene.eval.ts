import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows, type WorkflowDoc } from './workflow-json.js';
import { actionRepo, actionSteps, envOf, interpolations, isObj, jobsOf, runOf, stepsOf, str, usesOf } from './workflow-walk.js';

const EVAL_ID = 'secret-handling-hygiene';
const EVAL_NAME = 'Secrets stay out of logs, argv, and jobs that do not need them';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * Log masking is the weakest of the protections around a secret, and it is the
 * one people rely on. It matches the exact stored string, so anything derived
 * from a secret - base64, a substring, a JSON re-encode - prints in the clear.
 * The habits that actually hold:
 *
 *   - never echo one, derived or not;
 *   - never pass one as a command-line argument, where it is visible in `ps` on
 *     the runner and in any action that logs its own argv;
 *   - bind it on the step that needs it, not the job, so an added step does not
 *     silently inherit it.
 */

interface Finding {
  where: string;
  what: string;
  weight: number;
}

const SECRET_EXPR = /secrets\.[A-Za-z0-9_-]+/;

/** `echo`/`printf` of a secret, however it is dressed up. */
const ECHOES = /\b(?:echo|printf|print|console\.log|cat\s*<<)\b/;

function steps(doc: WorkflowDoc): { where: string; step: Record<string, unknown>; jobEnv: Record<string, string>; job: Record<string, unknown> | null }[] {
  const out: { where: string; step: Record<string, unknown>; jobEnv: Record<string, string>; job: Record<string, unknown> | null }[] = [];
  if (doc.kind === 'workflow') {
    for (const { id, job } of jobsOf(doc.doc)) {
      for (const s of stepsOf(job)) {
        out.push({ where: `${doc.path} job \`${id}\` step \`${s.label}\``, step: s.step, jobEnv: envOf(job), job });
      }
    }
  } else {
    for (const s of actionSteps(doc.doc)) {
      out.push({ where: `${doc.path} step \`${s.label}\``, step: s.step, jobEnv: {}, job: null });
    }
  }
  return out;
}

const secretHygieneEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - secret handling not evaluated.');
    }

    const findings: Finding[] = [];
    let secretUses = 0;

    for (const doc of docs) {
      // Job-level `env:` carrying a secret leaks it to every step in the job.
      if (doc.kind === 'workflow') {
        for (const { id, job } of jobsOf(doc.doc)) {
          const jobSecrets = Object.entries(envOf(job)).filter(([, v]) => SECRET_EXPR.test(v));
          if (jobSecrets.length > 0 && stepsOf(job).length > 1) {
            findings.push({
              where: `${doc.path} job \`${id}\``,
              what: `binds ${jobSecrets.map(([k]) => `\`${k}\``).join(', ')} at job level, so all ${stepsOf(job).length} steps inherit it - bind it on the step that needs it`,
              weight: 1,
            });
          }
        }
      }

      for (const { where, step } of steps(doc)) {
        const script = runOf(step);
        const inlineSecrets = interpolations(script).filter((e) => SECRET_EXPR.test(e));
        secretUses += inlineSecrets.length;

        for (const line of script.split('\n')) {
          const secretsOnLine = interpolations(line).filter((e) => SECRET_EXPR.test(e));
          // A secret pasted into the script text is substituted before the shell
          // parses it, so it lands in the command line itself.
          if (secretsOnLine.length > 0) {
            findings.push({
              where,
              what: ECHOES.test(line)
                ? `echoes ${secretsOnLine[0]} - masking only covers the exact stored string, so anything derived from it prints in the clear`
                : `interpolates ${secretsOnLine[0]} into the command line, where it is visible in \`ps\` on the runner - pass it through \`env:\` and reference the variable`,
              weight: 2,
            });
          }
        }

        // The same mistake via an env-bound secret: bound correctly, then echoed.
        const boundNames = Object.entries(envOf(step))
          .filter(([, v]) => SECRET_EXPR.test(v))
          .map(([k]) => k);
        secretUses += boundNames.length;
        for (const line of script.split('\n')) {
          if (!ECHOES.test(line)) continue;
          const leaked = boundNames.filter((n) => new RegExp(`\\$\\{?${n}\\b`).test(line));
          if (leaked.length > 0) {
            findings.push({
              where,
              what: `echoes \`$${leaked[0]}\`, which holds a secret`,
              weight: 2,
            });
          }
        }

        // A secret handed to an action that is not pinned: the code that receives
        // it can be changed by whoever owns the tag.
        const uses = usesOf(step);
        if (uses && !uses.startsWith('./') && isObj(step.with)) {
          const givesSecret = Object.values(step.with).some((v) => SECRET_EXPR.test(str(v)));
          const pinned = /@[0-9a-f]{40}$/.test(uses) || uses.includes('@sha256:');
          if (givesSecret && !pinned) {
            findings.push({
              where,
              what: `passes a secret to \`${actionRepo(uses) || uses}\`, which is not pinned to a SHA - the owner of that tag can change what receives it`,
              weight: 2,
            });
          }
        }
      }
    }

    if (secretUses === 0 && findings.length === 0) {
      return result(0.5, 'No secrets referenced in the produced files - nothing to score.');
    }

    if (findings.length === 0) {
      return result(
        1.0,
        `${secretUses} secret reference(s), all bound through \`env:\` at step scope and none echoed or placed on a command line.`,
      );
    }

    const penalty = findings.reduce((s, f) => s + f.weight, 0);
    const unique = [...new Map(findings.map((f) => [`${f.where}${f.what}`, f])).values()];
    return result(
      clampScore(1 - penalty / (penalty + secretUses + 1)),
      `${unique.slice(0, 5).map((f) => `${f.where}: ${f.what}`).join('. ')}${unique.length > 5 ? ` (+${unique.length - 5} more)` : ''}.`,
    );
  },
};

export default secretHygieneEval;

runEval((ctx) => secretHygieneEval.evaluate(ctx));
