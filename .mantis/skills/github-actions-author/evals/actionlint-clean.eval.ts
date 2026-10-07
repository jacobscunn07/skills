import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { Eval, EvalContext, EvalResult } from './types.js';
import { makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';

const execFileAsync = promisify(execFile);

const EVAL_ID = 'actionlint-clean';
const EVAL_NAME = 'Workflows pass actionlint';

const result = makeResult(EVAL_ID, EVAL_NAME);

// shellcheck and pyflakes integration is disabled: whether they happen to be
// installed on the machine running the loop would otherwise change the score of
// an unchanged skill.
const FLAGS = ['-no-color', '-oneline', '-shellcheck=', '-pyflakes='];

/** actionlint prints one `file:line:col: message` per problem with -oneline. */
function countProblems(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^.+:\d+:\d+: /.test(l));
}

interface Run {
  problems: string[];
  missing: boolean;
  crashed: string;
}

async function runActionlint(files: string[], cwd: string): Promise<Run> {
  try {
    await execFileAsync('actionlint', [...FLAGS, ...files], { cwd, maxBuffer: 4 * 1024 * 1024 });
    return { problems: [], missing: false, crashed: '' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown };
    if (e.code === 'ENOENT') return { problems: [], missing: true, crashed: '' };
    const problems = countProblems(e.stdout ?? '');
    if (problems.length === 0) {
      // Exit non-zero with nothing parseable on stdout: a usage or I/O failure,
      // not a workflow finding.
      return { problems: [], missing: false, crashed: (e.stderr ?? e.message).slice(0, 300) };
    }
    return { problems, missing: false, crashed: '' };
  }
}

const actionlintCleanEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    // actionlint lints workflows only; action.yml metadata is not a workflow file.
    const workflows = docs.filter((d) => d.kind === 'workflow');
    if (workflows.length === 0) {
      return result(0.5, 'No workflow files produced - nothing for actionlint to check.');
    }

    let cwd = ctx.workDir;
    let files = workflows.map((w) => w.path);
    let temp = '';
    if (source !== 'workdir') {
      // Transcript-recovered YAML has to land under .github/workflows before
      // actionlint will treat it as a workflow at all.
      temp = mkdtempSync(join(tmpdir(), 'actionlint-eval-'));
      mkdirSync(join(temp, '.github', 'workflows'), { recursive: true });
      files = workflows.map((w, i) => {
        const rel = join('.github', 'workflows', `block-${i}.yml`);
        writeFileSync(join(temp, rel), w.raw, 'utf8');
        return rel;
      });
      cwd = temp;
    }

    try {
      const { problems, missing, crashed } = await runActionlint(files, cwd);

      if (missing) {
        return result(0.5, 'actionlint is not installed on this machine - workflow validity not checked.');
      }
      if (crashed) {
        return result(0.5, `actionlint could not run: ${crashed}`);
      }
      if (problems.length === 0) {
        return result(1.0, `actionlint reports no problems across ${files.length} workflow file(s).`);
      }

      const shown = problems.slice(0, 5).join(' | ');
      const score = problems.length <= 2 ? 0.6 : problems.length <= 5 ? 0.4 : 0.2;
      return result(
        score,
        `actionlint reports ${problems.length} problem(s) across ${files.length} file(s): ${shown}` +
          (problems.length > 5 ? ' ...' : ''),
      );
    } finally {
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  },
};

export default actionlintCleanEval;

runEval((ctx) => actionlintCleanEval.evaluate(ctx));
