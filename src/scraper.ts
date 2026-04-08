import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";

export interface DeepSourceData {
  title: string;
  /** Present when the source is a web link; absent for uploaded documents. */
  url?: string;
  /** Full body text extracted from the source detail panel. */
  bodyText: string;
}

export interface RawPageContent {
  url: string;
  title: string;
  textContent: string;
  timestamp: string;
  pageDump?: string;
  /** Populated when deep source click-through extraction succeeds. */
  deepSources?: DeepSourceData[];
}

/**
 * Candidate element selectors for items in the NotebookLM sources list panel.
 * Tried in order; first one that matches wins.
 * Based on observed Angular DOM: custom element "source-chip" is the host,
 * with an inner title container rendered by Angular.
 */
const SOURCE_CHIP_SELECTORS = [
  ".single-source-container",
  "[class*='single-source-container']",
  "mat-list-item[role='listitem']",
  "[class*='source-list-item']",
  "[class*='source-chip']",
];

/**
 * Selectors to open/activate the Sources side-panel if it is collapsed.
 */
const SOURCES_PANEL_BUTTON_SELECTORS = [
  "button[aria-label='Sources']",
  "button[aria-label='sources']",
  "[data-tab='sources']",
  "[class*='sources-tab']",
  "button[jsname][aria-controls*='source']",
];

/**
 * Selectors for the back-navigation control that returns from a source detail
 * view to the source list.
 */
const BACK_BUTTON_SELECTORS = [
  "button[aria-label='Back']",
  "button[aria-label='back']",
  "button[aria-label*='Back']",
  "button[aria-label*='back']",
  "span.panel-header-clickable",
  "[class*='back-button']",
  ".back-btn",
];

/** Maximum HTML snapshots to save per scrape session. */
const MAX_SAMPLES_PER_SESSION = 3;


/** Project root: two levels up from dist/scraper.js (or src/scraper.ts). */
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), "..");

/** Directory where HTML snapshots are written. */
const SAMPLES_DIR = path.join(PROJECT_ROOT, "samples");

const MIN_TEXT_CONTENT_CHARS = 200;
const SHELL_MARKERS = [
  "sign in",
  "welcome to notebooklm",
  "create new notebook",
  "new notebook",
  "your notebooks",
  "recent notebooks",
  "upgrade",
];

interface PageSnapshot {
  bodyText: string;
  mainText: string;
  headings: string[];
  ariaLabels: string[];
  buttonLabels: string[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isGoogleSignInUrl(url: string): boolean {
  return url.includes("accounts.google.com") || url.includes("signin");
}

export function looksLikeNotebookShell(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) return true;

  const markerMatches = SHELL_MARKERS.filter((marker) => normalized.includes(marker)).length;
  const hasNotebookContentHints =
    normalized.includes("source") ||
    normalized.includes("sources") ||
    normalized.includes("note") ||
    normalized.includes("timeline") ||
    normalized.includes("faq");

  return markerMatches >= 2 || (markerMatches >= 1 && !hasNotebookContentHints);
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let iterations = 0;
      const maxIterations = 8;
      const distance = Math.max(window.innerHeight, 600);

      const timer = window.setInterval(() => {
        window.scrollBy(0, distance);
        iterations += 1;

        const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight;
        if (atBottom || iterations >= maxIterations) {
          window.clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 250);
    });
  });
}

async function collectPageSnapshot(page: Page): Promise<PageSnapshot> {
  return page.evaluate(() => {
    const collectText = (selectors: string[]): string => {
      const chunks = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .map((element) => (element as HTMLElement).innerText || element.textContent || "")
        .filter(Boolean);

      return chunks.join("\n\n");
    };

    const collectAttr = (selector: string, attribute: string, limit: number): string[] =>
      Array.from(document.querySelectorAll(selector))
        .map((element) => element.getAttribute(attribute) || "")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, limit);

    const collectElementText = (selector: string, limit: number): string[] =>
      Array.from(document.querySelectorAll(selector))
        .map((element) => (element as HTMLElement).innerText || element.textContent || "")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, limit);

    return {
      bodyText: document.body?.innerText || document.body?.textContent || "",
      mainText: collectText(["main", "[role='main']", "article", "section"]),
      headings: collectElementText("h1, h2, h3, [role='heading']", 40),
      ariaLabels: collectAttr("[aria-label]", "aria-label", 80),
      buttonLabels: collectElementText("button", 50),
    };
  });
}

function buildTextContent(snapshot: PageSnapshot): string {
  return uniqueNonEmpty([
    snapshot.mainText,
    snapshot.bodyText,
    ...snapshot.headings,
    ...snapshot.buttonLabels,
  ]).join("\n\n");
}

function buildPageDump(snapshot: PageSnapshot): string {
  const sections = [
    ["MAIN_TEXT", snapshot.mainText],
    ["BODY_TEXT", snapshot.bodyText],
    ["HEADINGS", snapshot.headings.join("\n")],
    ["ARIA_LABELS", snapshot.ariaLabels.join("\n")],
    ["BUTTON_LABELS", snapshot.buttonLabels.join("\n")],
  ] as const;

  return sections
    .map(([label, value]) => `=== ${label} ===\n${normalizeWhitespace(value)}`)
    .join("\n\n")
    .slice(0, 60_000);
}

async function extractNotebookSnapshot(page: Page): Promise<{ textContent: string; pageDump: string }> {
  let snapshot = await collectPageSnapshot(page);
  let textContent = buildTextContent(snapshot);

  if (textContent.length < MIN_TEXT_CONTENT_CHARS || looksLikeNotebookShell(textContent)) {
    console.log("Initial NotebookLM scrape looked thin. Waiting and retrying...");
    await page.waitForTimeout(5000);
    await autoScroll(page);
    snapshot = await collectPageSnapshot(page);
    textContent = buildTextContent(snapshot);
  }

  return {
    textContent: textContent.trim(),
    pageDump: buildPageDump(snapshot),
  };
}



/**
 * Write one HTML snapshot to samples/. Non-fatal on any error.
 * `label` is a human tag embedded in the filename (e.g. "panel" or "source-3").
 */
async function writeHtmlSample(html: string, label: string): Promise<void> {
  try {
    await fs.mkdir(SAMPLES_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = path.join(SAMPLES_DIR, `sample-${ts}-${label}.html`);
    await fs.writeFile(filename, html, "utf8");
    console.log(`  HTML sample saved: ${path.basename(filename)}`);
  } catch {
    // Non-fatal; sampling is diagnostic only.
  }
}

/**
 * Save a snapshot of the source detail panel (post-click) to samples/.
 * Capped at MAX_SAMPLES_PER_SESSION per scrape run.
 */
async function maybeWriteHtmlSample(
  page: Page,
  sourceIndex: number,
  sessionCount: number
): Promise<void> {
  if (sessionCount >= MAX_SAMPLES_PER_SESSION) return;

  // Capture full body HTML (up to 120K) AFTER hydration so we get real content.
  // Previous approach targeted div.scroll-container which was empty pre-hydration.
  const html = await page.evaluate((): string => {
    return document.body.innerHTML.slice(0, 120_000);
  });

  await writeHtmlSample(html, `source-${sourceIndex + 1}`);
}

/**
 * Dump the full page body HTML to samples/ so we can inspect the sources
 * panel DOM even when zero chips are found.  Always writes exactly one file.
 */
async function dumpPanelSample(page: Page): Promise<void> {
  const html = await page.evaluate((): string => {
    return document.body.innerHTML.slice(0, 120_000);
  });
  await writeHtmlSample(html, "panel-prescrape");
}

/**
 * Ensure the Sources side-panel is open so source chips are accessible.
 */
async function ensureSourcesPanelOpen(page: Page): Promise<void> {
  // If any chip selector already matches, the panel is already open.
  for (const sel of SOURCE_CHIP_SELECTORS) {
    const count = await page.locator(sel).count();
    if (count > 0) return;
  }

  for (const sel of SOURCES_PANEL_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(1200);
        return;
      }
    } catch {
      // continue to next selector
    }
  }
}

/**
 * Extract structured data from the currently-open source detail panel.
 *
 * DOM structure (observed from example-content.txt):
 *   div.scroll-container
 *     div.scroll-area
 *       div.elements-container
 *         labs-tailwind-structural-element-view-v2  (one per paragraph / heading)
 *           div[data-start-index]
 *             span[data-start-index]   ← text lives here
 *
 * Title container (from user-observed HTML):
 *   div.source-title-container
 *     div.source-title[title="<full title>"]
 *
 * URL (link sources only):
 *   a.source-title-link[href]
 */
async function extractOpenSourceDetail(
  page: Page,
  listViewUrl?: string
): Promise<DeepSourceData> {
  // Wait for Angular content to hydrate — prefer span[data-start-index]
  // which is the definitive signal that body text has rendered.
  await page.waitForSelector(
    "span[data-start-index], div.source-title, .source-title-container",
    { timeout: 12000 }
  );
  await page.waitForTimeout(800);

  const scraped = await page.evaluate((): DeepSourceData => {
    // --- URL ---
    // Try multiple selectors in the detail view
    const linkEl =
      document.querySelector("a.source-title-link") ||
      document.querySelector("a[class*='source-title']") ||
      document.querySelector(".source-title-container a[href]");
    const url = linkEl?.getAttribute("href") ?? undefined;

    // --- Title ---
    // Prefer the title attribute on the div.source-title element (full, untruncated text).
    const titleEl = document.querySelector<HTMLElement>(
      "div.source-title[title], .source-title-container div[title]"
    );
    const title = (
      titleEl?.getAttribute("title") ||
      titleEl?.innerText?.trim() ||
      document.querySelector<HTMLElement>(".source-title")?.innerText?.trim() ||
      "Unknown Source"
    ).trim();

    // --- Body text ---
    // Collect all span[data-start-index] AND a[data-start-index] elements,
    // deduplicate, sort by index, then join their text.
    // For <a> elements, emit markdown links to preserve the href URL.
    // This faithfully reconstructs the document order and avoids duplicates
    // from nested Angular host/content projection.
    const contentEls = Array.from(
      document.querySelectorAll<HTMLElement>(
        "span[data-start-index], a[data-start-index]"
      )
    );

    contentEls.sort((a, b) => {
      const ai = parseInt(a.getAttribute("data-start-index") ?? "0", 10);
      const bi = parseInt(b.getAttribute("data-start-index") ?? "0", 10);
      return ai - bi;
    });

    /** Unwrap Google redirect URLs → real destination. */
    const unwrapGoogleUrl = (raw: string): string => {
      try {
        const u = new URL(raw);
        if (u.hostname.includes("google.com") && u.pathname === "/url") {
          const real = u.searchParams.get("q") || u.searchParams.get("url");
          if (real) return real;
        }
      } catch { /* not a valid URL, return as-is */ }
      return raw;
    };

    const seen = new Set<string>();
    const parts: string[] = [];
    for (const el of contentEls) {
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || "").trim();
      if (!text || seen.has(text)) continue;

      if (tag === "a") {
        const href = el.getAttribute("href");
        if (href) {
          const cleanUrl = unwrapGoogleUrl(href);
          // Use markdown link: [visible text](real url)
          const md = `[${text}](${cleanUrl})`;
          seen.add(text);
          parts.push(md);
          continue;
        }
      }

      seen.add(text);
      parts.push(text);
    }

    const bodyText = parts.join("\n\n");

    return { title, url, bodyText };
  });

  // Fallback: use the URL extracted from the list-view favicon if the detail
  // view didn't have a link element.
  if (!scraped.url && listViewUrl) {
    scraped.url = listViewUrl;
  }

  return scraped;
}

/**
 * Navigate back from a source detail view to the source list panel.
 * Tries multiple selectors; falls back to keyboard Escape if none match.
 */
async function navigateBackToSourceList(page: Page): Promise<void> {
  for (const sel of BACK_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(800);
        return;
      }
    } catch {
      // try next
    }
  }

  // Last resort: Escape key (collapses many Angular detail panels)
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
  } catch {
    // Best-effort
  }
}

/**
 * Iterate over every source chip in the sources list panel.
 * For each: click → wait for detail view → extract title/url/body → click back.
 * Saves up to MAX_SAMPLES_PER_SESSION raw HTML snapshots to samples/ per run.
 * Returns an empty array and logs a warning if source items cannot be located.
 */
async function scrapeDeepSources(page: Page): Promise<DeepSourceData[]> {
  const results: DeepSourceData[] = [];
  let htmlSampleCount = 0;

  // Make sure the Sources panel is open before probing for chips.
  await ensureSourcesPanelOpen(page);

  // Always dump the sources-panel DOM so we have diagnostic data
  // even when chip selectors miss entirely.
  await dumpPanelSample(page);

  // Probe each candidate selector; use the first one that matches
  let workingSelector = "";
  let sourceCount = 0;

  for (const sel of SOURCE_CHIP_SELECTORS) {
    const count = await page.locator(sel).count();
    if (count > 0) {
      workingSelector = sel;
      sourceCount = count;
      break;
    }
  }

  if (sourceCount === 0) {
    console.log(
      "  Deep scrape: no source list items found. Skipping click-through extraction."
    );
    console.log(
      "  (Check samples/sample-*-panel-prescrape.html for actual DOM structure)"
    );
    return results;
  }

  console.log(
    `  Deep scrape: found ${sourceCount} source(s) [selector: ${workingSelector}]`
  );

  for (let i = 0; i < sourceCount; i++) {
    const label = `source ${i + 1}/${sourceCount}`;
    try {
      // Re-locate each iteration — the DOM may shift after navigation
      const item = page.locator(workingSelector).nth(i);

      if (!(await item.isVisible({ timeout: 3000 }))) {
        console.log(`  Deep scrape: ${label} not visible — skipping`);
        continue;
      }

      // Extract the source URL from the favicon on the LIST view before clicking.
      // Favicon src looks like: https://www.google.com/s2/favicons?domain=<REAL_URL>&sz=32
      const listUrl = await item.evaluate((el: Element): string | undefined => {
        const fav = el.querySelector<HTMLImageElement>("img.favicon-icon");
        if (!fav?.src) return undefined;
        const match = fav.src.match(/[?&]domain=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : undefined;
      });

      console.log(`  Deep scrape: opening ${label}...`);
      await item.click();

      const data = await extractOpenSourceDetail(page, listUrl);

      // Save HTML snapshot AFTER hydration so the sample contains real content
      await maybeWriteHtmlSample(page, i, htmlSampleCount);
      htmlSampleCount++;

      results.push(data);

      const urlNote = data.url
        ? `url=${data.url.slice(0, 70)}`
        : "(uploaded document — no url)";
      console.log(
        `    -> "${data.title.slice(0, 60)}" | ${urlNote} | ${data.bodyText.length} chars body`
      );

      await navigateBackToSourceList(page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `  Deep scrape: error on ${label}: ${msg.slice(0, 120)}`
      );
      // Try to return to the list so the next iteration can proceed
      await navigateBackToSourceList(page).catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  return results;
}

/**
 * Navigate to a NotebookLM URL and extract the full page text content.
 * No DOM selector logic -- we dump everything and let the LLM parse it.
 */
export async function scrapeNotebookPage(
  context: BrowserContext,
  notebookUrl: string
): Promise<RawPageContent> {
  const page = await context.newPage();

  console.log(`Navigating to ${notebookUrl}...`);
  await page.goto(notebookUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  if (isGoogleSignInUrl(page.url())) {
    await page.close();
    throw new Error(
      "NotebookLM redirected to Google sign-in. Re-run after authenticating, or refresh the saved session."
    );
  }

  await page.waitForSelector("body", { timeout: 10000 });
  await page.waitForTimeout(2500);
  await autoScroll(page);

  const title = await page.title();
  const { textContent, pageDump } = await extractNotebookSnapshot(page);

  // Deep scrape: click through each source to get full body text and URLs
  console.log("Phase 1b: Deep-scraping individual sources...");
  const deepSources = await scrapeDeepSources(page);

  await page.close();

  if (!textContent) {
    throw new Error(
      "Scrape completed but no NotebookLM text was captured. The page may not have finished rendering or the notebook content may not be accessible."
    );
  }

  if (deepSources.length > 0) {
    console.log(
      `  Deep scrape complete: ${deepSources.length} source(s) captured locally.`
    );
  } else {
    console.log("  Deep scrape: no additional source content captured.");
  }

  return {
    url: notebookUrl,
    title,
    textContent,
    timestamp: new Date().toISOString(),
    pageDump,
    deepSources: deepSources.length > 0 ? deepSources : undefined,
  };
}
