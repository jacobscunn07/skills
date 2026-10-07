import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { parse } from 'yaml';
import type { EvalContext } from './types.js';
import { extractTaggedCodeBlocks } from './utils.js';

/** Where the YAML under evaluation was recovered from. */
export type WorkflowSource = 'workdir' | 'transcript' | 'none';

export interface WorkflowDoc {
  /** Path relative to workDir, or `block-<n>.yml` for transcript-recovered YAML. */
  path: string;
  /** The YAML text, kept because comments do not survive the parse. */
  raw: string;
  /** The parsed document. */
  doc: Record<string, unknown>;
  /** A workflow has `jobs`; an action has `runs`. */
  kind: 'workflow' | 'action';
}

export interface LoadedWorkflows {
  docs: WorkflowDoc[];
  source: WorkflowSource;
}

// Fence info strings that hold GitHub Actions YAML.
const YAML_FENCES = new Set(['yaml', 'yml']);

// Every eval runs in its own subprocess, so the directory walk and the YAML parse
// would be repeated per eval. The result is cached in the scenario's work dir,
// which loop.go makes unique per iteration and scenario.
//
// The name must not end in `.yml`/`.yaml` and must not sit under
// `.github/workflows`, or the cache would be picked up as a workflow on the next
// read and linted as one.
const CACHE_FILE = '.papi-workflows.json';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'vendor', '.terraform']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Classifies a parsed document, or null when it is neither a workflow nor an action. */
function classify(doc: Record<string, unknown>): WorkflowDoc['kind'] | null {
  if (isPlainObject(doc.jobs)) return 'workflow';
  if (isPlainObject(doc.runs)) return 'action';
  return null;
}

/** Every .yml/.yaml under dir that could be a workflow or an action definition. */
function collectYamlFiles(dir: string, root = dir): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...collectYamlFiles(full, root));
    } else if (e.isFile() && /\.ya?ml$/.test(e.name)) {
      const rel = relative(root, full);
      // Workflows only count where GitHub actually reads them; action metadata is
      // recognized by filename anywhere. Any other YAML (a compose file, a chart)
      // is skipped so it cannot be mistaken for a workflow with no `jobs`.
      if (rel.startsWith(join('.github', 'workflows')) || /^action\.ya?ml$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function fromWorkDir(workDir: string): WorkflowDoc[] {
  if (!workDir || !existsSync(workDir)) return [];
  const out: WorkflowDoc[] = [];
  for (const file of collectYamlFiles(workDir)) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parse(raw);
    } catch {
      // A file that does not parse is still a real finding, but it belongs to
      // actionlint-clean, which reads the file itself. Skip it here.
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const kind = classify(parsed);
    if (!kind) continue;
    out.push({ path: relative(workDir, file), raw, doc: parsed, kind });
  }
  return out;
}

function fromTranscript(transcript: string): WorkflowDoc[] {
  const blocks = extractTaggedCodeBlocks(transcript).filter((b) => YAML_FENCES.has(b.lang));
  const out: WorkflowDoc[] = [];
  for (const [i, block] of blocks.entries()) {
    let parsed: unknown;
    try {
      parsed = parse(block.code);
    } catch {
      // Illustrative fragments are not valid YAML documents on their own.
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const kind = classify(parsed);
    if (!kind) continue;
    out.push({ path: `block-${i}.yml`, raw: block.code, doc: parsed, kind });
  }
  return out;
}

/**
 * Recovers the workflows and actions produced by a scenario. Files written to disk
 * win: they are what GitHub would actually run, and the output contract requires
 * them. Fenced YAML in the transcript is the fallback, so a skill that answered in
 * markdown only is still scored on the content rather than skipped.
 */
export function loadWorkflows(ctx: EvalContext): LoadedWorkflows {
  const cachePath = ctx.workDir ? join(ctx.workDir, CACHE_FILE) : '';
  if (cachePath && existsSync(cachePath)) {
    try {
      return JSON.parse(readFileSync(cachePath, 'utf8')) as LoadedWorkflows;
    } catch {
      // Fall through and rebuild.
    }
  }

  let loaded: LoadedWorkflows = { docs: [], source: 'none' };
  const onDisk = fromWorkDir(ctx.workDir);
  if (onDisk.length > 0) {
    loaded = { docs: onDisk, source: 'workdir' };
  } else {
    const fromText = fromTranscript(ctx.qualityTranscript ?? '');
    if (fromText.length > 0) loaded = { docs: fromText, source: 'transcript' };
  }

  if (cachePath && existsSync(ctx.workDir)) {
    try {
      writeFileSync(cachePath, JSON.stringify(loaded), 'utf8');
    } catch {
      // Caching is an optimization; a read-only work dir is not an error.
    }
  }
  return loaded;
}

/**
 * Keys the docs by path into one object for a single lint pass, so `memberPath`
 * starts with the file a finding came from.
 */
export function byPath(docs: WorkflowDoc[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of docs) out[d.path] = d.doc;
  return out;
}

/** Splits a `memberPath` produced over `byPath()` into its file and in-file parts. */
export function splitPath(path: string[]): { file: string; keys: string[] } {
  return { file: path[0] ?? '', keys: path.slice(1) };
}

/** The last key of an in-file path, which is the property name a rule matches on. */
export function leafKey(path: string[]): string {
  return path[path.length - 1] ?? '';
}
