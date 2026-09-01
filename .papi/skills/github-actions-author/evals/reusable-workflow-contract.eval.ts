import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows, type WorkflowDoc } from './workflow-json.js';
import { isObj, jobsOf, stepsOf, str, workflows } from './workflow-walk.js';

const EVAL_ID = 'reusable-workflow-contract';
const EVAL_NAME = 'Reusable workflow declares a typed interface the caller actually uses';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * A `workflow_call` workflow is an API, and its whole value over copy-paste is
 * that the interface is declared rather than implied. Three things make it one:
 *
 *   inputs   typed and described, so a caller knows what to pass without
 *            reading the implementation;
 *   secrets  named, because a callee cannot read the caller's secrets unless
 *            they are declared or blanket-inherited;
 *   outputs  wired back, so the caller can consume a result instead of
 *            recomputing it.
 *
 * The output path is the one that silently half-works: `on.workflow_call.outputs`
 * is three hops from the step that produces the value, and a break anywhere in
 * the chain yields an empty string at the caller rather than an error. This eval
 * walks all three hops.
 */

const NEEDS_OUTPUT_RE = /needs\.([\w-]+)\.outputs\.([\w-]+)/g;

interface Check {
  ok: boolean;
  weight: number;
  note: string;
}

/** The `${{ ... }}` body of a value that is a single expression, else ''. */
function soleExpression(value: unknown): string {
  const text = str(value).trim();
  const m = /^\$\{\{\s*([\s\S]+?)\s*\}\}$/.exec(text);
  return m ? m[1] : '';
}

function callSpec(doc: Record<string, unknown>): Record<string, unknown> | null {
  const on = doc.on;
  if (typeof on === 'string') return on === 'workflow_call' ? {} : null;
  if (Array.isArray(on)) return on.map(str).includes('workflow_call') ? {} : null;
  if (!isObj(on) || !('workflow_call' in on)) return null;
  return isObj(on.workflow_call) ? on.workflow_call : {};
}

/** Callers are jobs whose `uses:` points at a local workflow file. */
function callersOf(wfs: WorkflowDoc[], calleePath: string) {
  const base = calleePath.split('/').pop() ?? calleePath;
  const out: { file: string; job: string; spec: Record<string, unknown> }[] = [];
  for (const wf of wfs) {
    for (const { id, job } of jobsOf(wf.doc)) {
      const uses = str(job.uses);
      if (!uses) continue;
      if (uses.startsWith('./') && uses.split('/').pop() === base) {
        out.push({ file: wf.path, job: id, spec: job });
      }
    }
  }
  return out;
}

function checkInputs(spec: Record<string, unknown>): Check[] {
  if (!isObj(spec.inputs)) {
    return [{ ok: false, weight: 2, note: 'declares no `inputs` - callers have nothing to parameterize' }];
  }
  const entries = Object.entries(spec.inputs);
  const untyped: string[] = [];
  const undescribed: string[] = [];
  const unspecified: string[] = [];
  for (const [name, raw] of entries) {
    const def = isObj(raw) ? raw : {};
    if (!str(def.type)) untyped.push(name);
    if (!str(def.description)) undescribed.push(name);
    // Without either, a caller cannot tell whether omitting it is legal.
    if (def.required === undefined && def.default === undefined) unspecified.push(name);
  }
  return [
    {
      ok: untyped.length === 0,
      weight: 1,
      note: untyped.length ? `input(s) with no \`type\`: ${untyped.join(', ')} (defaults to string silently)` : '',
    },
    {
      ok: undescribed.length === 0,
      weight: 1,
      note: undescribed.length ? `input(s) with no \`description\`: ${undescribed.join(', ')}` : '',
    },
    {
      ok: unspecified.length === 0,
      weight: 1,
      note: unspecified.length ? `input(s) with neither \`required\` nor \`default\`: ${unspecified.join(', ')}` : '',
    },
  ];
}

/** Walks output -> job output -> step output -> `$GITHUB_OUTPUT` write. */
function checkOutputs(doc: Record<string, unknown>, spec: Record<string, unknown>): Check[] {
  if (!isObj(spec.outputs)) {
    return [{ ok: false, weight: 2, note: 'declares no `outputs` - the caller cannot read anything back' }];
  }
  const broken: string[] = [];
  for (const [name, raw] of Object.entries(spec.outputs)) {
    const def = isObj(raw) ? raw : {};
    const expr = soleExpression(def.value);
    const m = /^jobs\.([\w-]+)\.outputs\.([\w-]+)$/.exec(expr);
    if (!m) {
      broken.push(`\`${name}\` has no \`value:\` referencing a job output`);
      continue;
    }
    const [, jobId, key] = m;
    const job = jobsOf(doc).find((j) => j.id === jobId);
    if (!job) {
      broken.push(`\`${name}\` points at job \`${jobId}\`, which does not exist`);
      continue;
    }
    const jobOutputs = isObj(job.job.outputs) ? job.job.outputs : {};
    if (!(key in jobOutputs)) {
      broken.push(`\`${name}\` reads \`${jobId}.outputs.${key}\`, but that job declares no such output`);
      continue;
    }
    const stepExpr = soleExpression(jobOutputs[key]);
    const sm = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/.exec(stepExpr);
    if (!sm) {
      broken.push(`job output \`${jobId}.${key}\` is not wired to a step output`);
      continue;
    }
    const [, stepId] = sm;
    const step = stepsOf(job.job).find((s) => str(s.step.id) === stepId);
    if (!step) {
      broken.push(`job output \`${jobId}.${key}\` names step \`${stepId}\`, which has no matching \`id:\``);
      continue;
    }
    if (!/GITHUB_OUTPUT/.test(str(step.step.run))) {
      broken.push(`step \`${stepId}\` never writes to \`$GITHUB_OUTPUT\`, so \`${name}\` is always empty`);
    }
  }
  return [
    {
      ok: broken.length === 0,
      weight: 2,
      note: broken.length ? `broken output wiring: ${broken.join('; ')}` : '',
    },
  ];
}

const reusableContractEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable workflow YAML found - reusable workflow contract not evaluated.');
    }
    const wfs = workflows(docs);
    const callees = wfs.filter((wf) => callSpec(wf.doc) !== null);
    if (callees.length === 0) {
      return result(0.5, 'No `workflow_call` workflow produced - nothing to check a reusable interface on.');
    }

    const notes: string[] = [];
    const checks: Check[] = [];

    for (const callee of callees) {
      const spec = callSpec(callee.doc) as Record<string, unknown>;
      const local: Check[] = [...checkInputs(spec), ...checkOutputs(callee.doc, spec)];

      // A callee that names its secrets states what it needs; `secrets: inherit`
      // at the call site hands over every secret the caller holds.
      const declaresSecrets = isObj(spec.secrets) && Object.keys(spec.secrets).length > 0;
      const usesSecrets = JSON.stringify(callee.doc).includes('secrets.');
      if (usesSecrets) {
        local.push({
          ok: declaresSecrets,
          weight: 1,
          note: declaresSecrets ? '' : 'references `secrets.*` but declares no `secrets:` block, so the caller must blanket-inherit',
        });
      }

      const callers = callersOf(wfs, callee.path);
      if (callers.length === 0) {
        local.push({ ok: false, weight: 1, note: 'no caller workflow was produced alongside it' });
      } else {
        const required = isObj(spec.inputs)
          ? Object.entries(spec.inputs)
              .filter(([, d]) => isObj(d) && d.required === true)
              .map(([n]) => n)
          : [];
        for (const caller of callers) {
          const passed = isObj(caller.spec.with) ? Object.keys(caller.spec.with) : [];
          const missing = required.filter((r) => !passed.includes(r));
          local.push({
            ok: missing.length === 0,
            weight: 1,
            note: missing.length
              ? `caller ${caller.file} job \`${caller.job}\` omits required input(s): ${missing.join(', ')}`
              : '',
          });
          if (declaresSecrets) {
            const inherits = str(caller.spec.secrets) === 'inherit';
            local.push({
              ok: !inherits,
              weight: 1,
              note: inherits
                ? `caller ${caller.file} job \`${caller.job}\` uses \`secrets: inherit\`, passing every secret it holds rather than the declared one(s)`
                : '',
            });
          }
        }

        // Declaring an output nobody reads is a contract that was never used.
        const declared = isObj(spec.outputs) ? Object.keys(spec.outputs) : [];
        if (declared.length > 0) {
          const consumed = new Set<string>();
          for (const wf of wfs) {
            for (const m of JSON.stringify(wf.doc).matchAll(NEEDS_OUTPUT_RE)) consumed.add(m[2]);
          }
          const unread = declared.filter((d) => !consumed.has(d));
          local.push({
            ok: unread.length === 0,
            weight: 1,
            note: unread.length
              ? `output(s) declared but never read through \`needs.<job>.outputs\`: ${unread.join(', ')}`
              : '',
          });
        }
      }

      checks.push(...local);
      const failed = local.filter((c) => !c.ok && c.note);
      if (failed.length > 0) notes.push(`${callee.path}: ${failed.map((c) => c.note).join('; ')}`);
    }

    const total = checks.reduce((s, c) => s + c.weight, 0);
    const earned = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
    const score = clampScore(total === 0 ? 1 : earned / total);

    if (notes.length === 0) {
      return result(
        1.0,
        `${callees.length} reusable workflow(s) declare typed, described inputs, named secrets, and outputs wired through to a \`$GITHUB_OUTPUT\` write that a caller consumes.`,
      );
    }
    return result(score, notes.join('. ') + '.');
  },
};

export default reusableContractEval;

runEval((ctx) => reusableContractEval.evaluate(ctx));
