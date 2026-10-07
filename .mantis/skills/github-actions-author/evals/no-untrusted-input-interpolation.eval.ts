import type { Eval, EvalContext, EvalResult } from './types.js';
import { lintJson, memberPath, messagesFor, type EvalRule } from './eslint-runner.js';
import { makeResult, runEval } from './utils.js';
import { byPath, leafKey, loadWorkflows, splitPath } from './workflow-json.js';

const EVAL_ID = 'no-untrusted-input-interpolation';
const EVAL_NAME = 'No attacker-controlled input interpolated into a shell';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * `${{ ... }}` is substituted into the script before the shell parses it, so any
 * context a contributor can write into becomes a command. The fix is always the
 * same: bind the value to an `env:` entry and reference `$VAR`, which arrives as
 * data rather than as source text.
 *
 * These are the contexts a fork PR, an issue, or a comment can set.
 */
const UNTRUSTED = [
  /github\.event\.(?:pull_request|issue|discussion)\.(?:title|body)/,
  /github\.event\.(?:comment|review|review_comment)\.body/,
  /github\.event\.pull_request\.head\.(?:ref|label|repo\.[\w.]+)/,
  /github\.event\.commits\[[^\]]*\]\.(?:message|author\.(?:name|email))/,
  /github\.event\.commits\.[\w.]*(?:message|email|name)/,
  /github\.event\.head_commit\.(?:message|author\.(?:name|email))/,
  /github\.event\.workflow_run\.head_(?:branch|commit\.message)/,
  /github\.event\.issue\.pull_request\.body/,
  /github\.head_ref\b/,
  /github\.event\.pages\[[^\]]*\]\.page_name/,
];

/** The `${{ ... }}` expressions inside a string. */
function interpolations(text: string): string[] {
  return (text.match(/\$\{\{[^}]*\}\}/g) ?? []).map((s) => s.trim());
}

function untrustedIn(text: string): string[] {
  return interpolations(text).filter((expr) => UNTRUSTED.some((re) => re.test(expr)));
}

/**
 * Keys whose value is executed as source: a shell script (`run`), or the JS body
 * `actions/github-script` evaluates (`script`, always under a step's `with:`).
 */
function isExecuted(path: string[]): boolean {
  const leaf = leafKey(path);
  if (leaf === 'run') return true;
  return leaf === 'script' && path[path.length - 2] === 'with';
}

/** Reports every executed string that interpolates an attacker-controlled context. */
const injectionRule: EvalRule = {
  create(context) {
    return {
      Member(node: any) {
        const path = memberPath(context, node);
        if (!isExecuted(path)) return;
        const value: unknown = node.value?.value;
        if (typeof value !== 'string') return;
        const bad = untrustedIn(value);
        if (bad.length === 0) return;
        context.report({ node, message: `${splitPath(path).file}\t${bad.join(', ')}` });
      },
    };
  },
};

/** Reports executed strings at all, so "no violations" can be told from "no scripts". */
const executedRule: EvalRule = {
  create(context) {
    return {
      Member(node: any) {
        const path = memberPath(context, node);
        if (!isExecuted(path)) return;
        if (typeof node.value?.value !== 'string') return;
        context.report({ node, message: splitPath(path).file });
      },
    };
  },
};

/** Reports `env:` values that safely carry an untrusted context into a script. */
const envBindingRule: EvalRule = {
  create(context) {
    return {
      Member(node: any) {
        const path = memberPath(context, node);
        const { keys } = splitPath(path);
        if (keys[keys.length - 2] !== 'env') return;
        const value: unknown = node.value?.value;
        if (typeof value !== 'string') return;
        if (untrustedIn(value).length === 0) return;
        context.report({ node, message: leafKey(path) });
      },
    };
  },
};

const noUntrustedInterpolationEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable workflow YAML found - script injection not evaluated.');
    }

    const messages = await lintJson(byPath(docs), {
      injection: injectionRule,
      executed: executedRule,
      env: envBindingRule,
    });

    const violations = messagesFor(messages, 'injection');
    if (violations.length > 0) {
      const shown = violations
        .slice(0, 4)
        .map((m) => {
          const [file, exprs] = m.message.split('\t');
          return `${file}: ${exprs}`;
        })
        .join('; ');
      return result(
        0.1,
        `${violations.length} script step(s) interpolate attacker-controlled input directly into the shell: ${shown}` +
          (violations.length > 4 ? ' ...' : '') +
          `. Bind the value to an \`env:\` entry and reference it as a shell variable instead.`,
      );
    }

    const executed = messagesFor(messages, 'executed');
    if (executed.length === 0) {
      return result(0.5, 'No `run:` or `script:` steps found - nothing could be injected into.');
    }

    const bound = messagesFor(messages, 'env');
    if (bound.length > 0) {
      return result(
        1.0,
        `${executed.length} script step(s), none interpolating untrusted input; ${bound.length} untrusted value(s) correctly passed through \`env:\` (${bound.map((m) => m.message).join(', ')}).`,
      );
    }
    return result(
      1.0,
      `${executed.length} script step(s), none interpolating attacker-controlled context into the shell.`,
    );
  },
};

export default noUntrustedInterpolationEval;

runEval((ctx) => noUntrustedInterpolationEval.evaluate(ctx));
