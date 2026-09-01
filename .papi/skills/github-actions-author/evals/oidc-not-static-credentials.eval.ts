import type { Eval, EvalContext, EvalResult } from './types.js';
import { clampScore, makeResult, runEval } from './utils.js';
import { loadWorkflows } from './workflow-json.js';
import { actionRepo, allStrings, isObj, jobsOf, stepsOf, str, usesOf, withOf, workflows } from './workflow-walk.js';

const EVAL_ID = 'oidc-not-static-credentials';
const EVAL_NAME = 'Cloud access is short-lived OIDC, not stored long-lived keys';

const result = makeResult(EVAL_ID, EVAL_NAME);

/**
 * A stored `AWS_SECRET_ACCESS_KEY` is a standing credential: it does not expire,
 * it is valid from anywhere, and every job in the repository can read it. OIDC
 * replaces it with a token minted per run, scoped by a trust policy to this
 * repository and ref, and expiring in minutes. Nothing needs to be rotated
 * because nothing is stored.
 *
 * The finding here is a *stored* key. A secret whose name says role ARN or
 * account id is configuration, not a credential, and is not flagged.
 */

/** Secret names that name a long-lived cloud credential. */
const STATIC_CREDENTIAL =
  /(?:AWS_(?:SECRET_)?ACCESS_KEY|AWS_SECRET|GCP_SA_KEY|GOOGLE_CREDENTIALS|SERVICE_ACCOUNT_KEY|AZURE_CLIENT_SECRET|AZURE_CREDENTIALS)/i;

/** Inputs that prove an action is doing OIDC rather than key auth. */
const OIDC_INPUT = /^(?:role-to-assume|workload_identity_provider|role-session-name)$/;

/** Cloud auth actions, and the `with:` keys that would carry a static key. */
const CLOUD_AUTH: Record<string, RegExp> = {
  'aws-actions/configure-aws-credentials': /^aws-(?:access-key-id|secret-access-key)$/,
  'google-github-actions/auth': /^credentials_json$/,
  'azure/login': /^creds$/,
};

const oidcEval: Eval = {
  id: EVAL_ID,
  name: EVAL_NAME,

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!ctx.invoked || !ctx.qualityTranscript) {
      return result(0.0, 'Skipped - skill not invoked.');
    }

    const { docs, source } = loadWorkflows(ctx);
    if (source === 'none') {
      return result(0.5, 'No parseable YAML found - cloud credential handling not evaluated.');
    }

    const staticRefs: string[] = [];
    const oidcJobs: string[] = [];
    const authSteps: string[] = [];

    for (const wf of workflows(docs)) {
      const wfPerms = isObj(wf.doc.permissions) ? wf.doc.permissions : {};

      for (const { id, job } of jobsOf(wf.doc)) {
        const perms = isObj(job.permissions) ? job.permissions : {};
        const hasIdToken = str(perms['id-token']) === 'write' || str(wfPerms['id-token']) === 'write';

        for (const s of stepsOf(job)) {
          const repo = actionRepo(usesOf(s.step));
          const w = withOf(s.step);
          const keyPattern = CLOUD_AUTH[repo];
          if (keyPattern === undefined) continue;

          authSteps.push(`${wf.path} job \`${id}\``);
          const usesOidc = Object.keys(w).some((k) => OIDC_INPUT.test(k));
          const passesKey = Object.keys(w).some((k) => keyPattern.test(k));

          if (passesKey) {
            staticRefs.push(
              `${wf.path} job \`${id}\`: \`${repo}\` is given a stored key rather than assuming a role`,
            );
          } else if (usesOidc) {
            oidcJobs.push(`${wf.path} job \`${id}\``);
            if (!hasIdToken) {
              staticRefs.push(
                `${wf.path} job \`${id}\`: assumes a role but no \`id-token: write\` is in scope, so no OIDC token can be minted and the step fails`,
              );
            }
          }
        }
      }

      // A stored credential anywhere in the file, including a bare `env:` binding
      // that never goes through a cloud-auth action.
      for (const text of allStrings(wf.doc)) {
        const m = /secrets\.([A-Z0-9_]+)/i.exec(text);
        if (m && STATIC_CREDENTIAL.test(m[1])) {
          staticRefs.push(`${wf.path}: reads \`secrets.${m[1]}\`, a long-lived cloud credential`);
        }
      }
    }

    if (authSteps.length === 0 && staticRefs.length === 0) {
      return result(0.5, 'No cloud authentication in the produced workflows - nothing to score.');
    }

    if (staticRefs.length > 0) {
      const unique = [...new Set(staticRefs)];
      return result(
        clampScore(0.25 - 0.05 * (unique.length - 1)),
        `${unique.join('. ')}. Replace stored keys with OIDC: grant \`id-token: write\` on the deploying job, assume a role whose trust policy is scoped to this repository and ref, and delete the secrets.`,
      );
    }

    return result(
      1.0,
      `${[...new Set(oidcJobs)].join(', ')} authenticate by assuming a role over OIDC with \`id-token: write\` in scope; no long-lived cloud credentials are stored.`,
    );
  },
};

export default oidcEval;

runEval((ctx) => oidcEval.evaluate(ctx));
