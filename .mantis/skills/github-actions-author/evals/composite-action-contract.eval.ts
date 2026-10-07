import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';
import { actionSteps, actions, isObj, runOf, str, usesOf } from './workflow-walk.js';

const EVAL_ID = 'composite-action-contract';
const EVAL_NAME = 'Composite action declares a complete, wired `action.yml` interface';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * `action.yml` is the only documentation a composite action has - the marketplace
 * renders it, and `inputs.<x>.description` is what a consumer reads instead of the
 * implementation. Two failures here are not style issues:
 *
 *   - a `run:` step with no `shell:` is a hard error. Composite steps have no
 *     default shell, unlike workflow steps, and the action fails at runtime.
 *   - an output whose `value:` does not trace to a step that writes
 *     `$GITHUB_OUTPUT` resolves to an empty string with no error anywhere.
 *
 * Both survive review easily because the YAML looks complete.
 */

interface Check {
  ok: boolean;
  weight: number;
  note: string;
}

function soleExpression(value: unknown): string {
  const m = /^\$\{\{\s*([\s\S]+?)\s*\}\}$/.exec(str(value).trim());
  return m ? m[1] : '';
}

const compositeContractEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - action metadata not evaluated.');
    }
    const acts = actions(docs);
    if (acts.length === 0) {
      return result(0.5, 'No `action.yml` produced - no custom action to check.');
    }

    const checks: Check[] = [];
    const notes: string[] = [];

    for (const act of acts) {
      const doc = act.doc;
      const runs = isObj(doc.runs) ? doc.runs : {};
      const using = str(runs.using);
      const local: Check[] = [];

      local.push({
        ok: str(doc.name) !== '',
        weight: 1,
        note: str(doc.name) ? '' : 'no top-level `name:`',
      });
      local.push({
        ok: str(doc.description) !== '',
        weight: 1,
        note: str(doc.description) ? '' : 'no top-level `description:` - required, and the marketplace renders it',
      });

      // A JS/Docker action is a different shape; only score what applies to it.
      const isComposite = using === 'composite';

      const inputs = isObj(doc.inputs) ? doc.inputs : {};
      const undescribed = Object.entries(inputs)
        .filter(([, d]) => !isObj(d) || !str(d.description))
        .map(([n]) => n);
      if (Object.keys(inputs).length > 0) {
        local.push({
          ok: undescribed.length === 0,
          weight: 1,
          note: undescribed.length ? `input(s) with no \`description\`: ${undescribed.join(', ')}` : '',
        });
      }

      if (isComposite) {
        const steps = actionSteps(doc);
        local.push({
          ok: steps.length > 0,
          weight: 1,
          note: steps.length ? '' : '`runs.using: composite` but no `runs.steps`',
        });

        // The failure that stops the action running at all.
        const noShell = steps
          .filter((s) => runOf(s.step).trim() !== '' && str(s.step.shell) === '')
          .map((s) => s.label);
        if (steps.some((s) => runOf(s.step).trim() !== '')) {
          local.push({
            ok: noShell.length === 0,
            weight: 3,
            note: noShell.length
              ? `\`run:\` step(s) with no \`shell:\`, which fails at runtime in a composite action: ${noShell.join(', ')}`
              : '',
          });
        }

        // Composite steps read `inputs.x`; `env.INPUT_X` is the JS-action spelling
        // and is simply undefined here.
        const body = JSON.stringify(doc);
        const wrongInputRef = Object.keys(inputs).filter((n) =>
          new RegExp(`env\\.INPUT_${n.replace(/-/g, '_').toUpperCase()}\\b`).test(body),
        );
        if (wrongInputRef.length > 0) {
          local.push({
            ok: false,
            weight: 1,
            note: `input(s) read as \`env.INPUT_*\`, which is undefined in a composite action - use \`inputs.<name>\`: ${wrongInputRef.join(', ')}`,
          });
        }

        const outputs = isObj(doc.outputs) ? doc.outputs : {};
        const broken: string[] = [];
        for (const [name, raw] of Object.entries(outputs)) {
          const def = isObj(raw) ? raw : {};
          if (!str(def.description)) broken.push(`\`${name}\` has no \`description\``);
          const m = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/.exec(soleExpression(def.value));
          if (!m) {
            broken.push(`\`${name}\` has no \`value:\` referencing a step output`);
            continue;
          }
          const step = actionSteps(doc).find((s) => str(s.step.id) === m[1]);
          if (!step) {
            broken.push(`\`${name}\` names step \`${m[1]}\`, which has no matching \`id:\``);
            continue;
          }
          if (!/GITHUB_OUTPUT/.test(runOf(step.step))) {
            broken.push(`step \`${m[1]}\` never writes \`$GITHUB_OUTPUT\`, so \`${name}\` is always empty`);
          }
        }
        if (Object.keys(outputs).length > 0) {
          local.push({
            ok: broken.length === 0,
            weight: 2,
            note: broken.length ? `broken output wiring: ${broken.join('; ')}` : '',
          });
        }

        // A composite action cannot narrow the token or pick a runner; those keys
        // are silently ignored rather than rejected.
        const illegal = ['permissions', 'runs-on', 'secrets'].filter((k) => k in doc);
        if (illegal.length > 0) {
          local.push({
            ok: false,
            weight: 1,
            note: `\`${illegal.join('`, `')}\` at the top level of an action, where it has no effect`,
          });
        }
      } else if (using) {
        local.push({
          ok: /^node\d+$/.test(using) || using === 'docker',
          weight: 1,
          note: /^node(?:12|16)$/.test(using)
            ? `\`runs.using: ${using}\` is past end of life and no longer runs on GitHub-hosted runners`
            : '',
        });
      } else {
        local.push({ ok: false, weight: 2, note: 'no `runs.using:` - the action cannot execute' });
      }

      checks.push(...local);
      const failed = local.filter((c) => !c.ok && c.note);
      if (failed.length > 0) notes.push(`${act.path}: ${failed.map((c) => c.note).join('; ')}`);
    }

    const total = checks.reduce((s, c) => s + c.weight, 0);
    const earned = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
    const score = clampScore(total === 0 ? 1 : earned / total);

    if (notes.length === 0) {
      return result(
        1.0,
        `${acts.length} action(s) declare name, description, described inputs, a shell on every \`run:\` step, and outputs wired to a \`$GITHUB_OUTPUT\` write.`,
      );
    }
    return result(score, notes.join('. ') + '.');
  },
};

export default compositeContractEval;

runEval((ctx) => compositeContractEval.evaluate(ctx));
