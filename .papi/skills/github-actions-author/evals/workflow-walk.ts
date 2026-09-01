import type { WorkflowDoc } from './workflow-json.js';

/**
 * Typed accessors over a parsed workflow or action document.
 *
 * `eslint-runner.ts` is the right tool when a finding is a property that is
 * *present* and wrong: rules report it and `memberPath` names it. It cannot
 * express two other things these evals need, because `memberPath` makes array
 * nesting transparent - every step of a job reports the same path:
 *
 *   - absence ("this checkout step has no `persist-credentials`"), which no
 *     visitor fires for;
 *   - correlation ("*this* step both runs a script and lacks a `shell`").
 *
 * Those checks walk the document directly, through this module, so the walking
 * lives in one place rather than in each eval.
 */

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Scalars as text; anything else as ''. Workflow YAML is stringly typed. */
export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export interface Job {
  id: string;
  job: Record<string, unknown>;
}

export interface Step {
  /** Position within its job, so a finding can name the step that caused it. */
  index: number;
  step: Record<string, unknown>;
  /** `name:`, else `uses:`, else the first line of `run:`, else `step N`. */
  label: string;
}

export function jobsOf(doc: Record<string, unknown>): Job[] {
  if (!isObj(doc.jobs)) return [];
  return Object.entries(doc.jobs)
    .filter(([, job]) => isObj(job))
    .map(([id, job]) => ({ id, job: job as Record<string, unknown> }));
}

function label(step: Record<string, unknown>, index: number): string {
  const name = str(step.name);
  if (name) return name;
  const uses = str(step.uses);
  if (uses) return uses;
  const run = str(step.run).trim().split('\n')[0];
  if (run) return run.length > 40 ? `${run.slice(0, 40)}...` : run;
  return `step ${index + 1}`;
}

function toSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  const out: Step[] = [];
  for (const [index, s] of raw.entries()) {
    if (!isObj(s)) continue;
    out.push({ index, step: s, label: label(s, index) });
  }
  return out;
}

export function stepsOf(job: Record<string, unknown>): Step[] {
  return toSteps(job.steps);
}

/** The steps of a composite action, which live under `runs.steps`. */
export function actionSteps(doc: Record<string, unknown>): Step[] {
  return isObj(doc.runs) ? toSteps(doc.runs.steps) : [];
}

/**
 * Event names from `on:`, which is a string, a sequence, or a mapping.
 * (`on` survives as a string key: the `yaml` package is YAML 1.2, where the
 * 1.1 boolean-ish spelling of `on` no longer applies.)
 */
export function triggersOf(doc: Record<string, unknown>): string[] {
  const on = doc.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(str).filter(Boolean);
  if (isObj(on)) return Object.keys(on);
  return [];
}

export function usesOf(step: Record<string, unknown>): string {
  return str(step.uses);
}

export function runOf(step: Record<string, unknown>): string {
  return str(step.run);
}

export function withOf(step: Record<string, unknown>): Record<string, unknown> {
  return isObj(step.with) ? step.with : {};
}

/** An `env:` block as strings, from a workflow, job, or step. */
export function envOf(node: Record<string, unknown>): Record<string, string> {
  if (!isObj(node.env)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.env)) out[k] = str(v);
  return out;
}

/** The `owner/repo` of a `uses:`, without the ref. Empty for local/docker refs. */
export function actionRepo(uses: string): string {
  if (!uses || uses.startsWith('./') || uses.startsWith('docker://')) return '';
  const [path] = uses.split('@');
  return path.split('/').slice(0, 2).join('/');
}

/** The `${{ ... }}` expressions inside a string. */
export function interpolations(text: string): string[] {
  return (text.match(/\$\{\{[^}]*\}\}/g) ?? []).map((s) => s.trim());
}

/** Every string value anywhere under a node, for whole-document scans. */
export function allStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) allStrings(v, out);
  else if (isObj(node)) for (const v of Object.values(node)) allStrings(v, out);
  return out;
}

/** Workflow docs only - actions have no jobs, and most rules are workflow-only. */
export function workflows(docs: WorkflowDoc[]): WorkflowDoc[] {
  return docs.filter((d) => d.kind === 'workflow');
}

export function actions(docs: WorkflowDoc[]): WorkflowDoc[] {
  return docs.filter((d) => d.kind === 'action');
}
