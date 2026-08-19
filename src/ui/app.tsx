/**
 * Fuel Gauge interactive Ink application.
 *
 * Routes: Dashboard, provider Details, Account actions (removal), Auth
 * (per-provider account management: logins, API keys, deletion),
 * Settings, and Help — all always visible in the navigation rail.
 * Claude stays opt-in behind an explicit policy ConfirmInput. Global keys
 * suspend while a route-owned field or modal is active, `q` exits through
 * `useApp().exit`, and every poll/listener lives only while its route is
 * mounted. Persisted settings load and reach the monitor BEFORE it starts.
 */

import { ConfirmInput, PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  type AlertsState,
  accountDisplayLabel,
  bellOutput,
  EMPTY_ALERTS,
  updateAlerts,
} from "../core/alerts.js";
import { redactSecrets } from "../core/http.js";
import { MonitorController, type MonitorSnapshot } from "../core/monitor.js";
import { DEFAULT_SETTINGS } from "../core/store.js";
import type {
  AccountSummary,
  AutoRefreshSettings,
  ImportCandidate,
  ProviderId,
  QuotaMetric,
  Settings,
} from "../core/types.js";
import { PROVIDER_LABELS, PROVIDER_ORDER } from "../core/types.js";
import { FUEL_GAUGE_VENDORS } from "../providers/fuel-gauge.js";
import type { Runtime } from "../runtime.js";
import {
  type MergedAccountEntry,
  markPinnedEntries,
  mergeAccountsByIdentity,
} from "./accounts-view.js";
import { useViewport, type ViewportLayout } from "./viewport.js";

type TabId = "accounts" | "sources" | "auth" | "settings" | "help";

/** Overlay routes rendered on top of the active tab's content. */
type OverlayKind = "account" | "details" | "visibility";

const TAB_LABELS: Record<TabId, string> = {
  accounts: "Accounts",
  sources: "Sources",
  auth: "Auth",
  settings: "Settings",
  help: "Help",
};

/** Tab cycle order; Tab/Shift+Tab walk it, wrapping at both ends. */
const TAB_ORDER: readonly TabId[] = [
  "accounts",
  "sources",
  "auth",
  "settings",
  "help",
];

/**
 * One add-account target: a vendor PROVIDER, never an agent source.
 * Native sources log in through their own OAuth; API-key vendors come
 * from the first-party registry ({@link FUEL_GAUGE_VENDORS}); providers
 * whose OAuth belongs to an agent CLI (e.g. xAI Grok via opencode) are
 * added by importing the agent's credential — the CLI owns the login,
 * Fuel Gauge copies the result after an explicit confirm.
 */
type AddProviderEntry =
  | {
      readonly kind: "login";
      readonly id: string;
      readonly label: string;
      readonly source: ProviderId;
    }
  | {
      readonly kind: "apiKey";
      readonly id: string;
      readonly label: string;
    }
  | {
      readonly kind: "agentImport";
      readonly id: string;
      readonly label: string;
      /** The agent source whose store holds the provider's credentials. */
      readonly agent: ProviderId;
    };

/** Method label shown in the picker's right column. */
function addMethodLabel(entry: AddProviderEntry): string {
  if (entry.kind === "apiKey") {
    return "API key";
  }
  if (entry.kind === "agentImport") {
    return `via ${PROVIDER_LABELS[entry.agent]}`;
  }
  return "log in";
}

const ADD_PROVIDERS: readonly AddProviderEntry[] = [
  ...(
    [
      "githubCopilot",
      "codex",
      "antigravity",
      "claude",
      "kiro",
      "cursor",
    ] as const
  ).map((source) => ({
    kind: "login" as const,
    id: source,
    label: PROVIDER_LABELS[source],
    source,
  })),
  ...Object.entries(FUEL_GAUGE_VENDORS).map(([vendor, def]) => ({
    kind: "apiKey" as const,
    id: vendor,
    label: def.label,
  })),
  {
    kind: "agentImport",
    id: "xai",
    label: "xAI Grok",
    agent: "opencode",
  },
];

function nextTab(tab: TabId, step: number): TabId {
  const index = TAB_ORDER.indexOf(tab);
  return TAB_ORDER[(index + step + TAB_ORDER.length) % TAB_ORDER.length] ?? tab;
}

const MAX_CARD_ACCOUNTS = 2;

/**
 * Sources-list rows reserved for everything except the blocks: tab bar,
 * title, the gap between the two content children, and a possible
 * startup-error line so the frame stays strictly below the viewport
 * height at every stable size.
 */
const DASHBOARD_CHROME_ROWS = 4;

/**
 * Exact greedy word-wrap line count for a paragraph at `width` — used to
 * prove a disclosure fits a viewport UNTRUNCATED before its confirmation
 * control is allowed to mount.
 */
function wrappedLineCount(text: string, width: number): number {
  const usable = Math.max(8, Math.floor(width));
  let lines = 1;
  let current = 0;
  for (const word of text.split(/\s+/)) {
    const size = word.length;
    if (current > 0 && current + 1 + size <= usable) {
      current += 1 + size;
      continue;
    }
    lines += current > 0 ? 1 : 0;
    current = Math.min(size, usable);
    if (size > usable) {
      // Words longer than a full row spill onto additional rows.
      lines += Math.ceil((size - usable) / usable);
      current = ((size - 1) % usable) + 1;
    }
  }
  return lines;
}

/** One source block in a {@link planSourcesList} result. */
export interface SourcesListEntry {
  readonly provider: ProviderId;
  /** Account rows rendered under the header (budget-truncated). */
  readonly accounts: readonly AccountSummary[];
  /** Accounts cut from the block by the row budget. */
  readonly hiddenAccounts: number;
}

export interface SourcesListPlan {
  /** Source blocks to render, busiest source first (ties canonical). */
  readonly entries: readonly SourcesListEntry[];
  /** Populated sources hidden below the row budget. */
  readonly hiddenProviders: number;
  /** Rows the list occupies (blocks, gaps, "+N more" hint). */
  readonly usedRows: number;
}

/**
 * Sources-tab ordering: most registered accounts first, ties keep the
 * canonical {@link PROVIDER_ORDER}, and sources without accounts fold to
 * the tail. Both the source list and the j/k navigation walk this order.
 */
export function orderSourcesByAccounts(
  accountsByProvider: ReadonlyMap<ProviderId, readonly AccountSummary[]>,
): ProviderId[] {
  const count = (provider: ProviderId): number =>
    accountsByProvider.get(provider)?.length ?? 0;
  return [...PROVIDER_ORDER].sort((a, b) => {
    const byAccounts = count(b) - count(a);
    return byAccounts !== 0
      ? byAccounts
      : PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b);
  });
}

/**
 * Fixed rows every source block occupies regardless of accounts: the
 * rounded border (top + bottom) plus the header row.
 */
const SOURCE_BLOCK_BASE_ROWS = 3;

/** Card height without any metric rows (borders, header, account rows). */
function providerCardBaseRows(accountCount: number): number {
  if (accountCount === 0) {
    return 4; // borders + header + "no accounts"
  }
  const shown = Math.min(accountCount, MAX_CARD_ACCOUNTS);
  return accountCount > MAX_CARD_ACCOUNTS ? 4 + shown : 3 + shown;
}

/**
 * Height-budgeted vertical sources list of bordered blocks. Ink
 * full-clears the screen for every frame taller than the viewport, so
 * the list must always fit. Every rendered row is exactly one terminal
 * line (labels truncate), so the plan is a plain row walk: one bordered
 * block per source — {@link SOURCE_BLOCK_BASE_ROWS} plus one row per
 * account — busiest source first, until the budget runs out. Sources
 * that no longer fit collapse into the "+N more providers" hint; a
 * single block taller than the whole budget keeps its header plus as
 * many account rows as fit behind a "+N more accounts" hint; and when
 * the budget would hide the selected source entirely, it is hoisted to
 * the front so the selection marker stays visible. Sources without
 * accounts never appear here — the caller renders them as the trailing
 * no-accounts list block.
 * Pure: same inputs always yield the same plan.
 */
export function planSourcesList(input: {
  readonly budgetRows: number;
  readonly accountsByProvider: ReadonlyMap<
    ProviderId,
    readonly AccountSummary[]
  >;
  readonly selectedProvider: ProviderId;
}): SourcesListPlan {
  const count = (provider: ProviderId): number =>
    input.accountsByProvider.get(provider)?.length ?? 0;
  const populated = orderSourcesByAccounts(input.accountsByProvider).filter(
    (provider) => count(provider) > 0,
  );
  if (populated.length === 0) {
    return { entries: [], hiddenProviders: 0, usedRows: 0 };
  }

  const layout = (
    ordered: readonly ProviderId[],
  ): { entries: SourcesListEntry[]; used: number; hidden: number } => {
    const entries: SourcesListEntry[] = [];
    let used = 0;
    let included = 0;
    for (; included < ordered.length; included++) {
      const provider = ordered[included];
      if (provider === undefined) {
        break;
      }
      const accounts = input.accountsByProvider.get(provider) ?? [];
      const gap = entries.length === 0 ? 0 : 1;
      const block = SOURCE_BLOCK_BASE_ROWS + accounts.length;
      if (used + gap + block > input.budgetRows) {
        break;
      }
      used += gap + block;
      entries.push({ provider, accounts, hiddenAccounts: 0 });
    }
    let hidden = ordered.length - included;
    if (hidden > 0) {
      // The "+N more providers" hint needs one row plus its gap.
      while (entries.length > 1 && used + 2 > input.budgetRows) {
        const dropped = entries.pop();
        used -= 1 + SOURCE_BLOCK_BASE_ROWS + (dropped?.accounts.length ?? 0); // gap + block + rows
        included -= 1;
        hidden = ordered.length - included;
      }
    }
    if (entries.length === 0) {
      // Guarantee the first source's header box: show as many of its
      // account rows as fit behind a "+N more accounts" hint (at least
      // one when any room exists), reserving the trailing "+N more
      // providers" hint when later sources exist.
      const provider = ordered[0];
      if (provider === undefined) {
        return { entries: [], used: 0, hidden: 0 };
      }
      const accounts = input.accountsByProvider.get(provider) ?? [];
      const reserve = 1 + (hidden > 0 ? 2 : 0);
      const room = Math.max(
        0,
        input.budgetRows - SOURCE_BLOCK_BASE_ROWS - reserve,
      );
      const shown = accounts.slice(0, Math.max(room > 0 ? 1 : 0, room));
      const hiddenAccounts = accounts.length - shown.length;
      used =
        SOURCE_BLOCK_BASE_ROWS + shown.length + (hiddenAccounts > 0 ? 1 : 0);
      return {
        entries: [{ provider, accounts: shown, hiddenAccounts }],
        used,
        hidden,
      };
    }
    return { entries, used, hidden };
  };

  let result = layout(populated);
  if (
    count(input.selectedProvider) > 0 &&
    !result.entries.some((entry) => entry.provider === input.selectedProvider)
  ) {
    // The budget hid the selected source: hoist it so the selection
    // marker stays visible (short terminals only; tall frames keep the
    // sorted order).
    result = layout([
      input.selectedProvider,
      ...populated.filter((provider) => provider !== input.selectedProvider),
    ]);
  }

  return {
    entries: result.entries,
    hiddenProviders: result.hidden,
    usedRows: result.used + (result.hidden > 0 ? 2 : 0),
  };
}

const STATUS_LABELS = {
  active: "active",
  requiresReauthentication: "reauthentication required",
  banned: "banned",
  forbidden: "forbidden",
} as const;
const MIN_WIDTH = 8;

function nonNegative(width: number): number {
  return Math.max(MIN_WIDTH, width);
}

function percentText(remaining: number | null): string {
  return remaining == null ? "--" : `${Math.round(remaining)}%`;
}

function bar(remaining: number | null, width: number): string {
  if (remaining == null) {
    return " ".repeat(width);
  }
  const clamped = Math.max(0, Math.min(100, remaining));
  const filled = Math.round((clamped / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/** Lowest remaining percent across the account's metrics. */
function worstRemaining(account: AccountSummary): number | null {
  let worst: number | null = null;
  for (const metric of account.metrics) {
    const value = metric.remainingPercent;
    if (value != null && Number.isFinite(value)) {
      worst = worst === null ? value : Math.min(worst, value);
    }
  }
  return worst;
}

function phaseText(snapshot: MonitorSnapshot, provider: ProviderId): string {
  const state = snapshot.providers.get(provider);
  if (state === undefined) {
    return "";
  }
  if (state.phase === "refreshing") {
    return "· refreshing";
  }
  if (state.phase === "importing") {
    return "· importing";
  }
  if (state.phase === "authenticating") {
    return "· auth";
  }
  if (state.phase === "error") {
    return "· error";
  }
  return "";
}

/** Sanitized, bounded UI-facing error text (settings load/save, start). */
export function sanitizeUiError(error: unknown, bound = 200): string {
  const raw =
    error instanceof Error && error.message !== ""
      ? error.message
      : String(error);
  const flattened = raw.replaceAll(/\s+/g, " ").trim();
  const redacted = redactSecrets(flattened);
  const safe = redacted === "" ? "operation failed" : redacted;
  return safe.length > bound ? `${safe.slice(0, bound)}…` : safe;
}

/** Deterministic UTC rendering of an epoch-millisecond reset. */
function formatResetAt(resetAt: number): string {
  const iso = new Date(resetAt).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/** Compact time-until-reset for dashboard rows, e.g. `2d 4h` / `5h 12m`. */
export function formatResetIn(resetAt: number, nowMs: number): string {
  const ms = resetAt - nowMs;
  if (ms <= 0) {
    return "resetting";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function usedTotalText(metric: QuotaMetric): string {
  if (metric.used == null && metric.total == null) {
    return "";
  }
  return `${metric.used ?? "--"}/${metric.total ?? "--"}`;
}

/**
 * Every normalized metric row for one account. `detailed` adds the
 * used/total counts and reset timestamp shown on the details route;
 * compact dashboard cards show label + remaining percent only. The label
 * flexes and truncates, so a row is exactly one line at any card width —
 * the height budget depends on that invariant.
 */
function MetricRows({
  account,
  detailed,
  labelWidth,
  limit,
}: {
  account: AccountSummary;
  detailed: boolean;
  /** Fixed label column for detailed rows; omitted = flexing label. */
  labelWidth?: number;
  /** Hard cap on rendered metric rows (height budget). */
  limit?: number;
}): React.JSX.Element {
  const metrics =
    limit === undefined
      ? account.metrics
      : account.metrics.slice(0, Math.max(0, limit));
  return (
    <Box flexDirection="column">
      {metrics.map((metric) => {
        const counts = usedTotalText(metric);
        return (
          <Box key={metric.id} gap={1}>
            {detailed ? (
              <Box width={labelWidth ?? 12}>
                <Text wrap="truncate" dimColor>
                  {metric.label}
                </Text>
              </Box>
            ) : (
              <Box flexGrow={1} flexShrink={1} minWidth={4}>
                <Text wrap="truncate" dimColor>
                  {metric.label}
                </Text>
              </Box>
            )}
            {detailed && counts !== "" ? (
              <Text wrap="truncate">{counts}</Text>
            ) : null}
            {detailed && metric.resetAt != null ? (
              <Text wrap="truncate" dimColor>
                reset {formatResetAt(metric.resetAt)}
              </Text>
            ) : null}
            <Text
              wrap="truncate"
              color={
                metric.remainingPercent != null && metric.remainingPercent <= 20
                  ? "red"
                  : "green"
              }
            >
              {percentText(metric.remainingPercent)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ProviderCard({
  snapshot,
  provider,
  accounts,
  pinnedIds,
  width,
  bars,
  metricAccountIds,
  selectedAccountId,
  maxMetricRows,
}: {
  snapshot: MonitorSnapshot;
  provider: ProviderId;
  accounts: readonly AccountSummary[];
  pinnedIds: readonly string[];
  width: number;
  /** Short terminals drop usage bars to keep account rows narrow. */
  bars: boolean;
  /** Accounts whose compact metric rows render (height-budgeted). */
  metricAccountIds: ReadonlySet<string>;
  selectedAccountId: string | null;
  /** Hard cap on metric rows per account (short-layout budget). */
  maxMetricRows?: number;
}): React.JSX.Element {
  const ordered = useMemo(() => {
    const pinned = accounts.filter((account) => pinnedIds.includes(account.id));
    const rest = accounts.filter((account) => !pinnedIds.includes(account.id));
    return [...pinned, ...rest].slice(0, MAX_CARD_ACCOUNTS);
  }, [accounts, pinnedIds]);

  const inner = nonNegative(width - 4);
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={width}>
      <Box gap={1}>
        <Text
          bold
          wrap="truncate"
          color={accounts.length > 0 ? "magenta" : "gray"}
        >
          {PROVIDER_LABELS[provider]}
        </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={2}>
          <Text dimColor wrap="truncate">
            {phaseText(snapshot, provider)} {accounts.length}
          </Text>
        </Box>
      </Box>
      {ordered.length === 0 ? (
        <Text dimColor>no accounts</Text>
      ) : (
        ordered.map((account) => {
          const showRows = metricAccountIds.has(account.id);
          return (
            <Box key={account.id} flexDirection="column">
              <Box gap={1}>
                <Text
                  color={account.id === selectedAccountId ? "cyan" : undefined}
                >
                  {pinnedIds.includes(account.id) ? "📌" : " "}
                </Text>
                <Box flexGrow={1} flexShrink={1} minWidth={4}>
                  <Text wrap="truncate">{accountDisplayLabel(account)}</Text>
                </Box>
                {bars ? (
                  <Text
                    wrap="truncate"
                    color={
                      worstRemaining(account) != null &&
                      (worstRemaining(account) as number) <= 20
                        ? "red"
                        : "cyan"
                    }
                  >
                    {bar(
                      worstRemaining(account),
                      Math.max(3, Math.floor(inner * 0.35)),
                    )}
                  </Text>
                ) : null}
                <Text wrap="truncate">
                  {percentText(worstRemaining(account))}
                </Text>
                {account.status !== "active" ? (
                  <Text color="red">⚠</Text>
                ) : null}
              </Box>
              {showRows ? (
                <MetricRows
                  account={account}
                  detailed={false}
                  limit={maxMetricRows}
                />
              ) : null}
            </Box>
          );
        })
      )}
      {accounts.length > MAX_CARD_ACCOUNTS ? (
        <Text dimColor>+{accounts.length - MAX_CARD_ACCOUNTS} more…</Text>
      ) : null}
    </Box>
  );
}

/**
 * Account label inside its source's block. The agent prefix that
 * {@link accountDisplayLabel} adds ("Oh My Pi · …") names the source,
 * which the surrounding box already carries — inside the block it is
 * redundant noise.
 */
function sourceAccountLabel(account: AccountSummary): string {
  if (
    account.provider === "omp" ||
    account.provider === "opencode" ||
    account.provider === "fuelGauge"
  ) {
    return account.displayLabel;
  }
  return accountDisplayLabel(account);
}

/**
 * One bordered source block in the sources list: a header row
 * (`❯ Provider · N accounts · phase`) with one row per account, or the
 * no-accounts hint when the block is the expanded empty selection.
 */
function SourceBlock({
  snapshot,
  provider,
  accounts,
  hiddenAccounts,
  selectedSource,
  selectedAccountId,
  pinnedIds,
}: {
  snapshot: MonitorSnapshot;
  provider: ProviderId;
  accounts: readonly AccountSummary[];
  /** Accounts cut from the block by the row budget. */
  hiddenAccounts: number;
  selectedSource: boolean;
  selectedAccountId: string | null;
  pinnedIds: readonly string[];
}): React.JSX.Element {
  const phase = phaseText(snapshot, provider);
  const count = accounts.length + hiddenAccounts;
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text color={selectedSource ? "cyan" : undefined}>
          {selectedSource ? "❯" : " "}
        </Text>
        {/* The title carries the block's identity: magenta like the
            provider cards, cyan while selected. */}
        <Text bold wrap="truncate" color={selectedSource ? "cyan" : "magenta"}>
          {PROVIDER_LABELS[provider]}
        </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={2}>
          <Text dimColor wrap="truncate">
            ·{" "}
            {count === 0
              ? `no accounts${phase}`
              : `${count} ${count === 1 ? "account" : "accounts"}${phase}`}
          </Text>
        </Box>
      </Box>
      {count === 0 ? (
        <Text dimColor wrap="truncate">
          {"  "}No accounts for this source. Press a to add a FuelGauge API key.
        </Text>
      ) : (
        <>
          {accounts.map((account) => {
            const selectedAccount =
              selectedSource && account.id === selectedAccountId;
            return (
              <Box key={account.id} gap={1} paddingLeft={2}>
                <Box flexGrow={1} flexShrink={1} minWidth={4}>
                  <Text
                    wrap="truncate"
                    color={selectedAccount ? "cyan" : undefined}
                  >
                    {pinnedIds.includes(account.id) ? "📌 " : "• "}
                    {sourceAccountLabel(account)}
                  </Text>
                </Box>
                {account.status !== "active" ? (
                  <Text color="red">⚠</Text>
                ) : null}
              </Box>
            );
          })}
          {hiddenAccounts > 0 ? (
            <Text dimColor>
              {"  "}+{hiddenAccounts} more accounts…
            </Text>
          ) : null}
        </>
      )}
    </Box>
  );
}

/**
 * The trailing block of the sources list: every source without
 * accounts, one row per source, in canonical order. Selecting one of
 * these sources (j/k) marks its row here — Enter still opens details.
 */
function NoAccountsBlock({
  providers,
  selectedProvider,
}: {
  readonly providers: readonly ProviderId[];
  readonly selectedProvider: ProviderId;
}): React.JSX.Element {
  const count = providers.length;
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text> </Text>
        <Text bold wrap="truncate" color="magenta">
          no accounts
        </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={2}>
          <Text dimColor wrap="truncate">
            · {count} {count === 1 ? "source" : "sources"}
          </Text>
        </Box>
      </Box>
      {providers.map((provider) => {
        const selected = provider === selectedProvider;
        return (
          <Box key={provider} paddingLeft={2}>
            <Text wrap="truncate" color={selected ? "cyan" : undefined}>
              {selected ? "❯ " : "• "}
              {PROVIDER_LABELS[provider]}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

const CLAUDE_POLICY_WARNING =
  "Anthropic consumer OAuth/quota use by third-party tools may violate the " +
  "Anthropic Terms of Service. Continuing risks account restriction or " +
  "suspension. Fuel Gauge stays network-silent for Claude until you accept " +
  "this risk explicitly.";

/** Selectable auto-refresh intervals (seconds), ascending cycle order. */
export const AUTO_REFRESH_PRESETS = [60, 300, 600] as const;

/**
 * Next preset in the Settings cycle: off → 1m → 5m → 10m → off. A stored
 * interval outside the presets snaps up to the nearest next one (or off
 * when it already exceeds 10m), so legacy free-form values still cycle.
 */
export function nextAutoRefresh(
  current: AutoRefreshSettings,
): AutoRefreshSettings {
  if (!current.enabled) {
    return { enabled: true, intervalSeconds: AUTO_REFRESH_PRESETS[0] };
  }
  const next = AUTO_REFRESH_PRESETS.find(
    (preset) => preset > current.intervalSeconds,
  );
  return next === undefined
    ? { enabled: false, intervalSeconds: current.intervalSeconds }
    : { enabled: true, intervalSeconds: next };
}

function SettingsRoute({
  settings,
  onChange,
  onBack,
  onQuit,
  saveError,
  viewport,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
  onBack: () => void;
  onQuit: () => void;
  saveError: string | null;
  viewport: ViewportLayout;
}): React.JSX.Element {
  const [claudeConfirm, setClaudeConfirm] = useState(false);
  useInput(
    (input, key) => {
      if (key.escape) {
        if (claudeConfirm) {
          setClaudeConfirm(false);
          return;
        }
        onBack();
        return;
      }
      if (claudeConfirm) {
        return; // ConfirmInput owns the keyboard
      }
      if (input === "q") {
        onQuit();
        return;
      }
      if (input === "t") {
        onChange({
          ...settings,
          autoRefresh: nextAutoRefresh(settings.autoRefresh),
        });
        return;
      }
      if (input === "b") {
        onChange({
          ...settings,
          alerts: { ...settings.alerts, enabled: !settings.alerts.enabled },
        });
        return;
      }
      if (input === "+") {
        onChange({
          ...settings,
          alerts: {
            ...settings.alerts,
            thresholdPercent: Math.min(
              99,
              settings.alerts.thresholdPercent + 1,
            ),
          },
        });
        return;
      }
      if (input === "-") {
        onChange({
          ...settings,
          alerts: {
            ...settings.alerts,
            thresholdPercent: Math.max(1, settings.alerts.thresholdPercent - 1),
          },
        });
        return;
      }
      if (input === "c") {
        setClaudeConfirm(true);
      }
    },
    { isActive: true },
  );

  // Heading and (outside the modal) setting rows stay visible; while the
  // risk modal is open the setting rows hide so the warning gets every
  // row it needs. The warning is NEVER truncated: if it cannot fit, the
  // confirmation control does not mount and acceptance is impossible.
  const { enabled, intervalSeconds } = settings.autoRefresh;
  const autoRefreshText = enabled
    ? intervalSeconds % 60 === 0
      ? `${intervalSeconds / 60}m`
      : `${intervalSeconds}s`
    : "off";
  const settingRows = [
    <Text key="auto" wrap="truncate">
      Auto refresh: {autoRefreshText} · t cycles off/1m/5m/10m · default 10m
    </Text>,
    <Text key="bell" wrap="truncate">
      Bell alerts: {settings.alerts.enabled ? "on" : "off (default)"} (b)
    </Text>,
    <Text key="threshold" wrap="truncate">
      Bell threshold: {settings.alerts.thresholdPercent}% · 1–99 · visual list
      fixed at 20% (+/-)
    </Text>,
    <Text key="claude" wrap="truncate">
      Claude policy:{" "}
      {settings.claudePolicyAccepted ? "accepted" : "not accepted"} (c)
    </Text>,
    <Text key="hidden" wrap="truncate">
      Hidden accounts: {settings.hiddenAccountIds.length} · x hide on dashboard,
      X show all
    </Text>,
  ];
  const compact = viewport.compact;
  const paddingRows = compact ? 0 : 2;
  const warningWidth = Math.max(MIN_WIDTH, viewport.width - 6);
  const warningRows = wrappedLineCount(CLAUDE_POLICY_WARNING, warningWidth);
  // Modal chrome: borders(2) + title + input + inner gaps(2) + outer gap +
  // route heading + frame padding rows, all under the viewport height.
  const warningFits = warningRows <= viewport.height - 1 - (paddingRows + 8);
  // Rows budget: compact pays no gaps (n + 3 <= rows - 1); spaced mode pays
  // a gap per row, so 2*n + padding + 4 <= rows - 1.
  const settingBudget = compact
    ? Math.max(0, viewport.height - 4)
    : Math.max(0, Math.floor((viewport.height - 5 - paddingRows) / 2));
  const shownSettings = claudeConfirm
    ? []
    : settingRows.slice(0, settingBudget);
  return (
    <Box flexDirection="column" padding={compact ? 0 : 1} gap={compact ? 0 : 1}>
      <Text bold>Settings</Text>
      {shownSettings}
      {saveError !== null && !claudeConfirm ? (
        <Text color="red">save failed: {saveError}</Text>
      ) : null}
      {claudeConfirm ? (
        <Box borderStyle="round" flexDirection="column" paddingX={1} gap={1}>
          <Text bold color="red">
            Claude account risk — read before accepting
          </Text>
          {warningFits ? (
            <>
              <Text>{CLAUDE_POLICY_WARNING}</Text>
              <ConfirmInput
                onConfirm={() => {
                  setClaudeConfirm(false);
                  onChange({ ...settings, claudePolicyAccepted: true });
                }}
                onCancel={() => {
                  setClaudeConfirm(false);
                }}
              />
            </>
          ) : (
            <Text color="red" wrap="truncate">
              Terminal too small to show the full policy warning — resize taller
              to review it before accepting. (Esc cancels)
            </Text>
          )}
        </Box>
      ) : (
        <Text dimColor>Esc back · q quit</Text>
      )}
    </Box>
  );
}

function AuthRoute({
  controller,
  snapshot,
  clockNow,
  onBack,
  onQuit,
  viewport,
}: {
  controller: MonitorController;
  snapshot: MonitorSnapshot;
  clockNow: () => number;
  onBack: () => void;
  onQuit: () => void;
  viewport: ViewportLayout;
}): React.JSX.Element {
  const auth = snapshot.auth;
  const flow = auth?.flow ?? null;
  const compact = viewport.compact;
  const secretRef = useRef("");
  const [submitKey, setSubmitKey] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // ----- Management mode (no active flow): every provider you added. -----
  // One group per ADD_PROVIDERS entry that holds accounts — native
  // logins list their source's accounts; API-key vendors merge the
  // vendor's keys across the sources that hold them. Adding accounts
  // goes through the searchable provider picker.
  const userAdded = snapshot.userAddedAccountIds;
  const groups = useMemo(
    () =>
      ADD_PROVIDERS.map((entry) => ({
        label: entry.label,
        // Only what the USER added through Fuel Gauge shows here —
        // auto-imported credentials stay in the sources tab. Every
        // fuelGauge record is a pasted key, so the vendor group needs
        // no filter; agent-imported entries group by the agent's
        // provider id.
        accounts:
          entry.kind === "apiKey"
            ? (snapshot.providers.get("fuelGauge")?.accounts ?? [])
                .filter(
                  (account) =>
                    account.provider === "fuelGauge" &&
                    account.vendor === entry.id,
                )
                .map((account) => ({ account }))
            : entry.kind === "agentImport"
              ? (snapshot.providers.get(entry.agent)?.accounts ?? [])
                  .filter(
                    (account) =>
                      account.provider === "opencode" &&
                      account.openCodeProviderId === entry.id &&
                      userAdded.has(account.id),
                  )
                  .map((account) => ({ account }))
              : (snapshot.providers.get(entry.source)?.accounts ?? [])
                  .filter((account) => userAdded.has(account.id))
                  .map((account) => ({ account })),
      })).filter((group) => group.accounts.length > 0),
    [snapshot, userAdded],
  );
  const accounts = groups.flatMap((group) => group.accounts);
  const rowCount = 1 + accounts.length; // add-account option + one row per account
  const [choice, setChoice] = useState(0);
  const [deleting, setDeleting] = useState<AccountSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [pickIndex, setPickIndex] = useState(0);
  /** Agent-import flow: the picked entry plus its discovered candidates. */
  const [importing, setImporting] = useState<{
    entry: AddProviderEntry & { kind: "agentImport" };
    candidates: readonly ImportCandidate[];
  } | null>(null);
  const [importIndex, setImportIndex] = useState(0);
  const [importConfirming, setImportConfirming] =
    useState<ImportCandidate | null>(null);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ADD_PROVIDERS.filter((entry) =>
      entry.label.toLowerCase().includes(needle),
    );
  }, [query]);
  const picked =
    matches[Math.min(pickIndex, Math.max(0, matches.length - 1))] ?? null;
  const selected = choice % Math.max(1, rowCount);

  // Expiry countdown poll: lives only while a flow is mounted.
  useEffect(() => {
    if (flow === null) {
      return;
    }
    const tick = (): void => {
      setSecondsLeft(
        Math.max(0, Math.round((flow.expiresAt - clockNow()) / 1000)),
      );
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [flow, clockNow]);

  const acceptsSubmission =
    flow !== null &&
    (flow.mode === "manualCode" ||
      flow.mode === "apiKey" ||
      (flow.mode === "browserCallback" && flow.submit !== undefined));

  // This route owns the keyboard while mounted. While a secret input is
  // offered, EVERY printable key (including q and o) belongs to the input —
  // nothing here may steal it; Esc still cancels because the input ignores
  // escape sequences.
  useInput(
    (input, key) => {
      if (key.escape) {
        if (flow !== null) {
          void controller.cancelAuth();
          return;
        }
        if (importConfirming !== null) {
          setImportConfirming(null);
          return;
        }
        if (importing !== null) {
          setImporting(null);
          return;
        }
        if (picking) {
          setPicking(false);
          return;
        }
        if (deleting !== null) {
          setDeleting(null);
          return;
        }
        onBack();
        return;
      }
      if (flow !== null) {
        if (acceptsSubmission) {
          return;
        }
        if (input === "q") {
          onQuit();
        }
        return;
      }
      if (picking) {
        // The picker's search field owns every printable key; arrows
        // move the match list and Enter starts the picked flow.
        if (key.upArrow) {
          setPickIndex((current) =>
            matches.length === 0
              ? 0
              : (current + matches.length - 1) % matches.length,
          );
          return;
        }
        if (key.downArrow) {
          setPickIndex((current) =>
            matches.length === 0 ? 0 : (current + 1) % matches.length,
          );
          return;
        }
        if (key.return && picked !== null) {
          if (picked.kind === "agentImport") {
            void beginAgentImport(picked);
            return;
          }
          setPicking(false);
          void startAddAccount(
            picked.kind === "login" ? picked.source : "fuelGauge",
          );
        }
        return;
      }
      if (importing !== null) {
        if (importConfirming !== null) {
          return; // ConfirmInput owns the keyboard
        }
        if (key.upArrow || input === "k") {
          setImportIndex((current) =>
            importing.candidates.length === 0
              ? 0
              : (current + importing.candidates.length - 1) %
                importing.candidates.length,
          );
          return;
        }
        if (key.downArrow || input === "j") {
          setImportIndex((current) =>
            importing.candidates.length === 0
              ? 0
              : (current + 1) % importing.candidates.length,
          );
          return;
        }
        const candidate =
          importing.candidates[
            importIndex % Math.max(1, importing.candidates.length)
          ];
        if (key.return && candidate !== undefined) {
          setImportConfirming(candidate);
        }
        return;
      }
      if (deleting !== null) {
        return; // ConfirmInput owns the keyboard
      }
      if (input === "q") {
        onQuit();
        return;
      }
      if (key.upArrow || input === "k") {
        setChoice((current) => (current + rowCount - 1) % rowCount);
        return;
      }
      if (key.downArrow || input === "j") {
        setChoice((current) => (current + 1) % rowCount);
        return;
      }
      if (key.return && selected === 0) {
        setAddError(null);
        setPickerKey((current) => current + 1);
        setQuery("");
        setPickIndex(0);
        setPicking(true);
        return;
      }
      if (input === "d" && selected > 0) {
        const target = accounts[selected - 1]?.account;
        if (target !== undefined) {
          setDeleteError(null);
          setDeleting(target);
        }
      }
    },
    { isActive: true },
  );

  /**
   * Agent-managed providers (e.g. xAI Grok via opencode): the CLI owns
   * the OAuth, so adding means discovering the agent's credential store
   * and importing the picked provider's entries after a confirm. The
   * candidate labels are built from the same display names as the
   * picker entries, so the `${label} ` prefix filters them.
   */
  async function beginAgentImport(
    entry: AddProviderEntry & { kind: "agentImport" },
  ): Promise<void> {
    await controller.discoverImports(entry.agent);
    const candidates = (
      controller.getSnapshot().providers.get(entry.agent)?.importCandidates ??
      []
    ).filter(
      (candidate) =>
        candidate.label === entry.label ||
        candidate.label.startsWith(`${entry.label} ·`),
    );
    setPicking(false);
    setImportIndex(0);
    setImportConfirming(null);
    setImporting({ entry, candidates });
  }

  async function runImport(candidate: ImportCandidate): Promise<void> {
    if (importing === null) {
      return;
    }
    setImportConfirming(null);
    const ok = await controller.importCandidate(
      importing.entry.agent,
      candidate,
    );
    if (!ok) {
      const fresh = controller
        .getSnapshot()
        .providers.get(importing.entry.agent)?.error;
      setAddError(fresh ?? "import failed — try again");
    }
    setImporting(null);
  }

  /**
   * Adding starts only when the monitor actually begins a flow. A
   * refused start (e.g. agent-managed sources) surfaces the record's
   * typed reason under the management list.
   */
  async function startAddAccount(provider: ProviderId): Promise<void> {
    const result = await controller.beginAuth(provider);
    if (!result.ok) {
      const fresh = controller.getSnapshot().providers.get(provider)?.error;
      setAddError(fresh ?? result.reason);
    }
  }

  async function runDelete(account: AccountSummary): Promise<void> {
    setDeleting(null);
    // The row knows its own source (fuelGauge paste or opencode import)
    // — the copy is removed from wherever it actually lives.
    await controller.removeAccount(account.provider, account.id);
    const fresh = controller
      .getSnapshot()
      .providers.get(account.provider)?.error;
    if (fresh != null) {
      setDeleteError(fresh);
    }
  }

  // ----- Active flow: the login/paste surface, unchanged. -----
  if (auth !== null && flow !== null) {
    return (
      <Box flexDirection="column" padding={compact ? 0 : 1} gap={1}>
        <Text bold wrap="truncate">
          Auth — {PROVIDER_LABELS[auth.provider]} ({flow.mode})
        </Text>
        {"authUrl" in flow && flow.authUrl ? (
          <Box gap={1}>
            <Text dimColor>URL:</Text>
            <Text wrap="truncate">{flow.authUrl}</Text>
            {acceptsSubmission ? null : <Text dimColor>(o to reopen)</Text>}
          </Box>
        ) : null}
        {!compact && "userCode" in flow && flow.userCode ? (
          <Box gap={1}>
            <Text dimColor>Code:</Text>
            <Text bold color="green">
              {flow.userCode}
            </Text>
          </Box>
        ) : null}
        {!compact && "verificationUri" in flow && flow.verificationUri ? (
          <Box gap={1}>
            <Text dimColor>Verify at:</Text>
            <Text wrap="truncate">{flow.verificationUri}</Text>
          </Box>
        ) : null}
        <Text dimColor>
          {auth.submitting ? "Submitting…" : "Waiting for login"} · expires in{" "}
          {secondsLeft ?? "?"} s (Esc cancels)
        </Text>
        {acceptsSubmission ? (
          <Box gap={1}>
            <Text dimColor>
              Paste {flow.mode === "apiKey" ? flow.hint : "secret"}:
            </Text>
            {/* Remounted per submission; the plaintext lives in a ref, never
                in React state, and is cleared the moment it is submitted. */}
            <PasswordInput
              key={submitKey}
              placeholder="secret input (no echo)"
              onChange={(value) => {
                secretRef.current = value;
              }}
              onSubmit={(value) => {
                if (flow.submit === undefined) {
                  return;
                }
                const text = value;
                secretRef.current = "";
                setSubmitKey((current) => current + 1);
                controller.setAuthSubmitting(true);
                flow
                  .submit(
                    auth.provider === "claude"
                      ? { kind: "claude", callbackOrCode: text }
                      : auth.provider === "fuelGauge"
                        ? { kind: "fuelGauge", apiKey: text }
                        : { kind: "kiro", callbackUrl: text },
                  )
                  .then(() => {
                    controller.setAuthError(null);
                    controller.setAuthSubmitting(false);
                  })
                  .catch((error: unknown) => {
                    // setAuthError sanitizes before it stores.
                    controller.setAuthError(
                      error instanceof Error ? error.message : "submit failed",
                    );
                    controller.setAuthSubmitting(false);
                  });
              }}
            />
          </Box>
        ) : null}
        {auth.error !== null ? <Text color="red">{auth.error}</Text> : null}
      </Box>
    );
  }

  // ----- Agent-import screen: pick the CLI's credential, confirm, copy. -----
  if (importing !== null) {
    const { entry, candidates } = importing;
    return (
      <Box
        flexDirection="column"
        padding={compact ? 0 : 1}
        gap={compact ? 0 : 1}
      >
        <Text bold wrap="truncate">
          Add {entry.label} — import from {PROVIDER_LABELS[entry.agent]}
        </Text>
        <Text dimColor wrap="truncate">
          {PROVIDER_LABELS[entry.agent]} owns the OAuth login; Fuel Gauge copies
          the credential after you confirm.
        </Text>
        {candidates.length === 0 ? (
          <Text color="red" wrap="truncate">
            No {entry.label} account in {PROVIDER_LABELS[entry.agent]}'s
            credential store — log in there first (e.g. `opencode auth login{" "}
            {entry.id}`), then retry.
          </Text>
        ) : (
          <Box flexDirection="column">
            {candidates.map((candidate, index) => {
              const isSelected = index === importIndex % candidates.length;
              return (
                <Box key={`${candidate.source}:${candidate.label}`} gap={1}>
                  <Text color={isSelected ? "cyan" : "gray"}>
                    {isSelected ? "❯" : " "}
                  </Text>
                  <Text wrap="truncate">• {candidate.label}</Text>
                </Box>
              );
            })}
          </Box>
        )}
        <Text dimColor>j/k choose · Enter confirm · Esc back</Text>
        {importConfirming !== null ? (
          <Box borderStyle="round" flexDirection="column" paddingX={1} gap={1}>
            <Text bold>Copy this credential into Fuel Gauge?</Text>
            <Text dimColor wrap="truncate">
              {importConfirming.label}
            </Text>
            <Text dimColor>
              The source is only READ after you confirm; the original stays
              untouched.
            </Text>
            <Text color="yellow">
              The copy is stored as PLAINTEXT in Fuel Gauge's app-private config
              — treat it as a secret.
            </Text>
            <ConfirmInput
              onConfirm={() => {
                void runImport(importConfirming);
              }}
              onCancel={() => {
                setImportConfirming(null);
              }}
            />
          </Box>
        ) : null}
        {addError !== null ? <Text color="red">{addError}</Text> : null}
      </Box>
    );
  }

  // ----- Management: the FuelGauge keys, plus the provider picker. -----
  if (picking) {
    return (
      <Box
        flexDirection="column"
        padding={compact ? 0 : 1}
        gap={compact ? 0 : 1}
      >
        <Text bold wrap="truncate">
          Add an account — choose a provider
        </Text>
        <Box gap={1}>
          <Text dimColor>Search:</Text>
          {/* Remounted per open so each picker session starts empty. */}
          <TextInput
            key={pickerKey}
            defaultValue=""
            placeholder="type to filter"
            onChange={setQuery}
          />
        </Box>
        <Box flexDirection="column">
          {matches.map((entry) => {
            const isSelected = entry === picked;
            return (
              <Box key={entry.id} gap={1}>
                <Text color={isSelected ? "cyan" : "gray"}>
                  {isSelected ? "❯" : " "}
                </Text>
                <Text wrap="truncate">{entry.label}</Text>
                <Box flexGrow={1} flexShrink={1} minWidth={2}>
                  <Text> </Text>
                </Box>
                <Text dimColor>{addMethodLabel(entry)}</Text>
              </Box>
            );
          })}
          {matches.length === 0 ? (
            <Text dimColor> no matching source</Text>
          ) : null}
        </Box>
        <Text dimColor>
          type to filter · ↑/↓ choose · Enter start · Esc back
        </Text>
      </Box>
    );
  }
  // Row budget keeps the frame under the viewport; overflow collapses
  // behind a count hint (title, subtitle, add row, hint, gaps, padding).
  // Reserve: tab bar, padding (2), title, subtitle, add row, key hint,
  // child gaps, the clipped-count hint itself, and a safety row.
  const rowBudget = Math.max(1, viewport.height - (viewport.compact ? 6 : 13));
  const shownGroups: {
    label: string;
    accounts: (typeof groups)[number]["accounts"];
  }[] = [];
  let clipped = 0;
  let usedRows = 0;
  for (const group of groups) {
    if (usedRows + 1 > rowBudget) {
      clipped += group.accounts.length;
      continue;
    }
    usedRows += 1;
    const room = Math.max(0, rowBudget - usedRows);
    const take = group.accounts.slice(0, room);
    clipped += group.accounts.length - take.length;
    usedRows += take.length;
    shownGroups.push({ label: group.label, accounts: take });
  }
  return (
    <Box flexDirection="column" padding={compact ? 0 : 1} gap={compact ? 0 : 1}>
      <Text bold wrap="truncate">
        Auth — manage accounts
      </Text>
      <Text dimColor wrap="truncate">
        Every provider you added: review, delete · add accounts for any provider
      </Text>
      <Box gap={1}>
        <Text color={selected === 0 ? "cyan" : "gray"}>
          {selected === 0 ? "❯" : " "}
        </Text>
        <Text wrap="truncate">+ add account</Text>
      </Box>
      {/* The group list is deliberately NOT gapped: one row per line keeps
          tall account lists inside the viewport budget. */}
      <Box flexDirection="column">
        {groups.length === 0 ? (
          <Text dimColor> No accounts yet — add one above.</Text>
        ) : (
          shownGroups.map((group) => (
            <Box key={group.label} flexDirection="column">
              <Text bold color="magenta" wrap="truncate">
                {group.label}
              </Text>
              {group.accounts.map(({ account }) => {
                const index = accounts.findIndex(
                  (entry) => entry.account.id === account.id,
                );
                const isSelected = index + 1 === selected;
                return (
                  <Box key={`${account.provider}:${account.id}`} gap={1}>
                    <Text color={isSelected ? "cyan" : "gray"}>
                      {isSelected ? "❯" : " "}
                    </Text>
                    <Text wrap="truncate">• {sourceAccountLabel(account)}</Text>
                    <Box flexGrow={1} flexShrink={1} minWidth={2}>
                      <Text> </Text>
                    </Box>
                    {account.status !== "active" ? (
                      <Text color="red">⚠</Text>
                    ) : null}
                    {isSelected ? <Text dimColor>d delete</Text> : null}
                  </Box>
                );
              })}
            </Box>
          ))
        )}
      </Box>
      {clipped > 0 ? <Text dimColor>+{clipped} more accounts…</Text> : null}
      <Text dimColor>j/k choose · Enter add account · d delete · Esc back</Text>
      {deleting !== null ? (
        <Box borderStyle="round" flexDirection="column" paddingX={1} gap={1}>
          <Text bold>
            Delete this {deleting.provider === "fuelGauge" ? "key" : "account"}{" "}
            from Fuel Gauge?
          </Text>
          <Text dimColor wrap="truncate">
            {PROVIDER_LABELS[deleting.provider]} ·{" "}
            {sourceAccountLabel(deleting)}
          </Text>
          <Text dimColor>
            Removes Fuel Gauge's stored copy only. This cannot be undone.
          </Text>
          <ConfirmInput
            onConfirm={() => {
              void runDelete(deleting);
            }}
            onCancel={() => {
              setDeleting(null);
            }}
          />
        </Box>
      ) : null}
      {addError !== null ? <Text color="red">{addError}</Text> : null}
      {deleteError !== null ? <Text color="red">{deleteError}</Text> : null}
    </Box>
  );
}

/** One checkbox row: every imported account, checked = visible. */
interface VisibilityRow {
  /** Owning provider record — ids are unique per provider only. */
  readonly provider: ProviderId;
  readonly id: string;
  readonly label: string;
}

function VisibilityRoute({
  rows,
  hiddenIds,
  onToggle,
  onShowAll,
  onBack,
  viewport,
}: {
  rows: readonly VisibilityRow[];
  hiddenIds: readonly string[];
  onToggle: (accountId: string) => void;
  onShowAll: () => void;
  onBack: () => void;
  viewport: ViewportLayout;
}): React.JSX.Element {
  const [cursor, setCursor] = useState(0);
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (rows.length === 0) {
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((current) => (current + rows.length - 1) % rows.length);
        return;
      }
      if (key.downArrow || input === "j") {
        setCursor((current) => (current + 1) % rows.length);
        return;
      }
      if (key.return || input === " " || input === "x") {
        const row = rows[cursor];
        if (row !== undefined) {
          onToggle(row.id);
        }
        return;
      }
      if (input === "X" && hiddenIds.length > 0) {
        onShowAll();
      }
    },
    { isActive: true },
  );
  // Window the rows around the cursor so the modal always fits.
  const budget = Math.max(1, viewport.height - 6);
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(budget / 2), rows.length - budget),
  );
  const shown = rows.slice(start, start + budget);
  return (
    <Box flexDirection="column" gap={1} flexGrow={1}>
      <Text bold>
        Visibility — {rows.length - hiddenIds.length}/{rows.length} shown
      </Text>
      {shown.length === 0 ? (
        <Text dimColor>No accounts imported yet.</Text>
      ) : (
        <Box flexDirection="column">
          {shown.map((row) => {
            const index = rows.indexOf(row);
            const selected = index === cursor;
            const visible = !hidden.has(row.id);
            return (
              <Box key={`${row.provider}:${row.id}`} gap={1}>
                <Text color={selected ? "cyan" : undefined}>
                  {selected ? "❯" : " "}
                </Text>
                <Text color={visible ? "green" : "gray"}>
                  [{visible ? "x" : " "}]
                </Text>
                <Text wrap="truncate" dimColor={!visible}>
                  {row.label}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
      {start > 0 ? <Text dimColor>↑ {start} more</Text> : null}
      {start + budget < rows.length ? (
        <Text dimColor>↓ {rows.length - start - budget} more</Text>
      ) : null}
      <Text dimColor wrap="truncate">
        j/k move · Enter/space toggle · X show all · Esc back
      </Text>
    </Box>
  );
}

function HelpRoute({
  viewport,
}: {
  viewport: ViewportLayout;
}): React.JSX.Element {
  const entries: readonly [string, string][] = [
    ["Tab / Shift+Tab", "switch tabs (Accounts/Sources/Auth/…)"],
    ["↑/k previous · ↓/j next", "move selection"],
    ["Enter", "open selection / confirm"],
    ["Esc", "close overlay / cancel auth"],
    ["r", "refresh selected source"],
    ["R", "refresh all (sequential)"],
    ["a", "auth tab: manage FuelGauge keys"],
    ["x", "hide selected account (X show all)"],
    ["h", "visibility checkboxes for every account"],
    ["s", "settings"],
    ["?", "help"],
    ["q", "quit"],
  ];
  // Rows beyond the budget collapse into a count hint so the route always
  // stays under the viewport height. Spaced mode pays a gap per row
  // (2*n + 7 <= rows - 1); compact mode pays none (n + 4 <= rows - 1).
  const allowed = viewport.compact
    ? Math.max(0, viewport.height - 6)
    : Math.max(0, Math.floor((viewport.height - 10) / 2));
  const shown = entries.slice(0, allowed);
  return (
    <Box
      flexDirection="column"
      padding={viewport.compact ? 0 : 1}
      gap={viewport.compact ? 0 : 1}
    >
      <Text bold>Help — keys</Text>
      {shown.map(([key, description]) => (
        <Box key={key} gap={1}>
          <Box width={16}>
            <Text bold color="cyan">
              {key}
            </Text>
          </Box>
          <Text wrap="truncate">{description}</Text>
        </Box>
      ))}
      {entries.length > shown.length ? (
        <Text dimColor>+{entries.length - shown.length} more keys…</Text>
      ) : null}
      <Text dimColor wrap="truncate">
        Global keys pause while a field or modal is focused.
      </Text>
    </Box>
  );
}

/** The top tab strip: brand + every tab, the active one bracketed. */
function TabBar({
  tab,
  busy,
}: {
  tab: TabId;
  busy: boolean;
}): React.JSX.Element {
  return (
    <Box gap={1}>
      <Text bold color="cyan" inverse>
        {" "}
        fuel-gauge{" "}
      </Text>
      {TAB_ORDER.map((id) => (
        <Text key={id} bold color={id === tab ? "cyan" : "gray"}>
          {id === tab ? `[${TAB_LABELS[id]}]` : TAB_LABELS[id]}
        </Text>
      ))}
      {busy ? (
        <Text dimColor wrap="truncate">
          · refreshing…
        </Text>
      ) : null}
    </Box>
  );
}

export function App({
  runtime,
  registerDispose,
}: {
  runtime: Runtime;
  /** Invoked once with the App's deterministic cleanup (CLI awaits it). */
  registerDispose?: (dispose: () => Promise<void>) => void;
}): React.JSX.Element {
  const app = useApp();
  const { stdout } = useStdout();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("accounts");
  const [overlay, setOverlay] = useState<OverlayKind | null>(null);
  /** Switching tabs always dismisses any open overlay first. */
  const switchTab = useCallback((next: TabId) => {
    setOverlay(null);
    setTab(next);
  }, []);
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderId>("githubCopilot");
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    null,
  );
  const [alerts, setAlerts] = useState<AlertsState>(EMPTY_ALERTS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const controller = useMemo(
    () => new MonitorController({ runtime, settings: DEFAULT_SETTINGS }),
    [runtime],
  );
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const viewport = useViewport();

  // Load persisted settings, push them into the controller, and only THEN
  // start the monitor. Settings-load failure and monitor-start failure are
  // reported separately (no retry, no unhandled rejection), and late state
  // updates after unmount are dropped.
  useEffect(() => {
    const lifecycle = { mounted: true };
    void (async () => {
      try {
        const loaded = await runtime.store.loadSettings();
        if (!lifecycle.mounted) {
          return;
        }
        controller.updateSettings(loaded);
        setSettings(loaded);
        setSettingsError(null);
      } catch (error) {
        if (!lifecycle.mounted) {
          return;
        }
        // Keep the in-memory defaults — and since auto refresh now
        // defaults ON, push them into the controller so the timer is
        // actually scheduled; the monitor still starts below.
        controller.updateSettings(DEFAULT_SETTINGS);
        setSettingsError(sanitizeUiError(error));
      }
      try {
        await controller.start();
      } catch (error) {
        if (lifecycle.mounted) {
          setStartError(sanitizeUiError(error));
        }
      }
    })();
    return () => {
      lifecycle.mounted = false;
      void controller.dispose();
    };
  }, [runtime.store, controller]);

  // Expose the idempotent cleanup so the CLI entry can await it after Ink
  // settles (covers the built-in Ctrl-C exit path too).
  useEffect(() => {
    registerDispose?.(() => controller.dispose());
  }, [registerDispose, controller]);

  // Alerts derive from the same rendered metrics the dashboard shows. The
  // previous state lives in a ref so the updater stays pure and the bell —
  // a committed side effect — fires at most once per edge, never during
  // render, and never before the startup baseline completes.
  const alertsRef = useRef(alerts);
  useEffect(() => {
    const accounts = [...snapshot.providers.values()].flatMap(
      (state) => state.accounts,
    );
    const update = updateAlerts(
      alertsRef.current,
      accounts,
      settingsRef.current.alerts,
      runtime.clock.now(),
    );
    alertsRef.current = update.state;
    setAlerts(update.state);
    if (snapshot.startupComplete) {
      const bell = bellOutput(
        update.newlyFired,
        settingsRef.current.alerts.enabled,
      );
      if (bell !== "") {
        stdout.write(bell);
      }
    }
  }, [snapshot, runtime.clock, stdout]);

  const saveSettings = useCallback(
    (next: Settings) => {
      setSettings(next);
      controller.updateSettings(next);
      void runtime.store.saveSettings(next).then(
        () => {
          setSettingsError(null);
        },
        (error: unknown) => {
          setSettingsError(sanitizeUiError(error));
        },
      );
    },
    [runtime.store, controller],
  );

  const hiddenAccountIds = useMemo(
    () => new Set(settings.hiddenAccountIds),
    [settings.hiddenAccountIds],
  );
  // Hidden accounts are filtered from every view (cards, details, merge)
  // but stay imported and refreshed; the Settings route lists them.
  const accountsByProvider = useMemo(() => {
    const map = new Map<ProviderId, readonly AccountSummary[]>();
    for (const [provider, state] of snapshot.providers) {
      map.set(
        provider,
        state.accounts.filter((account) => !hiddenAccountIds.has(account.id)),
      );
    }
    return map;
  }, [snapshot, hiddenAccountIds]);
  const providerAccounts = useCallback(
    (provider: ProviderId): readonly AccountSummary[] =>
      accountsByProvider.get(provider) ?? [],
    [accountsByProvider],
  );
  // The sources tab orders by registered account count (ties keep the
  // canonical order) and folds empty sources to the bottom; j/k and the
  // card grid both walk this order.
  const sourcesOrder = useMemo(
    () => orderSourcesByAccounts(accountsByProvider),
    [accountsByProvider],
  );

  const exitApp = useCallback(() => {
    void controller.dispose().finally(() => {
      app.exit();
    });
  }, [app, controller]);

  const moveProvider = useCallback(
    (delta: number) => {
      const index = sourcesOrder.indexOf(selectedProvider);
      const next =
        sourcesOrder[
          (index + delta + sourcesOrder.length) % sourcesOrder.length
        ];
      if (next !== undefined) {
        setSelectedProvider(next);
        const first = providerAccounts(next)[0];
        setSelectedAccountId(first?.id ?? null);
      }
    },
    [selectedProvider, providerAccounts, sourcesOrder],
  );

  // Land the selection on the first card once real accounts arrive: the
  // sources tab leads with the busiest source, so a selection parked on
  // an empty source would start folded at the bottom of the tab. Runs at
  // most once — afterwards the user owns the selection, including the
  // folded sources.
  const selectionLanded = useRef(false);
  useEffect(() => {
    if (selectionLanded.current) {
      return;
    }
    if ((accountsByProvider.get(selectedProvider)?.length ?? 0) > 0) {
      selectionLanded.current = true;
      return;
    }
    const target = sourcesOrder[0];
    if (
      target !== undefined &&
      (accountsByProvider.get(target)?.length ?? 0) > 0
    ) {
      selectionLanded.current = true;
      setSelectedProvider(target);
      setSelectedAccountId(accountsByProvider.get(target)?.[0]?.id ?? null);
    }
  }, [accountsByProvider, selectedProvider, sourcesOrder]);

  const currentAccounts = providerAccounts(selectedProvider);

  // Keep the account selection valid: select the first account when none
  // is chosen, and re-select when the selected one disappears (removal,
  // refresh replacement). Without this the compact view would show no
  // metric rows and `d` could target a dangling id.
  useEffect(() => {
    if (currentAccounts.length === 0) {
      return;
    }
    const stillThere = currentAccounts.some(
      (account) => account.id === selectedAccountId,
    );
    if (!stillThere) {
      setSelectedAccountId(currentAccounts[0]?.id ?? null);
    }
  }, [currentAccounts, selectedAccountId]);

  // Tab navigation works everywhere: @inkjs/ui text inputs ignore Tab
  // themselves, so switching can never pollute a field value.
  useInput(
    (_input, key) => {
      if (key.tab) {
        switchTab(nextTab(tab, key.shift ? -1 : 1));
      }
    },
    { isActive: true },
  );

  const routeOwnsKeys =
    tab === "settings" || tab === "auth" || overlay === "visibility";

  useInput(
    (input, key) => {
      if (routeOwnsKeys) {
        return; // the mounted route's own handler is active
      }
      if (input === "q") {
        exitApp();
        return;
      }
      if (key.escape) {
        if (overlay !== null) {
          setOverlay(null);
        }
        return;
      }
      if (key.upArrow || input === "k" || key.downArrow || input === "j") {
        const step = key.upArrow || input === "k" ? -1 : 1;
        if (
          tab === "accounts" &&
          overlay === null &&
          mergedEntries.length > 0
        ) {
          // Accounts tab: j/k walks merged identities; the selection
          // follows so r/Enter still target the right account.
          const found = mergedEntries.findIndex((entry) =>
            entry.accounts.some((account) => account.id === selectedAccountId),
          );
          const index =
            found === -1 && step === -1 ? mergedEntries.length : found;
          const next =
            mergedEntries[
              (index + step + mergedEntries.length) % mergedEntries.length
            ];
          if (next !== undefined) {
            setSelectedAccountId(next.accounts[0]?.id ?? null);
            const provider = next.providers[0];
            if (provider !== undefined) {
              setSelectedProvider(provider);
            }
          }
          return;
        }
        if (overlay === "details" && currentAccounts.length > 0) {
          const found = currentAccounts.findIndex(
            (account) => account.id === selectedAccountId,
          );
          const index =
            found === -1 && step === -1 ? currentAccounts.length : found;
          const next =
            currentAccounts[
              (index + step + currentAccounts.length) % currentAccounts.length
            ];
          setSelectedAccountId(next?.id ?? null);
          return;
        }
        moveProvider(step);
        return;
      }
      if (input === "r") {
        void controller.refreshSelected(selectedProvider);
        return;
      }
      if (input === "R") {
        void controller.refreshAll();
        return;
      }
      if (input === "?") {
        switchTab("help");
        return;
      }
      if (input === "s") {
        switchTab("settings");
        return;
      }
      if (input === "h") {
        setOverlay("visibility");
        return;
      }
      if (input === "a") {
        switchTab("auth");
        return;
      }
      if (input === "p") {
        const target =
          currentAccounts.find((account) => account.id === selectedAccountId) ??
          currentAccounts[0] ??
          null;
        if (target !== null) {
          const pinned = settings.pinnedAccountIds.includes(target.id);
          saveSettings({
            ...settings,
            pinnedAccountIds: pinned
              ? settings.pinnedAccountIds.filter((id) => id !== target.id)
              : [...settings.pinnedAccountIds, target.id],
          });
        }
        return;
      }
      if (input === "x" || input === "X") {
        // x toggles the selected account out of every view; X restores
        // all hidden accounts at once. Hidden accounts stay refreshed.
        if (input === "X") {
          if (settings.hiddenAccountIds.length > 0) {
            saveSettings({ ...settings, hiddenAccountIds: [] });
          }
          return;
        }
        if (overlay === "account" && selectedAccountId !== null) {
          const hidden = settings.hiddenAccountIds.includes(selectedAccountId);
          saveSettings({
            ...settings,
            hiddenAccountIds: hidden
              ? settings.hiddenAccountIds.filter(
                  (id) => id !== selectedAccountId,
                )
              : [...settings.hiddenAccountIds, selectedAccountId],
          });
          return;
        }
        if (tab === "accounts" && overlay === null) {
          const entry = mergedEntries.find((candidate) =>
            candidate.accounts.some(
              (account) => account.id === selectedAccountId,
            ),
          );
          if (entry !== undefined) {
            saveSettings({
              ...settings,
              hiddenAccountIds: [
                ...new Set([
                  ...settings.hiddenAccountIds,
                  ...entry.accounts.map((account) => account.id),
                ]),
              ],
            });
            setSelectedAccountId(null);
          }
        }
        return;
      }
      if (key.return) {
        if (overlay !== null) {
          return;
        }
        if (tab === "accounts") {
          // Enter on a merged entry opens the account detail modal; the
          // provider details page stays the target in the sources tab.
          setOverlay("account");
          return;
        }
        setOverlay("details");
      }
    },
    { isActive: !routeOwnsKeys },
  );

  const contentWidth = nonNegative(viewport.width - 2);
  const detailWidth = contentWidth;
  // Sources tab: the sources without accounts render as the trailing
  // "no accounts" list block. Its full height (gap + border + header +
  // one row per source) is reserved up front so the whole frame still
  // fits the viewport.
  const emptySources = useMemo(
    () =>
      sourcesOrder.filter(
        (provider) => (accountsByProvider.get(provider)?.length ?? 0) === 0,
      ),
    [sourcesOrder, accountsByProvider],
  );
  const noAccountsTailRows =
    emptySources.length > 0
      ? 1 + SOURCE_BLOCK_BASE_ROWS + emptySources.length
      : 0;
  const visibilityRows = useMemo<VisibilityRow[]>(
    () =>
      PROVIDER_ORDER.flatMap((provider) =>
        (snapshot.providers.get(provider)?.accounts ?? []).map((account) => ({
          provider,
          id: account.id,
          // provider accounts get the provider label prefixed so every
          // row is distinguishable at a glance.
          label:
            account.provider === "omp" || account.provider === "opencode"
              ? accountDisplayLabel(account)
              : `${PROVIDER_LABELS[account.provider]} · ${accountDisplayLabel(
                  account,
                )}`,
        })),
      ),
    [snapshot],
  );
  const mergedEntries = useMemo(
    () =>
      markPinnedEntries(
        mergeAccountsByIdentity(
          PROVIDER_ORDER.flatMap(
            (provider) => accountsByProvider.get(provider) ?? [],
          ),
        ),
        settings.pinnedAccountIds,
      ),
    [accountsByProvider, settings.pinnedAccountIds],
  );
  // Fixed chrome above/below the list: tab bar, title, gaps, and a
  // possible startup-error line (the low-quota panel is gone from this
  // tab — alerts still ring the bell).
  const sourcesChromeRows =
    viewport.kind === "short" ? 3 : DASHBOARD_CHROME_ROWS;
  const sourcesPlan = planSourcesList({
    budgetRows: viewport.height - sourcesChromeRows - noAccountsTailRows,
    accountsByProvider,
    selectedProvider,
  });
  // Details pagination: the selected account first, then as many whole
  // account blocks as fit under the viewport; overflow collapses to a hint.
  const detailAccounts = useMemo(() => {
    const blockRows = (account: AccountSummary): number =>
      4 + account.metrics.length * 2 + (account.status !== "active" ? 1 : 0);
    const ordered = [...currentAccounts].sort((a, b) => {
      const rank = (account: AccountSummary): number =>
        account.id === selectedAccountId ? 0 : 1;
      return rank(a) - rank(b);
    });
    // Reserve heading, gaps, the "+N more accounts" hint, a two-line
    // provider error, and one safety row so multi-account frames with an
    // error can never reach the viewport height.
    const budgetRows = viewport.height - 8;
    const kept: AccountSummary[] = [];
    let used = 0;
    for (const account of ordered) {
      const gap = kept.length === 0 ? 0 : 1;
      if (used + gap + blockRows(account) > budgetRows) {
        break;
      }
      used += gap + blockRows(account);
      kept.push(account);
    }
    return kept.length === 0 && ordered.length > 0 ? ordered.slice(0, 1) : kept;
  }, [currentAccounts, selectedAccountId, viewport.height]);

  function renderDashboard(): React.JSX.Element {
    return tab === "accounts"
      ? renderAccountsDashboard()
      : renderSourcesDashboard();
  }

  /**
   * Default dashboard: one block per real-world identity, titled
   * `Vendor (sources) identity` with every metric row (label + bar +
   * percent) always visible. Per-account detail lives only behind
   * Enter's account modal.
   */
  function renderAccountsDashboard(): React.JSX.Element {
    const inner = Math.max(6, Math.floor(contentWidth * 0.35));
    const selectedEntry = mergedEntries.find((entry) =>
      entry.accounts.some((account) => account.id === selectedAccountId),
    );
    // Row budget: header + hint + error line stay inside the viewport;
    // every entry costs its title row plus its metric rows.
    const budget = viewport.height - 5 - (startError !== null ? 1 : 0);
    let used = 0;
    const shown: MergedAccountEntry[] = [];
    for (const entry of mergedEntries) {
      const cost = 1 + entry.metricRows.length;
      if (used + cost > budget && shown.length > 0) {
        break;
      }
      used += cost;
      shown.push(entry);
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>
          Accounts — {mergedEntries.length} identit
          {mergedEntries.length === 1 ? "y" : "ies"} ·{" "}
          {mergedEntries.reduce((sum, entry) => sum + entry.accounts.length, 0)}{" "}
          accounts (Tab sources, Enter detail
          {settings.hiddenAccountIds.length > 0
            ? `, ${settings.hiddenAccountIds.length} hidden (X show)`
            : ""}
          ){snapshot.busy ? " · refreshing…" : ""}
        </Text>
        {shown.length === 0 ? (
          <Text dimColor>
            {settings.hiddenAccountIds.length > 0
              ? "Every account is hidden. Press X to show all."
              : "No accounts yet. Local credentials are imported automatically."}
          </Text>
        ) : (
          <Box flexDirection="column">
            {shown.map((entry) => {
              const selected = entry === selectedEntry;
              return (
                <Box key={entry.key} flexDirection="column">
                  <Box gap={1}>
                    <Text color={selected ? "cyan" : undefined}>
                      {selected ? "❯" : " "}
                    </Text>
                    <Text
                      bold
                      wrap="truncate"
                      color={selected ? "cyan" : undefined}
                    >
                      {entry.pinned ? "📌 " : ""}
                      {entry.title}
                    </Text>
                    <Box flexGrow={1} flexShrink={1} minWidth={2}>
                      <Text> </Text>
                    </Box>
                    {entry.needsAttention ? <Text color="red">⚠</Text> : null}
                  </Box>
                  {entry.metricRows.map((row) => (
                    <Box key={row.label} gap={1} paddingLeft={3}>
                      <Box flexGrow={1} flexShrink={1} minWidth={6}>
                        <Text wrap="truncate" dimColor>
                          {row.label}
                        </Text>
                      </Box>
                      <Text
                        wrap="truncate"
                        color={
                          row.remainingPercent != null &&
                          row.remainingPercent <= 20
                            ? "red"
                            : "cyan"
                        }
                      >
                        {bar(row.remainingPercent, inner)}
                      </Text>
                      {/* Fixed dim countdown column; blank rows keep the
                          bar and percent columns aligned either way. */}
                      <Box width={7} flexShrink={0}>
                        <Text wrap="truncate" dimColor>
                          {row.resetAt != null
                            ? formatResetIn(row.resetAt, Date.now())
                            : ""}
                        </Text>
                      </Box>
                      {/* Fixed 4-column, right-aligned percent so 94% and
                          100% never shift the bar column. */}
                      <Box width={4} flexShrink={0}>
                        <Text wrap="truncate">
                          {percentText(row.remainingPercent).padStart(4)}
                        </Text>
                      </Box>
                    </Box>
                  ))}
                </Box>
              );
            })}
            {mergedEntries.length > shown.length ? (
              <Text dimColor>
                +{mergedEntries.length - shown.length} more accounts…
              </Text>
            ) : null}
          </Box>
        )}
        {startError !== null ? (
          <Text color="red">startup refresh failed: {startError}</Text>
        ) : null}
      </Box>
    );
  }

  /**
   * Enter's modal: the full per-account detail of the selected merged
   * entry — every member with its agent label, status, and detailed
   * metric rows. Esc returns to the dashboard.
   */
  function renderAccountModal(): React.JSX.Element {
    const entry =
      mergedEntries.find((candidate) =>
        candidate.accounts.some((account) => account.id === selectedAccountId),
      ) ?? mergedEntries[0];
    if (entry === undefined) {
      return <Text dimColor>No account selected.</Text>;
    }
    return (
      <Box flexDirection="column" gap={1} flexGrow={1}>
        <Text bold wrap="truncate">
          {entry.title}
        </Text>
        {entry.accounts.map((account) => (
          <Box
            key={`${account.provider}:${account.id}`}
            flexDirection="column"
            borderStyle="round"
            paddingX={1}
          >
            <Box gap={1}>
              <Text wrap="truncate" bold>
                {accountDisplayLabel(account)}
              </Text>
              <Box flexGrow={1} flexShrink={1} minWidth={2}>
                <Text> </Text>
              </Box>
              <Text
                color={account.status === "active" ? "green" : "red"}
                wrap="truncate"
              >
                {account.status === "active"
                  ? "active"
                  : (account.statusReason ?? account.status)}
              </Text>
            </Box>
            <MetricRows account={account} detailed />
            {account.quotaQueryLastError != null ? (
              <Text color="red" wrap="truncate">
                {account.quotaQueryLastError}
              </Text>
            ) : null}
          </Box>
        ))}
        <Text dimColor wrap="truncate">
          Esc back · x hide/show
        </Text>
      </Box>
    );
  }

  /**
   * Sources tab: one bordered block per populated source — a header row
   * (`❯ Provider · N accounts · phase`) with one row per account inside.
   * Quota usage deliberately lives in the accounts tab and the details
   * overlay, not here: this view is the account inventory. The sources
   * without accounts fold into the dim summary line at the bottom, and
   * SELECTING one of them expands it into its own block; short terminals
   * show only the selected source's block.
   */
  function renderSourcesDashboard(): React.JSX.Element {
    if (viewport.kind === "short") {
      // Compact: the selected source's block is the whole content
      // column; the rest of the list returns at larger sizes.
      const accounts = providerAccounts(selectedProvider);
      // Tab bar + title + gaps + border + header + the "+N more" hint.
      const room = Math.max(0, viewport.height - 8);
      const shown = accounts.slice(0, room);
      return (
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <Text bold wrap="truncate">
            Sources{snapshot.busy ? " · refreshing…" : ""}
          </Text>
          <SourceBlock
            snapshot={snapshot}
            provider={selectedProvider}
            accounts={shown}
            hiddenAccounts={accounts.length - shown.length}
            selectedSource
            selectedAccountId={selectedAccountId}
            pinnedIds={settings.pinnedAccountIds}
          />
        </Box>
      );
    }
    const populatedCount = PROVIDER_ORDER.length - emptySources.length;
    const totalAccounts = [...accountsByProvider.values()].reduce(
      (sum, accounts) => sum + accounts.length,
      0,
    );
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>
          Sources — {totalAccounts} accounts · {populatedCount} of{" "}
          {PROVIDER_ORDER.length} sources
          {snapshot.busy ? " · refreshing…" : ""}
        </Text>
        <Box flexDirection="column" gap={1}>
          {sourcesPlan.entries.map((entry) => (
            <SourceBlock
              key={entry.provider}
              snapshot={snapshot}
              provider={entry.provider}
              accounts={entry.accounts}
              hiddenAccounts={entry.hiddenAccounts}
              selectedSource={entry.provider === selectedProvider}
              selectedAccountId={selectedAccountId}
              pinnedIds={settings.pinnedAccountIds}
            />
          ))}
          {sourcesPlan.hiddenProviders > 0 ? (
            <Text dimColor>+{sourcesPlan.hiddenProviders} more providers</Text>
          ) : null}
          {emptySources.length > 0 ? (
            <NoAccountsBlock
              providers={emptySources}
              selectedProvider={selectedProvider}
            />
          ) : null}
        </Box>
        {startError !== null ? (
          <Text color="red">startup refresh failed: {startError}</Text>
        ) : null}
      </Box>
    );
  }

  function renderVisibility(): React.JSX.Element {
    return (
      <VisibilityRoute
        rows={visibilityRows}
        hiddenIds={settings.hiddenAccountIds}
        onToggle={(accountId: string) => {
          const hidden = settings.hiddenAccountIds.includes(accountId);
          saveSettings({
            ...settings,
            hiddenAccountIds: hidden
              ? settings.hiddenAccountIds.filter((id) => id !== accountId)
              : [...settings.hiddenAccountIds, accountId],
          });
        }}
        onShowAll={() => {
          saveSettings({ ...settings, hiddenAccountIds: [] });
        }}
        onBack={() => {
          setOverlay(null);
        }}
        viewport={viewport}
      />
    );
  }

  function renderDetails(): React.JSX.Element {
    if (viewport.compact) {
      // Compact: the selected account's card is the whole content; its
      // metric rows flex into whatever the viewport still affords.
      return (
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <Text bold wrap="truncate">
            {PROVIDER_LABELS[selectedProvider]} — all accounts
          </Text>
          {currentAccounts.length === 0 ? (
            <Text dimColor>
              No accounts for this source. Press a to add a FuelGauge API key.
            </Text>
          ) : (
            detailAccounts.map((account) => (
              <Box key={account.id} flexDirection="column">
                <ProviderCard
                  snapshot={snapshot}
                  provider={selectedProvider}
                  accounts={[account]}
                  pinnedIds={settings.pinnedAccountIds}
                  width={contentWidth}
                  bars={false}
                  metricAccountIds={new Set([account.id])}
                  selectedAccountId={selectedAccountId}
                  maxMetricRows={Math.max(
                    0,
                    viewport.height - 6 - providerCardBaseRows(1),
                  )}
                />
              </Box>
            ))
          )}
        </Box>
      );
    }
    const providerError = snapshot.providers.get(selectedProvider)?.error;
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{PROVIDER_LABELS[selectedProvider]} — all accounts</Text>
        {currentAccounts.length === 0 ? (
          <Text dimColor>
            No accounts for this source. Press a to add a FuelGauge API key.
          </Text>
        ) : (
          detailAccounts.map((account) => (
            <Box key={account.id} flexDirection="column">
              <ProviderCard
                snapshot={snapshot}
                provider={selectedProvider}
                accounts={[account]}
                pinnedIds={settings.pinnedAccountIds}
                width={detailWidth}
                bars
                // No metric rows inside the box: the detailed rows below
                // are the single metric display (reset stamps, used and
                // total counts included) — in-card rows would duplicate.
                metricAccountIds={new Set<string>()}
                selectedAccountId={selectedAccountId}
              />
              <MetricRows
                account={account}
                detailed
                labelWidth={Math.max(12, Math.floor(detailWidth * 0.5))}
              />
              {account.status !== "active" ? (
                <Text color="red">
                  status: {STATUS_LABELS[account.status]}
                  {account.statusReason != null
                    ? ` (${account.statusReason})`
                    : ""}
                </Text>
              ) : null}
            </Box>
          ))
        )}
        {currentAccounts.length > detailAccounts.length ? (
          <Text dimColor>
            +{currentAccounts.length - detailAccounts.length} more accounts…
            (j/k)
          </Text>
        ) : null}
        {providerError != null ? (
          <Text color="red">{providerError}</Text>
        ) : null}
        <Text dimColor>j/k accounts · Esc back</Text>
      </Box>
    );
  }

  /** The active tab's content; overlays render on top of it. */
  function renderContent(): React.JSX.Element {
    if (overlay === "visibility") {
      return renderVisibility();
    }
    if (overlay === "details") {
      return renderDetails();
    }
    if (overlay === "account") {
      return renderAccountModal();
    }
    switch (tab) {
      case "auth":
        return (
          <AuthRoute
            controller={controller}
            snapshot={snapshot}
            clockNow={runtime.clock.now}
            onBack={() => {
              switchTab("accounts");
            }}
            onQuit={exitApp}
            viewport={viewport}
          />
        );
      case "settings":
        return (
          <SettingsRoute
            settings={settings}
            onChange={saveSettings}
            onBack={() => {
              switchTab("accounts");
            }}
            onQuit={exitApp}
            saveError={settingsError}
            viewport={viewport}
          />
        );
      case "help":
        return <HelpRoute viewport={viewport} />;
      default:
        return renderDashboard();
    }
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <TabBar tab={tab} busy={snapshot.busy} />
      <Box flexDirection="column" flexGrow={1}>
        {renderContent()}
      </Box>
    </Box>
  );
}
