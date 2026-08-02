// ─── Beta routing auto-sync ────────────────────────────────────────────────
// Replaces the manual "Cookie Value" field + "Apply to AWS" button in the
// admin panel. This module is the single source of truth: it looks at the
// ACTUAL state of the ECS beta service (and whether it's been promoted to
// prod) and pushes the correct ALB listener rule itself — no human step,
// nothing that can drift out of sync.
//
// The cookie value the app emits at login (server.js -> ENV_COOKIE_VALUE)
// is a constant, "beta". This module's only job is to make sure the ALB
// rule matches that same constant whenever beta is actually live, and
// disables routing whenever it isn't — so both sides can never disagree.
//
// Required env vars:
//   ECS_CLUSTER            e.g. "golf-demo-cluster"
//   ECS_BETA_SERVICE       e.g. "golf-demo-app-beta"
//   ECS_PROD_SERVICE       e.g. "golf-demo-app-prod"
//   ALB_LISTENER_RULE_ARN  ARN of the existing beta-routing rule on the ALB
//   AWS_REGION             e.g. "us-east-1"
//
// If any of these are unset, sync is skipped (logged once) so local/dev
// runs are unaffected.

const {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} = require("@aws-sdk/client-ecs");
const {
  ElasticLoadBalancingV2Client,
  DescribeRulesCommand,
  ModifyRuleCommand,
} = require("@aws-sdk/client-elastic-load-balancing-v2");

const ENV_COOKIE_NAME = "__env";
const ENV_COOKIE_VALUE = "beta"; // must match server.js's ENV_COOKIE_NAME/value
const ACTIVE_PATTERN = `*${ENV_COOKIE_NAME}=${ENV_COOKIE_VALUE}*`;
// Impossible-to-match pattern used to "disable" the rule without deleting it.
const INACTIVE_PATTERN = `*${ENV_COOKIE_NAME}=__disabled__*`;

const REGION = process.env.AWS_REGION || "us-east-1";
const CLUSTER = process.env.ECS_CLUSTER;
const BETA_SERVICE = process.env.ECS_BETA_SERVICE;
const PROD_SERVICE = process.env.ECS_PROD_SERVICE;
const RULE_ARN = process.env.ALB_LISTENER_RULE_ARN;

const CONFIGURED = !!(CLUSTER && BETA_SERVICE && PROD_SERVICE && RULE_ARN);

let ecs, elb;
if (CONFIGURED) {
  ecs = new ECSClient({ region: REGION });
  elb = new ElasticLoadBalancingV2Client({ region: REGION });
}

// Pulls the container image URI a running ECS service is actually using,
// by resolving its current task definition.
async function imageForService(serviceName) {
  const desc = await ecs.send(
    new DescribeServicesCommand({ cluster: CLUSTER, services: [serviceName] })
  );
  const service = (desc.services || [])[0];
  if (!service) return { image: null, runningCount: 0, desiredCount: 0 };

  const taskDef = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: service.taskDefinition })
  );
  const image = taskDef.taskDefinition?.containerDefinitions?.[0]?.image || null;

  return {
    image,
    runningCount: service.runningCount || 0,
    desiredCount: service.desiredCount || 0,
  };
}

// Decides whether beta should currently be routable:
//  - task must actually be up (running + desired > 0)
//  - AND not already promoted (beta image === prod image means promotion
//    already happened, so beta and prod are serving the same code — no
//    reason to keep splitting traffic)
async function computeDesiredState() {
  const [beta, prod] = await Promise.all([
    imageForService(BETA_SERVICE),
    imageForService(PROD_SERVICE),
  ]);

  const betaIsUp = beta.runningCount > 0 && beta.desiredCount > 0;
  const promoted = beta.image && prod.image && beta.image === prod.image;

  return {
    shouldRoute: betaIsUp && !promoted,
    betaIsUp,
    promoted,
    betaImage: beta.image,
    prodImage: prod.image,
  };
}

// Idempotent: only calls ModifyRule if the live ALB pattern actually
// differs from what it should be, so this is safe to run on a timer.
async function reconcileAlbRule(shouldRoute) {
  const desiredPattern = shouldRoute ? ACTIVE_PATTERN : INACTIVE_PATTERN;

  const desc = await elb.send(new DescribeRulesCommand({ RuleArns: [RULE_ARN] }));
  const rule = (desc.Rules || [])[0];
  if (!rule) throw new Error(`ALB rule not found: ${RULE_ARN}`);

  const currentCondition = (rule.Conditions || []).find(c => c.Field === "http-header");
  const currentPattern = currentCondition?.HttpHeaderConfig?.Values?.[0];

  if (currentPattern === desiredPattern) {
    return { changed: false, pattern: desiredPattern };
  }

  await elb.send(
    new ModifyRuleCommand({
      RuleArn: RULE_ARN,
      Conditions: [
        {
          Field: "http-header",
          HttpHeaderConfig: { HttpHeaderName: "Cookie", Values: [desiredPattern] },
        },
      ],
    })
  );

  return { changed: true, pattern: desiredPattern };
}

// Main entry point. Call on startup and on a timer (e.g. every 30-60s),
// or from a manual "/admin/sync-beta-routing" trigger after a deploy.
async function syncBetaRouting() {
  if (!CONFIGURED) {
    console.warn(
      "[beta-sync] skipped — ECS_CLUSTER/ECS_BETA_SERVICE/ECS_PROD_SERVICE/ALB_LISTENER_RULE_ARN not fully set"
    );
    return { skipped: true };
  }

  try {
    const state = await computeDesiredState();
    const result = await reconcileAlbRule(state.shouldRoute);

    console.log(
      `[beta-sync] betaIsUp=${state.betaIsUp} promoted=${state.promoted} ` +
      `-> shouldRoute=${state.shouldRoute} rule=${result.changed ? "UPDATED" : "unchanged"} ` +
      `pattern=${result.pattern}`
    );

    return { ...state, ...result, skipped: false };
  } catch (err) {
    // Never throw out of here — a sync failure should never take the app
    // down or block login; it just means routing stays as it was until
    // the next successful reconcile.
    console.error("[beta-sync] reconcile failed:", err.message);
    return { error: err.message };
  }
}

module.exports = { syncBetaRouting, CONFIGURED };
