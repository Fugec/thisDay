/**
 * Account-wide Cloudflare KV write-budget telemetry.
 *
 * The Workers KV Free limit is shared by every namespace and every Worker in
 * the account. A counter stored in KV would both miss writes from other
 * Workers and consume the resource it is trying to measure, so this module
 * reads Cloudflare's account-wide kvOperationsAdaptiveGroups analytics.
 */

export const KV_FREE_WRITE_LIMIT = 1_000;
export const KV_OPTIONAL_WRITE_STOP = 850;
export const KV_CONTENT_START_STOP = 950;
export const KV_ENRICHMENT_STOP = 980;

const KV_OPERATIONS_QUERY =
  `query KvOperationsAllSample($accountTag: string!, $start: Date, $end: Date) {
    viewer {
      accounts(filter: {accountTag: $accountTag}) {
        kvOperationsAdaptiveGroups(
          filter: {date_geq: $start, date_leq: $end}
          limit: 10000
        ) {
          sum { requests }
          dimensions { actionType }
        }
      }
    }
  }`;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nextUtcMidnight(now = new Date()) {
  const reset = new Date(now);
  reset.setUTCHours(24, 0, 0, 0);
  return reset.toISOString();
}

function normalizePhase(phase) {
  const value = String(phase || "generate").toLowerCase();
  if (value === "maintenance") return "maintenance";
  if (value === "enrich" || value === "recovery") return "enrich";
  if (value === "prepare") return "prepare";
  if (value === "publish") return "publish";
  return "generate";
}

export function classifyKvWriteBudget(
  usage,
  {
    phase = "generate",
    limit = KV_FREE_WRITE_LIMIT,
    optionalStop = KV_OPTIONAL_WRITE_STOP,
    contentStartStop = KV_CONTENT_START_STOP,
    enrichmentStop = KV_ENRICHMENT_STOP,
    now = new Date(),
  } = {},
) {
  const normalizedPhase = normalizePhase(phase);
  const known = usage?.known === true;
  const writes = known
    ? Math.max(0, Number.parseInt(String(usage?.operations?.write ?? 0), 10) || 0)
    : null;
  const phaseStop =
    normalizedPhase === "maintenance"
      ? optionalStop
      : normalizedPhase === "enrich"
        ? enrichmentStop
        : contentStartStop;
  const allowPhase = known
    ? writes < phaseStop
    : normalizedPhase !== "maintenance";
  const allowOptionalWrites = known && writes < optionalStop;
  const remaining = known ? Math.max(0, limit - writes) : null;
  const level = !known
    ? "unknown"
    : writes >= enrichmentStop
      ? "blocked"
      : writes >= contentStartStop
        ? "reserve"
        : writes >= optionalStop
          ? "guarded"
          : "normal";

  let reason;
  if (!known) {
    reason =
      `KV analytics unavailable (${usage?.reason || "unknown error"}); ` +
      "daily content may continue with optional writes disabled.";
  } else if (!allowPhase) {
    reason =
      `Account-wide KV writes are ${writes}/${limit}; phase "${normalizedPhase}" ` +
      `stops at ${phaseStop} to preserve the daily publication reserve.`;
  } else if (!allowOptionalWrites) {
    reason =
      `Account-wide KV writes are ${writes}/${limit}; optional entity, cache, ` +
      "repair, and debug writes are disabled.";
  } else {
    reason = `Account-wide KV writes are ${writes}/${limit}.`;
  }

  return {
    ...usage,
    known,
    phase: normalizedPhase,
    writes,
    limit,
    remaining,
    optionalStop,
    contentStartStop,
    enrichmentStop,
    phaseStop,
    level,
    allowPhase,
    allowOptionalWrites,
    resetAt: nextUtcMidnight(now),
    reason,
  };
}

export async function readAccountKvWriteUsage(
  env,
  {
    now = new Date(),
    fetchImpl = globalThis.fetch,
    timeoutMs = 8_000,
  } = {},
) {
  const accountId = String(env?.KV_USAGE_ACCOUNT_ID || "").trim();
  const apiToken = String(
    env?.CLOUDFLARE_ANALYTICS_READ ||
      env?.CF_ANALYTICS_API_TOKEN ||
      env?.CF_API_TOKEN ||
      "",
  ).trim();
  if (!accountId || !apiToken) {
    const missing = [
      !accountId ? "KV_USAGE_ACCOUNT_ID" : "",
      !apiToken
        ? "CLOUDFLARE_ANALYTICS_READ/CF_ANALYTICS_API_TOKEN/CF_API_TOKEN"
        : "",
    ].filter(Boolean);
    return {
      known: false,
      source: "cloudflare-graphql",
      reason: `missing ${missing.join(" and ")}`,
      operations: {},
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      known: false,
      source: "cloudflare-graphql",
      reason: "fetch is unavailable",
      operations: {},
    };
  }

  const day = now.toISOString().slice(0, 10);
  try {
    const response = await fetchImpl(
      "https://api.cloudflare.com/client/v4/graphql",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: KV_OPERATIONS_QUERY,
          variables: {
            accountTag: accountId,
            start: day,
            end: day,
          },
        }),
        signal:
          typeof globalThis.AbortSignal?.timeout === "function"
            ? globalThis.AbortSignal.timeout(timeoutMs)
            : undefined,
      },
    );
    if (!response.ok) {
      return {
        known: false,
        source: "cloudflare-graphql",
        reason: `Cloudflare GraphQL returned HTTP ${response.status}`,
        operations: {},
      };
    }

    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      return {
        known: false,
        source: "cloudflare-graphql",
        reason: String(payload.errors[0]?.message || "Cloudflare GraphQL error"),
        operations: {},
      };
    }
    const groups =
      payload?.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups;
    if (!Array.isArray(groups)) {
      return {
        known: false,
        source: "cloudflare-graphql",
        reason: "Cloudflare GraphQL returned no KV operation groups",
        operations: {},
      };
    }

    const operations = {};
    for (const group of groups) {
      const action = String(group?.dimensions?.actionType || "").toLowerCase();
      if (!action) continue;
      const requests = Math.max(
        0,
        Number.parseInt(String(group?.sum?.requests ?? 0), 10) || 0,
      );
      operations[action] = (operations[action] || 0) + requests;
    }
    return {
      known: true,
      source: "cloudflare-graphql",
      day,
      operations,
    };
  } catch (error) {
    return {
      known: false,
      source: "cloudflare-graphql",
      reason: error?.name === "TimeoutError"
        ? `Cloudflare GraphQL timed out after ${timeoutMs}ms`
        : `Cloudflare GraphQL request failed: ${error?.message || error}`,
      operations: {},
    };
  }
}

export async function getKvWriteBudget(env, phase, options = {}) {
  const now = options.now || new Date();
  const usage = await readAccountKvWriteUsage(env, {
    now,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    timeoutMs: options.timeoutMs,
  });
  return classifyKvWriteBudget(usage, {
    phase,
    now,
    limit: positiveInteger(env?.KV_DAILY_WRITE_LIMIT, KV_FREE_WRITE_LIMIT),
    optionalStop: positiveInteger(
      env?.KV_OPTIONAL_WRITE_STOP,
      KV_OPTIONAL_WRITE_STOP,
    ),
    contentStartStop: positiveInteger(
      env?.KV_CONTENT_START_STOP,
      KV_CONTENT_START_STOP,
    ),
    enrichmentStop: positiveInteger(
      env?.KV_ENRICHMENT_STOP,
      KV_ENRICHMENT_STOP,
    ),
  });
}

export function withKvWriteBudget(env, budget) {
  return {
    ...env,
    __KV_WRITE_BUDGET: budget,
  };
}

export function kvOptionalWritesAllowed(env) {
  return env?.__KV_WRITE_BUDGET?.allowOptionalWrites !== false;
}

export function publicKvWriteBudget(budget) {
  if (!budget) return null;
  return {
    known: budget.known,
    phase: budget.phase,
    level: budget.level,
    writes: budget.writes,
    limit: budget.limit,
    remaining: budget.remaining,
    allowPhase: budget.allowPhase,
    allowOptionalWrites: budget.allowOptionalWrites,
    resetAt: budget.resetAt,
    reason: budget.reason,
  };
}
