import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows, type WorkflowDoc } from './workflow-json.js';
import { actionRepo, actionSteps, jobsOf, runOf, stepsOf, str, usesOf, withOf, type Step } from './workflow-walk.js';

const EVAL_ID = 'cache-correctness';
const EVAL_NAME = 'Dependency cache keys invalidate when dependencies change';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * A wrong cache key is worse than no cache, and it fails silently in both
 * directions:
 *
 *   - a key with no `hashFiles(...)` of the lockfile never invalidates, so the
 *     job keeps restoring stale dependencies after the lockfile changes, and CI
 *     tests a tree nobody committed;
 *   - a key with no `runner.os` is shared across platforms, so a matrix restores
 *     Linux binaries onto macOS.
 *
 * The `setup-*` actions implement all of this already, which is why the skill
 * prefers their `cache:` input to a hand-rolled `actions/cache`.
 */

/** `setup-*` actions whose `cache:` input handles the whole thing. */
const SETUP_WITH_CACHE: Record<string, string> = {
  'actions/setup-node': 'npm/yarn/pnpm',
  'actions/setup-python': 'pip/pipenv/poetry',
  'actions/setup-java': 'maven/gradle',
  'actions/setup-go': 'go modules',
  'actions/setup-dotnet': 'nuget',
  'ruby/setup-ruby': 'bundler',
};

const INSTALL_RE = /\b(?:npm\s+(?:ci|install)|yarn\s+install|pnpm\s+install|pip\s+install|bundle\s+install|go\s+mod\s+download|mvn\s|gradle\s)/;

interface CacheStep {
  where: string;
  key: string;
  restoreKeys: string;
  /** A `setup-*` in the same job that would have done this for free. */
  redundantWith: string;
}

function allSteps(doc: WorkflowDoc): { where: string; step: Step; siblings: Step[] }[] {
  const out: { where: string; step: Step; siblings: Step[] }[] = [];
  if (doc.kind === 'workflow') {
    for (const { id, job } of jobsOf(doc.doc)) {
      const siblings = stepsOf(job);
      for (const s of siblings) out.push({ where: `${doc.path} job \`${id}\``, step: s, siblings });
    }
  } else {
    const siblings = actionSteps(doc.doc);
    for (const s of siblings) out.push({ where: doc.path, step: s, siblings });
  }
  return out;
}

const cacheCorrectnessEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - caching not evaluated.');
    }

    const manual: CacheStep[] = [];
    const builtIn: string[] = [];
    let installs = 0;

    for (const doc of docs) {
      for (const { where, step, siblings } of allSteps(doc)) {
        if (INSTALL_RE.test(runOf(step.step))) installs += 1;

        const repo = actionRepo(usesOf(step.step));
        const w = withOf(step.step);

        if (repo in SETUP_WITH_CACHE && str(w.cache) !== '') {
          builtIn.push(`${repo} \`cache: ${str(w.cache)}\``);
          continue;
        }
        if (repo === 'actions/cache') {
          const setup = siblings
            .map((s) => actionRepo(usesOf(s.step)))
            .find((r) => r in SETUP_WITH_CACHE);
          manual.push({
            where,
            key: str(w.key),
            restoreKeys: str(w['restore-keys']),
            redundantWith: setup ?? '',
          });
        }
      }
    }

    if (manual.length === 0 && builtIn.length === 0) {
      if (installs === 0) {
        return result(0.5, 'No dependency installation or caching steps - nothing to score.');
      }
      return result(
        0.3,
        `${installs} dependency install step(s) with no caching at all - every run downloads the whole tree again. Use the \`setup-*\` action's \`cache:\` input.`,
      );
    }

    const problems: string[] = [];
    for (const c of manual) {
      const hashed = /hashFiles\s*\(/.test(c.key);
      // A key invalidates if something in it changes when the cached content
      // does. `hashFiles` of a lockfile is the spelling for dependency caches; a
      // toolchain cache keyed on the version it installed is equally correct, and
      // demanding a lockfile hash there would be wrong.
      const varies = hashed || /\$\{\{\s*(?:inputs|matrix|steps|env|needs|github)\./.test(c.key);
      if (!varies) {
        problems.push(
          `${c.where}: \`actions/cache\` key \`${c.key || '(empty)'}\` is static - nothing in it changes when the cached content does, so the first entry is restored forever`,
        );
      }
      if (!/runner\.os|matrix\.os/.test(c.key)) {
        problems.push(
          `${c.where}: cache key does not vary by \`runner.os\`, so matrix legs on different platforms share one entry`,
        );
      }
      // A near-miss prefix only helps a key that changes on every lockfile edit.
      if (hashed && !c.restoreKeys) {
        problems.push(
          `${c.where}: no \`restore-keys\` prefix, so any lockfile change gives a cold cache instead of a near-miss`,
        );
      }
      if (c.redundantWith) {
        problems.push(
          `${c.where}: hand-rolled \`actions/cache\` alongside \`${c.redundantWith}\`, whose \`cache:\` input already handles ${SETUP_WITH_CACHE[c.redundantWith]}`,
        );
      }
    }

    if (problems.length === 0) {
      const how = builtIn.length > 0 ? `built-in caching (${[...new Set(builtIn)].join(', ')})` : 'correctly keyed `actions/cache`';
      return result(1.0, `Dependencies cached via ${how}${manual.length ? `; ${manual.length} manual cache step(s) key on the runner OS and a value that changes with the cached content` : ''}.`);
    }
    return result(clampScore(1 - 0.3 * problems.length), `${problems.join('. ')}.`);
  },
};

export default cacheCorrectnessEval;

runEval((ctx) => cacheCorrectnessEval.evaluate(ctx));
