/**
 * Shared Z.AI coding-plan quota fetch. The endpoint accepts a plain API
 * key (no OAuth), which is why both the opencode adapter (keys held in
 * opencode's auth.json) and the FuelGauge source (keys pasted by the
 * user) can call it directly. Token values are used transiently and are
 * never stored by this module.
 */

import { asRecord, recordString } from "../core/discovery.js";
import { type FetchLike, fetchWithTimeout, HttpError } from "../core/http.js";
import type { OmpUsageLimit } from "../core/types.js";

export const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ZaiQuotaOptions {
  readonly fetch: FetchLike;
  readonly apiKey: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Metric-id namespace, e.g. `"opencode"` → `opencode.zai.tokens_limit`. */
  readonly metricIdPrefix: string;
}

/**
 * Fetches and normalizes the Z.AI quota windows. Verified against a live
 * install: reset timestamps map TIME_LIMIT to the monthly zread request
 * quota and TOKENS_LIMIT to the 5-hour token window — the same limits omp
 * labels identically, so the dashboard's per-label merge collapses the
 * duplicates. Live shape: usage = window total, currentValue = consumed,
 * percentage = used percent.
 */
export async function fetchZaiQuotaLimits(
  options: ZaiQuotaOptions,
): Promise<OmpUsageLimit[]> {
  const response = await fetchWithTimeout(
    ZAI_USAGE_URL,
    {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
    options.fetch,
  );
  if (!response.ok) {
    throw new HttpError(
      "Z.AI usage",
      response.status,
      await response.text().catch(() => ""),
    );
  }
  const root = asRecord(await response.json());
  const data = asRecord(root?.data);
  const limits = data?.limits;
  if (!Array.isArray(limits)) {
    return [];
  }
  return limits.flatMap((entry) => {
    const limit = asRecord(entry);
    if (limit === undefined) {
      return [];
    }
    const type = recordString(limit, "type") ?? "LIMIT";
    const usedPercent = finiteOrNull(limit.percentage);
    const labels = zaiLimitLabels(type);
    return [
      {
        id: `${options.metricIdPrefix}.zai.${type.toLowerCase()}`,
        label: labels.label,
        windowLabel: labels.windowLabel,
        remainingPercent:
          usedPercent != null ? 100 - Math.min(100, usedPercent) : null,
        used: finiteOrNull(limit.currentValue),
        total: finiteOrNull(limit.usage),
        resetAt: finiteOrNull(limit.nextResetTime),
      } satisfies OmpUsageLimit,
    ];
  });
}

function zaiLimitLabels(type: string): {
  label: string;
  windowLabel: string;
} {
  if (type === "TIME_LIMIT") {
    return { label: "ZAI Zread Quota", windowLabel: "Monthly" };
  }
  if (type === "TOKENS_LIMIT") {
    return { label: "ZAI 5 Hours Token Quota", windowLabel: "5 Hours" };
  }
  return {
    label: type.replaceAll("_", " ").toLowerCase(),
    windowLabel: "",
  };
}
