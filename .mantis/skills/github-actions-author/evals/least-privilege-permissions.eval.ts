import type { Eval, EvalContext, EvalResult } from './types.js';
import { lintJson, memberPath, messagesFor, type EvalRule } from './eslint-runner.js';
import { makeResult, runEval } from './utils.js';
import { byPath, leafKey, loadWorkflows, splitPath } from './workflow-json.js';

const EVAL_ID = 'least-privilege-permissions';
const EVAL_NAME = 'GITHUB_TOKEN permissions are explicit and least-privilege';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * Where a `permissions:` block sits decides what it means:
 *   workflow -> `<file>.permissions`            (the floor every job inherits)
 *   job      -> `<file>.jobs.<id>.permissions`  (a widening for one job)
 * Anything else (a `permissions` key inside a step's `with:`, say) is not the
 * GITHUB_TOKEN scope and is ignored.
 */
type Level = 'workflow' | 'job' | 'other';

function levelOf(keys: string[]): Level {
  if (keys.length === 1 && keys[0] === 'permissions') return 'workflow';
  if (keys.length === 3 && keys[0] === 'jobs' && keys[2] === 'permissions') return 'job';
  return 'other';
}

/** Reports each `permissions:` block with its level and its serialized value. */
const permissionsRule: EvalRule = {
  create(context) {
    return {
      Member(node: any) {
        const path = memberPath(context, node);
        if (leafKey(path) !== 'permissions') return;
        const { file, keys } = splitPath(path);
        const level = levelOf(keys);
        if (level === 'other') return;
        // A scalar block is `permissions: write-all` / `read-all`; a mapping is the
        // per-scope form, whose keys the `scope` rule reports separately.
        const value: unknown = node.value?.value;
        const scalar = typeof value === 'string' ? value : '';
        context.report({ node, message: [file, level, keys[1] ?? '', scalar].join('\t') });
      },
    };
  },
};

/** Reports each individual scope inside a permissions mapping, e.g. `id-token: write`. */
const scopeRule: EvalRule = {
  create(context) {
    return {
      Member(node: any) {
        const path = memberPath(context, node);
        const { file, keys } = splitPath(path);
        const parent = keys.slice(0, -1);
        const level = levelOf(parent);
        if (level === 'other') return;
        const value: unknown = node.value?.value;
        if (typeof value !== 'string') return;
        context.report({
          node,
          message: [file, level, parent[1] ?? '', leafKey(path), value].join('\t'),
        });
      },
    };
  },
};

interface Block {
  file: string;
  level: Level;
  job: string;
  scalar: string;
}

interface Scope {
  file: string;
  level: Level;
  job: string;
  scope: string;
  access: string;
}

const leastPrivilegeEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable workflow YAML found - permissions not evaluated.');
    }
    // Only workflows carry a GITHUB_TOKEN scope. An action.yml cannot set one.
    const workflows = docs.filter((d) => d.kind === 'workflow');
    if (workflows.length === 0) {
      return result(0.5, 'No workflow files produced - only action metadata, which has no permissions block.');
    }

    const messages = await lintJson(byPath(workflows), {
      block: permissionsRule,
      scope: scopeRule,
    });

    const blocks: Block[] = messagesFor(messages, 'block').map((m) => {
      const [file, level, job, scalar] = m.message.split('\t');
      return { file, level: level as Level, job, scalar };
    });
    const scopes: Scope[] = messagesFor(messages, 'scope').map((m) => {
      const [file, level, job, scope, access] = m.message.split('\t');
      return { file, level: level as Level, job, scope, access };
    });

    const blanket = blocks.filter((b) => b.scalar === 'write-all' || b.scalar === 'read-all');
    if (blanket.length > 0) {
      const where = blanket.map((b) => `${b.file}${b.job ? ` job ${b.job}` : ''}: ${b.scalar}`);
      return result(
        0.0,
        `Blanket token scope instead of a least-privilege block: ${where.join('; ')}. ` +
          `Grant only the scopes each job needs, starting from \`contents: read\`.`,
      );
    }

    const filesWithFloor = new Set(blocks.filter((b) => b.level === 'workflow').map((b) => b.file));
    const missingFloor = workflows.map((w) => w.path).filter((p) => !filesWithFloor.has(p));

    if (blocks.length === 0) {
      return result(
        0.1,
        `No \`permissions:\` block in ${workflows.length} workflow file(s) - the job runs with whatever the repository default grants, historically write-all.`,
      );
    }

    // id-token: write mints a cloud credential. It belongs on the job that deploys,
    // so no other job in the workflow can assume the role.
    const idTokenWrite = scopes.filter((s) => s.scope === 'id-token' && s.access === 'write');
    const idTokenAtWorkflow = idTokenWrite.filter((s) => s.level === 'workflow');

    if (missingFloor.length > 0) {
      return result(
        0.7,
        `Per-job permissions are set, but ${missingFloor.join(', ')} has no workflow-level floor - a job added later inherits the repository default. Declare \`permissions: contents: read\` at the top.`,
      );
    }

    if (idTokenAtWorkflow.length > 0) {
      return result(
        0.6,
        `Workflow-level permissions are explicit, but \`id-token: write\` is granted workflow-wide in ${idTokenAtWorkflow.map((s) => s.file).join(', ')} - every job can then mint an OIDC token. Move it onto the deploying job.`,
      );
    }

    const widened = blocks.filter((b) => b.level === 'job');
    const detail = widened.length > 0
      ? ` ${widened.length} job(s) widen it explicitly (${widened.map((b) => b.job).join(', ')}).`
      : '';
    return result(
      1.0,
      `Every workflow declares an explicit least-privilege \`permissions\` floor.${detail}`,
    );
  },
};

export default leastPrivilegeEval;

runEval((ctx) => leastPrivilegeEval.evaluate(ctx));
