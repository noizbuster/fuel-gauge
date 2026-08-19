import open from "open";

/**
 * Result of asking the operating system to open a URL in the user's browser.
 *
 * The original URL is always echoed back so callers (auth screens) can render a
 * manual fallback link even when no browser could be launched. Launch failures
 * are reported through `launched: false` plus a short, token-free reason; the
 * port itself never throws.
 */
export interface BrowserLaunchResult {
  /** The exact URL that was passed to `open`, always preserved verbatim. */
  readonly url: string;
  /** Whether a browser launch was successfully handed off to the OS. */
  readonly launched: boolean;
  /** Short, redacted reason when `launched` is false. */
  readonly error?: string;
}

/**
 * Injectable boundary around "open this URL in the user's browser".
 *
 * Production default uses `open@11`; tests inject a fake to avoid touching the
 * user's desktop. Implementations must never throw and must always return the
 * original URL so a failed launch is recoverable by rendering the link.
 */
export interface BrowserPort {
  open(url: string): Promise<BrowserLaunchResult>;
}

/** Signature of `open@11` — injectable so failure paths are testable. */
export type UrlOpener = (url: string) => Promise<unknown>;

/**
 * Production browser port backed by `open@11.0.1`. The opener is injectable
 * so tests can exercise launch failures without touching the desktop.
 */
export function createBrowserPort(opener: UrlOpener = open): BrowserPort {
  return {
    async open(url: string): Promise<BrowserLaunchResult> {
      if (typeof url !== "string" || url.trim() === "") {
        return { url, launched: false, error: "No URL to open." };
      }
      try {
        await opener(url);
        return { url, launched: true };
      } catch {
        // open() failures can embed the URL (which carries OAuth tokens in
        // auth flows) and environment detail. The reason is therefore a
        // constant, token-free string; the URL itself survives only in
        // `result.url` for the UI's manual fallback link.
        return {
          url,
          launched: false,
          error: "Browser could not be launched.",
        };
      }
    },
  };
}
