import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getAuthenticatedContext, closeContext } from "./auth.js";
import { scrapeNotebookPage } from "./scraper.js";
import { assertProviderCredentials, createProvider, type TokenUsage } from "./llm/providers.js";
import { extractContent, enrichExtraction } from "./llm/extract.js";
import {
  buildExtractionLocally,
  buildEnrichmentDigest,
  mergeEnrichment,
} from "./llm/local-extract.js";
import { buildNotebook } from "./notebook.js";
import {
  loadRegistry,
  saveRegistry,
  type GarrisonConfig,
} from "./config.js";

export async function updateCommand(
  name: string,
  config: GarrisonConfig
): Promise<void> {
  console.log(`garrison update "${name}"\n`);

  const registry = await loadRegistry(config);
  const entry = registry.notebooks[name];

  if (!entry) {
    const available = Object.keys(registry.notebooks);
    throw new Error(
      available.length > 0
        ? `"${name}" not found in registry. Available notebooks: ${available.join(", ")}`
        : `"${name}" not found in registry. No notebooks are currently registered.`
    );
  }

  assertProviderCredentials(config, "Notebook update");

  console.log(`Source: ${entry.link}`);
  console.log(`Last updated: ${entry.updatedAt}\n`);

  // Scrape fresh content
  console.log("Scraping current NotebookLM content...");
  const { context, googleAccount } = await getAuthenticatedContext(config, entry.link);
  let raw;
  try {
    raw = await scrapeNotebookPage(context, entry.link);
  } finally {
    await closeContext(context);
  }

  // Check if content has changed
  const manifestPath = join(config.garrisonDir, "notebooks", name, "manifest.json");
  if (existsSync(manifestPath)) {
    const oldManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    const oldSourceCount = oldManifest.sourceCount || 0;
    console.log(`Previous source count: ${oldSourceCount}`);
  }

  const hasDeepSources = (raw.deepSources?.length ?? 0) > 0;
  let extraction;

  let usage: TokenUsage | undefined;

  if (hasDeepSources) {
    // LOCAL-FIRST: build extraction directly from scraped data
    console.log("Building extraction locally from scraped data...");
    extraction = buildExtractionLocally(raw.title, raw.deepSources!);
    console.log(`  ${extraction.sources.length} source(s) assembled locally.`);

    console.log("Enriching via LLM (metadata only)...");
    const provider = createProvider(config);
    const digest = buildEnrichmentDigest(extraction.sources);
    const enrichResult = await enrichExtraction(provider, digest, extraction.notebookTitle, entry.link);
    mergeEnrichment(extraction, enrichResult.enrichment);
    usage = enrichResult.usage;
    console.log(`  Enrichment complete: ${extraction.notes.length} note(s).`);
  } else {
    // LEGACY: send full text to LLM
    console.log("Extracting structured content via LLM (legacy path)...");
    const provider = createProvider(config);
    const result = await extractContent(provider, raw);
    extraction = result.extraction;
    usage = result.usage;
  }

  console.log(
    `Extracted: ${extraction.sources.length} sources, ${extraction.notes.length} notes`
  );

  // Rebuild notebook (overwrites previous)
  console.log("Rebuilding Jupyter notebook...");
  const notebooksDir = join(config.garrisonDir, "notebooks");
  const notebookPath = await buildNotebook(
    extraction,
    notebooksDir,
    name,
    entry.link
  );

  // Update registry — accumulate token usage
  entry.updatedAt = new Date().toISOString();
  entry.sourceCount = extraction.sources.length;
  entry.noteCount = extraction.notes.length;
  if (googleAccount) entry.googleAccount = googleAccount;
  if (usage) {
    entry.totalInputTokens = (entry.totalInputTokens ?? 0) + usage.inputTokens;
    entry.totalOutputTokens = (entry.totalOutputTokens ?? 0) + usage.outputTokens;
  }
  await saveRegistry(config, registry);

  console.log(`\nUpdated. Notebook at: ${notebookPath}`);
  console.log(`Sources: ${extraction.sources.length} | Notes: ${extraction.notes.length}`);
  if (usage) {
    console.log(`Tokens used: ${usage.inputTokens.toLocaleString()} input, ${usage.outputTokens.toLocaleString()} output`);
  }
}
