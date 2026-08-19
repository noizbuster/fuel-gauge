/**
 * Deterministic configuration-path resolution.
 *
 * `FUEL_GAUGE_CONFIG_DIR` wins over every platform default when set to a
 * non-empty value; an empty or whitespace-only override is ignored.
 * Platform bases follow the reference layout:
 *
 * - Linux (and every non-Windows, non-macOS platform): `$XDG_CONFIG_HOME`
 *   or `~/.config`, then `fuel-gauge`.
 * - macOS: `~/Library/Application Support/fuel-gauge`.
 * - Windows: `%APPDATA%\fuel-gauge` or
 *   `%USERPROFILE%\AppData\Roaming\fuel-gauge`.
 *
 * An unavailable base (empty home and empty platform env) resolves to the
 * typed `HomeUnavailable` failure instead of throwing. Separators follow
 * the injected platform (`\` on win32, `/` elsewhere) so tests are
 * deterministic on any host.
 */

import { homedir } from "node:os";
import path from "node:path";
import type { ProviderId } from "./types.js";

export const CONFIG_DIR_ENV_VAR = "FUEL_GAUGE_CONFIG_DIR";
export const APP_DIR_NAME = "fuel-gauge";
export const PROVIDERS_DIR_NAME = "providers";
export const SETTINGS_FILE_NAME = "settings.json";
export const USER_ADDED_FILE_NAME = "user-added.json";

/** Everything path resolution needs; every input is injectable for tests. */
export interface PathContext {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  home: string | null;
}

/** How the resolved root was determined. */
export type ConfigRootOrigin = "override" | "platform";

export type ConfigRootResolution =
  | { ok: true; root: string; origin: ConfigRootOrigin }
  | { ok: false; reason: "HomeUnavailable"; message: string };

export interface StoragePaths {
  /** Private configuration root (already includes the app directory). */
  root: string;
  /** `<root>/settings.json`. */
  settingsFile: string;
  /** `<root>/providers`. */
  providersDir: string;
  /** `<root>/providers/<provider>.json`. */
  providerFile(provider: ProviderId): string;
}

export type StoragePathsResolution =
  | ({ ok: true; origin: ConfigRootOrigin } & StoragePaths)
  | { ok: false; reason: "HomeUnavailable"; message: string };

/** Production context built from real process state. */
export function defaultPathContext(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string | null = homedir() || null,
): PathContext {
  return { env, platform, home };
}

function joinerFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function nonEmpty(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves the private config root. The `FUEL_GAUGE_CONFIG_DIR` override
 * is used verbatim (trimmed); platform bases are joined with the app
 * directory. Empty home/base yields `{ ok: false, reason: "HomeUnavailable" }`.
 */
export function resolveConfigRoot(ctx: PathContext): ConfigRootResolution {
  const join = joinerFor(ctx.platform);

  const override = nonEmpty(ctx.env[CONFIG_DIR_ENV_VAR]);
  if (override) {
    return { ok: true, root: override, origin: "override" };
  }

  if (ctx.platform === "win32") {
    const appData = nonEmpty(ctx.env.APPDATA);
    if (appData) {
      return {
        ok: true,
        root: join.join(appData, APP_DIR_NAME),
        origin: "platform",
      };
    }
    const home = nonEmpty(ctx.home);
    if (home) {
      return {
        ok: true,
        root: join.join(home, "AppData", "Roaming", APP_DIR_NAME),
        origin: "platform",
      };
    }
    return {
      ok: false,
      reason: "HomeUnavailable",
      message:
        "Could not resolve a Windows configuration base: APPDATA and the user home directory are both unavailable.",
    };
  }

  if (ctx.platform === "darwin") {
    const home = nonEmpty(ctx.home);
    if (home) {
      return {
        ok: true,
        root: join.join(home, "Library", "Application Support", APP_DIR_NAME),
        origin: "platform",
      };
    }
    return {
      ok: false,
      reason: "HomeUnavailable",
      message:
        "Could not resolve the macOS configuration base: the user home directory is unavailable.",
    };
  }

  // Linux and every other platform follow XDG.
  const xdg = nonEmpty(ctx.env.XDG_CONFIG_HOME);
  if (xdg) {
    return { ok: true, root: join.join(xdg, APP_DIR_NAME), origin: "platform" };
  }
  const home = nonEmpty(ctx.home);
  if (home) {
    return {
      ok: true,
      root: join.join(home, ".config", APP_DIR_NAME),
      origin: "platform",
    };
  }
  return {
    ok: false,
    reason: "HomeUnavailable",
    message:
      "Could not resolve the XDG configuration base: XDG_CONFIG_HOME and the user home directory are both unavailable.",
  };
}

/** Resolves the config root plus every store file path derived from it. */
export function resolveStoragePaths(ctx: PathContext): StoragePathsResolution {
  const resolved = resolveConfigRoot(ctx);
  if (!resolved.ok) {
    return resolved;
  }
  const join = joinerFor(ctx.platform);
  const providersDir = join.join(resolved.root, PROVIDERS_DIR_NAME);
  return {
    ok: true,
    root: resolved.root,
    origin: resolved.origin,
    settingsFile: join.join(resolved.root, SETTINGS_FILE_NAME),
    providersDir,
    providerFile: (provider: ProviderId): string =>
      join.join(providersDir, `${provider}.json`),
  };
}
