/**
 * Token-free one-shot snapshot rendered when Fuel Gauge runs without a
 * terminal (piped stdin/stdout). It always lists all six providers in
 * canonical order, showing only cached public summaries — it never accepts
 * a stored-account type and never triggers network, auth, or refresh work.
 */

import { Box, Text } from "ink";
import {
  type AccountStatus,
  type AccountSummary,
  PROVIDER_LABELS,
  PROVIDER_ORDER,
  type ProviderId,
  type QuotaMetric,
} from "../core/types.js";
import type { CachedProviderSummaries } from "../runtime.js";

export interface NonInteractiveSnapshotProps {
  readonly summaries: CachedProviderSummaries;
}

const STATUS_LABELS: Record<AccountStatus, string> = {
  active: "active",
  requiresReauthentication: "reauthentication required",
  banned: "banned",
  forbidden: "forbidden",
};

function accountLabel(account: AccountSummary): string {
  switch (account.provider) {
    case "githubCopilot":
      return account.githubLogin;
    case "codex":
    case "antigravity":
    case "kiro":
      return account.email;
    case "claude":
      return account.displayName ?? account.email;
    case "cursor":
      return account.email ?? account.authId ?? "unknown account";
    case "omp":
      return `Oh My Pi · ${account.displayLabel}`;
    case "opencode":
      return `OpenCode · ${account.displayLabel}`;
    case "fuelGauge":
      return `FuelGauge · ${account.displayLabel}`;
  }
}

function metricLine(metric: QuotaMetric): string {
  const parts: string[] = [];
  if (metric.used !== null && metric.total !== null) {
    parts.push(`${metric.used}/${metric.total}`);
  } else if (metric.used !== null) {
    parts.push(`${metric.used} used`);
  }
  if (metric.remainingPercent !== null) {
    parts.push(
      `${Number.isInteger(metric.remainingPercent) ? metric.remainingPercent : metric.remainingPercent.toFixed(1)}% remaining`,
    );
  }
  if (metric.resetAt !== null) {
    parts.push(`resets ${new Date(metric.resetAt).toISOString()}`);
  }
  return parts.length === 0
    ? `${metric.label}: no data`
    : `${metric.label}: ${parts.join(" · ")}`;
}

function ProviderSection({
  provider,
  accounts,
}: {
  readonly provider: ProviderId;
  readonly accounts: readonly AccountSummary[];
}) {
  return (
    <Box flexDirection="column">
      <Text bold>
        {`${PROVIDER_LABELS[provider]} (${accounts.length} ${accounts.length === 1 ? "account" : "accounts"})`}
      </Text>
      {accounts.length === 0 ? (
        <Text dimColor> no cached accounts</Text>
      ) : (
        accounts.map((account) => (
          <AccountSection key={account.id} account={account} />
        ))
      )}
    </Box>
  );
}

function AccountSection({ account }: { readonly account: AccountSummary }) {
  const reason =
    account.statusReason === null ? "" : ` (${account.statusReason})`;
  return (
    <Box flexDirection="column">
      <Text>{`  ${accountLabel(account)} — ${STATUS_LABELS[account.status]}${reason}`}</Text>
      {account.metrics.map((metric) => (
        <Text key={metric.id}>{`    ${metricLine(metric)}`}</Text>
      ))}
      {account.usageUpdatedAt === null ? null : (
        <Text
          dimColor
        >{`    updated ${new Date(account.usageUpdatedAt).toISOString()}`}</Text>
      )}
      {account.quotaQueryLastError === null ? null : (
        <Text color="red">{`    last error: ${account.quotaQueryLastError}`}</Text>
      )}
    </Box>
  );
}

export function NonInteractiveSnapshot({
  summaries,
}: NonInteractiveSnapshotProps) {
  return (
    <Box flexDirection="column">
      <Text bold>fuel-gauge cached quota snapshot</Text>
      {PROVIDER_ORDER.map((provider) => (
        <ProviderSection
          key={provider}
          provider={provider}
          accounts={summaries.get(provider) ?? []}
        />
      ))}
    </Box>
  );
}
