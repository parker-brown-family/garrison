import { chromium, type BrowserContext } from "playwright";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { GarrisonConfig } from "./config.js";

const STORAGE_FILE = "google-auth-state.json";

/** Returned by getAuthenticatedContext so callers can store the account. */
export interface AuthResult {
  context: BrowserContext;
  googleAccount?: string;
}

function isNotebookLmUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "notebooklm.google.com";
  } catch {
    return false;
  }
}

function isGoogleSignInUrl(url: string): boolean {
  return url.includes("accounts.google.com") || url.includes("signin");
}

/**
 * Detect NotebookLM's "Access Request" interstitial.
 * When a notebook is unreachable (wrong account, no share, etc.) the URL
 * stays on notebooklm.google.com but the page title and body say
 * "Access Request" / "You need access" / "Request access".
 * Returns true if the page looks like an access-denied gate.
 */
/**
 * Try to extract the logged-in Google email from the page.
 * Google's account-switcher button typically has an aria-label like:
 *   "Google Account: John Doe (john@gmail.com)"
 * Falls back to undefined if not found.
 */
async function extractGoogleEmail(page: import("playwright").Page): Promise<string | undefined> {
  try {
    const email: string | null = await page.evaluate(() => {
      // Primary: aria-label on the account button
      const btn = document.querySelector('a[aria-label*="Google Account"]');
      if (btn) {
        const match = btn.getAttribute("aria-label")?.match(/\(([^)]+@[^)]+)\)/);
        if (match) return match[1];
      }
      // Fallback: any element whose aria-label contains an email-like string
      const all = document.querySelectorAll("[aria-label]");
      for (const el of all) {
        const label = el.getAttribute("aria-label") || "";
        const m = label.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
        if (m) return m[0];
      }
      return null;
    });
    return email ?? undefined;
  } catch {
    return undefined;
  }
}

async function isAccessRequestPage(page: import("playwright").Page): Promise<boolean> {
  const title = (await page.title()).toLowerCase();
  if (title.includes("access request")) return true;

  // Cheap body-text check: grab innerText of body (capped) and look for
  // distinctive phrases that appear on the access-denied page.
  const bodySnippet: string = await page.evaluate(() =>
    (document.body?.innerText || "").slice(0, 1000).toLowerCase()
  );
  const ACCESS_MARKERS = ["you need access", "request access", "ask for access"];
  return ACCESS_MARKERS.some((m) => bodySnippet.includes(m));
}

/**
 * Get an authenticated browser context for Google services.
 * First run: opens visible browser for manual Google login.
 * Subsequent runs: reuses saved session state.
 *
 * Pass `targetUrl` (the actual notebook URL) so the pre-flight check
 * validates access to that specific notebook — not just the root page.
 * This catches expired sessions AND notebooks the current account cannot
 * access, triggering the login window before any scrape work begins.
 */
export async function getAuthenticatedContext(
  config: GarrisonConfig,
  targetUrl?: string
): Promise<AuthResult> {
  const storagePath = join(config.authDir, STORAGE_FILE);
  const hasSession = existsSync(storagePath);

  // Pre-flight against the target notebook URL when available; otherwise fall
  // back to the root. This means a wrong-account or access-denied redirect on
  // a specific notebook is caught here rather than mid-scrape.
  const checkUrl = targetUrl ?? "https://notebooklm.google.com";

  if (hasSession) {
    // Attempt to reuse saved session
    const browser = await chromium.launch({ headless: true, channel: "chrome" });
    const context = await browser.newContext({ storageState: storagePath });
    const page = await context.newPage();

    // domcontentloaded is fast; networkidle hangs forever on NotebookLM's
    // persistent connections.  After the initial load we poll for the page
    // title to stabilise — Angular hydrates the "Access Request" title
    // within a few seconds if the session lacks access.
    await page.goto(checkUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Poll until the title stops being empty / generic, up to 8 s.
    const TITLE_POLL_MS = 500;
    const TITLE_DEADLINE = Date.now() + 8000;
    while (Date.now() < TITLE_DEADLINE) {
      const t = await page.title();
      // Once Angular sets a real title we can inspect the page.
      if (t && t !== "NotebookLM") break;
      await page.waitForTimeout(TITLE_POLL_MS);
    }

    // Detect two failure modes:
    // 1. Google sign-in redirect (session expired / no cookies)
    // 2. NotebookLM "Access Request" page (wrong account / not shared)
    const landedUrl = page.url();
    const signInRedirect = isGoogleSignInUrl(landedUrl);
    const accessDenied = !signInRedirect && await isAccessRequestPage(page);

    if (signInRedirect || accessDenied) {
      const reason = accessDenied
        ? "Notebook requires access your current session doesn't have."
        : targetUrl
          ? "Session cannot access this notebook."
          : "Session expired.";
      console.log(reason);
      await page.close();
      await context.close();
      await browser.close();
      return await interactiveReauth(config, storagePath, targetUrl);
    }

    // Grab the email before closing the pre-flight page
    const googleAccount = await extractGoogleEmail(page);
    await page.close();
    return { context, googleAccount };
  }

  return await freshLogin(config, storagePath, targetUrl);
}

/**
 * Opens a visible browser window for the user to log into Google manually.
 * Waits for successful navigation to NotebookLM, then saves session state.
 *
 * When `targetUrl` is provided the browser opens directly to that notebook so
 * the user can switch accounts or approve access for the specific resource.
 */
async function freshLogin(
  config: GarrisonConfig,
  storagePath: string,
  targetUrl?: string
): Promise<AuthResult> {
  const destination = targetUrl ?? "https://notebooklm.google.com";

  console.log("");
  console.log("=== GOOGLE AUTHENTICATION REQUIRED ===");
  console.log("A browser window will open.");
  if (targetUrl) {
    console.log("You may need to switch Google accounts or request access for this notebook.");
  } else {
    console.log("Log into your Google account that has access to NotebookLM.");
  }
  console.log("Once logged in, garrison will detect it automatically.");
  console.log("The browser will close on its own — no need to keep it open.");
  console.log("");

  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(destination, {
    waitUntil: "domcontentloaded",
  });

  // Wait until the user has resolved auth/access and lands on a valid
  // NotebookLM page that is NOT a sign-in redirect or access-request gate.
  console.log("Waiting for login / access to complete...");

  // Poll-based: page.waitForURL only checks the URL, but we also need to
  // detect the Access Request interstitial which stays on the same domain.
  const POLL_INTERVAL_MS = 1500;
  const TIMEOUT_MS = 120_000; // 2 minutes
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (isNotebookLmUrl(currentUrl) && !isGoogleSignInUrl(currentUrl)) {
      // URL looks right — but is the page still an access-request gate?
      if (!(await isAccessRequestPage(page))) {
        break; // genuinely authenticated and authorised
      }
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  if (Date.now() >= deadline) {
    await page.close();
    await context.close();
    await browser.close();
    throw new Error("Authentication timed out after 2 minutes.");
  }

  console.log("Login detected. Saving session...");
  const googleAccount = await extractGoogleEmail(page);
  await context.storageState({ path: storagePath });
  await page.close();

  console.log("Keep this browser window open — garrison is scraping content.");
  console.log("It will close automatically when finished.\n");
  return { context, googleAccount };
}

/**
 * Interactive re-authentication flow.
 *
 * Opens a visible browser window pointed at `targetUrl` (or the root) so the
 * user can switch Google accounts, approve access, or log in fresh.  The CLI
 * then prompts in the terminal for confirmation and retries the access check.
 *
 * Up to MAX_RETRY attempts.  On each failure after the user says "yes" we
 * print a clear message: wrong account / still no access — try again.
 */
const MAX_AUTH_RETRIES = 3;

async function interactiveReauth(
  config: GarrisonConfig,
  storagePath: string,
  targetUrl?: string
): Promise<AuthResult> {
  const destination = targetUrl ?? "https://notebooklm.google.com";

  console.log("");
  console.log("=== ACCESS RESOLUTION REQUIRED ===");
  console.log("A browser window will open to the notebook.");
  console.log("Switch to the correct Google account or approve access.");
  console.log("Then return here and type 'yes' to confirm.");
  console.log("The browser will close on its own after confirmation.");
  console.log("");

  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(destination, { waitUntil: "domcontentloaded" });

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
      const answer = await rl.question(
        "Confirm 'yes' when you have allowed the correct access: "
      );

      if (answer.trim().toLowerCase() !== "yes") {
        console.log("Aborted by user.");
        await page.close();
        await context.close();
        await browser.close();
        throw new Error("Authentication aborted by user.");
      }

      // Give the page a moment to settle after the user's action
      await page.waitForTimeout(3000);

      // Re-navigate to force a fresh load with the (possibly new) session
      await page.goto(destination, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      // Wait for Angular to hydrate the title
      const retryDeadline = Date.now() + 8000;
      while (Date.now() < retryDeadline) {
        const t = await page.title();
        if (t && t !== "NotebookLM") break;
        await page.waitForTimeout(500);
      }

      const currentUrl = page.url();
      const stillSignIn = isGoogleSignInUrl(currentUrl);
      const stillAccessDenied = !stillSignIn && await isAccessRequestPage(page);

      if (!stillSignIn && !stillAccessDenied) {
        // Success — save session and return
        console.log("Access confirmed. Saving session...");
        const googleAccount = await extractGoogleEmail(page);
        await context.storageState({ path: storagePath });
        await page.close();

        console.log("Keep this browser window open — garrison is scraping content.");
        console.log("It will close automatically when finished.\n");
        return { context, googleAccount };
      }

      if (attempt < MAX_AUTH_RETRIES) {
        console.log(
          `Still cannot access this notebook (attempt ${attempt}/${MAX_AUTH_RETRIES}).`
        );
        console.log(
          "Wrong account? Switch accounts in the browser window and try again."
        );
      }
    }
  } finally {
    rl.close();
  }

  // Exhausted retries
  await page.close();
  await context.close();
  await browser.close();
  throw new Error(
    `Could not gain access after ${MAX_AUTH_RETRIES} attempts. ` +
    "Verify you are using the correct Google account and have access to this notebook."
  );
}

/**
 * Close the browser associated with a context.
 */
export async function closeContext(context: BrowserContext): Promise<void> {
  const browser = context.browser();
  await context.close();
  if (browser) await browser.close();
}
