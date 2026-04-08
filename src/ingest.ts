import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
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

export async function newCommand(
  name: string,
  link: string,
  config: GarrisonConfig
): Promise<void> {
  console.log(`garrison new "${name}" from ${link}\n`);

  // Check if name already exists
  const registry = await loadRegistry(config);
  if (registry.notebooks[name]) {
    throw new Error(
      `"${name}" already exists in registry. Use "garrison update ${name}" instead.`
    );
  }

  assertProviderCredentials(config, "Notebook ingestion");

  // Phase 1: Scrape
  console.log("Phase 1: Scraping NotebookLM content...");
  const { context, googleAccount } = await getAuthenticatedContext(config, link);
  let raw;
  try {
    raw = await scrapeNotebookPage(context, link);
  } finally {
    await closeContext(context);
  }

  const hasDeepSources = (raw.deepSources?.length ?? 0) > 0;

  // Phase 2: Assess and confirm
  if (hasDeepSources) {
    // LOCAL-FIRST path: full content already captured, LLM only for enrichment
    const totalBodyChars = raw.deepSources!.reduce((sum, s) => sum + s.bodyText.length, 0);
    const enrichDigest = buildEnrichmentDigest(
      raw.deepSources!.map((ds) => ({
        title: ds.title,
        type: ds.url ? "website" : "text",
        summary: "",
        content: ds.bodyText,
        url: ds.url,
      }))
    );
    const enrichTokens = Math.ceil(enrichDigest.length / 4);
    const enrichCost = (enrichTokens / 1_000_000) * 0.25 + (4000 / 1_000_000) * 1.25;

    console.log("\n=== INGESTION ESTIMATE (LOCAL-FIRST) ===");
    console.log(`Notebook:         ${raw.title}`);
    console.log(`Sources scraped:  ${raw.deepSources!.length}`);
    console.log(`Total body text:  ${totalBodyChars.toLocaleString()} chars (saved LOCALLY, not sent to LLM)`);
    console.log(`Enrichment input: ${enrichDigest.length.toLocaleString()} chars (~${enrichTokens.toLocaleString()} tokens)`);
    console.log(`Enrichment cost:  ${enrichCost < 0.01 ? "< $0.01" : `~$${enrichCost.toFixed(3)}`}`);
    console.log("========================================\n");
  } else {
    // LEGACY path: no deep sources, must send full text to LLM
    const estimatedTokens = Math.ceil(raw.textContent.length / 4);
    const inputCost = (estimatedTokens / 1_000_000) * 0.25;
    const outputCost = (2000 / 1_000_000) * 1.25;
    const totalCost = inputCost + outputCost;

    console.log("\n=== INGESTION ESTIMATE (LEGACY) ===");
    console.log(`Notebook:         ${raw.title}`);
    console.log(`Raw text:         ${raw.textContent.length.toLocaleString()} chars`);
    console.log(`Estimated tokens: ${estimatedTokens.toLocaleString()}`);
    console.log(`LLM extract cost: ${totalCost < 0.01 ? "< $0.01" : `~$${totalCost.toFixed(3)}`}`);
    console.log("===================================\n");
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question("Proceed with ingestion? [y/N] ");
  rl.close();

  if (answer.toLowerCase() !== "y") {
    console.log("Aborted.");
    return;
  }

  // Phase 3: Extract structured content
  let extraction;
  let usage: TokenUsage | undefined;

  if (hasDeepSources) {
    // LOCAL-FIRST: build extraction directly from scraped data
    console.log("\nPhase 3a: Building extraction locally from scraped data...");
    extraction = buildExtractionLocally(raw.title, raw.deepSources!);
    console.log(`  ${extraction.sources.length} source(s) assembled locally. Full content preserved.`);

    // Phase 3b: Lightweight LLM enrichment (summaries, notes, study materials)
    console.log("\nPhase 3b: Enriching via LLM (metadata only, no full content sent)...");
    const provider = createProvider(config);
    const digest = buildEnrichmentDigest(extraction.sources);
    const enrichResult = await enrichExtraction(provider, digest, extraction.notebookTitle, link);
    mergeEnrichment(extraction, enrichResult.enrichment);
    usage = enrichResult.usage;
    console.log(`  Enrichment complete: ${extraction.notes.length} note(s), summaries applied.`);
  } else {
    // LEGACY: send full text to LLM for extraction
    console.log("\nPhase 3: Extracting structured content via LLM (legacy path)...");
    const provider = createProvider(config);
    const result = await extractContent(provider, raw);
    extraction = result.extraction;
    usage = result.usage;
  }

  // Phase 4: Build notebook
  console.log("\nPhase 4: Building Jupyter notebook...");
  console.log(`  Writing notebook, source files, and manifest...`);
  const notebooksDir = join(config.garrisonDir, "notebooks");
  const notebookPath = await buildNotebook(
    extraction,
    notebooksDir,
    name,
    link
  );
  console.log(`  Notebook written: ${notebookPath}`);

  // Phase 5: Register
  console.log("\nPhase 5: Registering notebook...");
  registry.notebooks[name] = {
    name,
    link,
    localPath: notebookPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceCount: extraction.sources.length,
    noteCount: extraction.notes.length,
    googleAccount,
    totalInputTokens: usage?.inputTokens,
    totalOutputTokens: usage?.outputTokens,
  };
  await saveRegistry(config, registry);

  console.log(`\nDone. Notebook created at: ${notebookPath}`);
  console.log(`Registered as: ${name}`);
  if (usage) {
    console.log(`Tokens used: ${usage.inputTokens.toLocaleString()} input, ${usage.outputTokens.toLocaleString()} output`);
  }
  console.log(`Open with: jupyter notebook ${notebookPath}`);
}
