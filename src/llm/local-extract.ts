/**
 * Local-first extraction: builds a NotebookExtraction directly from scraped
 * DOM data without sending full body text to an LLM.
 *
 * The LLM is only used (optionally) for enrichment — summaries, notes,
 * study guides — using lightweight metadata, NOT the full source content.
 */

import type { DeepSourceData } from "../scraper.js";
import type { NotebookExtraction, Source, Note } from "./schemas.js";

/**
 * Infer source type from URL pattern. Falls back to "text" for uploaded docs.
 */
function inferSourceType(url?: string): string {
  if (!url) return "text";
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  if (lower.endsWith(".pdf") || lower.includes("/pdf/")) return "pdf";
  if (lower.includes("arxiv.org")) return "pdf";
  if (lower.includes("docs.google.com/document")) return "google-doc";
  if (lower.includes("docs.google.com/spreadsheets")) return "google-sheet";
  if (lower.includes("drive.google.com")) return "google-drive";
  return "website";
}

/**
 * Build a NotebookExtraction entirely from locally-scraped data.
 * No LLM call. No truncation. Full body text preserved.
 *
 * @param pageTitle - The page <title> from the NotebookLM tab
 * @param deepSources - Per-source data from the deep scrape click-through
 * @returns A complete NotebookExtraction ready for buildNotebook()
 */
export function buildExtractionLocally(
  pageTitle: string,
  deepSources: DeepSourceData[]
): NotebookExtraction {
  const sources: Source[] = deepSources.map((ds) => ({
    title: ds.title,
    type: inferSourceType(ds.url),
    summary: "", // Placeholder — enrichment pass fills this in
    content: ds.bodyText, // FULL, UNTRUNCATED
    url: ds.url,
  }));

  // Derive notebook title: strip " - NotebookLM" suffix if present
  const notebookTitle = pageTitle
    .replace(/\s*[-–—]\s*NotebookLM.*$/i, "")
    .trim() || pageTitle;

  const extraction: NotebookExtraction = {
    notebookTitle,
    sources,
    notes: [],
    rawSummary: `Notebook with ${sources.length} source(s) extracted locally from NotebookLM.`,
  };

  return extraction;
}

/**
 * Build a lightweight metadata digest for the LLM enrichment call.
 * Contains ONLY titles, URLs, types, and a short preview of each source.
 * Keeps total token count small (~30K for 142 sources).
 */
export function buildEnrichmentDigest(
  sources: Source[],
  previewChars: number = 500
): string {
  const lines: string[] = [
    `Notebook contains ${sources.length} source(s). For each source, here is the metadata and a brief preview:\n`,
  ];

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const preview = s.content.slice(0, previewChars).trim();
    lines.push(`--- Source ${i + 1} ---`);
    lines.push(`Title: ${s.title}`);
    lines.push(`Type: ${s.type}`);
    if (s.url) lines.push(`URL: ${s.url}`);
    lines.push(`Content preview: ${preview}`);
    lines.push("");
  }

  return lines.join("\n");
}

export interface EnrichmentResult {
  summaries: Record<number, string>; // index → summary
  notes: Note[];
  rawSummary: string;
  studyGuide?: string;
  briefingDoc?: string;
  faq?: string;
  timeline?: string;
}

/**
 * Merge LLM enrichment results back into a locally-built extraction.
 * Mutates the extraction in place.
 */
export function mergeEnrichment(
  extraction: NotebookExtraction,
  enrichment: EnrichmentResult
): void {
  // Apply per-source summaries
  for (const [idxStr, summary] of Object.entries(enrichment.summaries)) {
    const idx = Number(idxStr);
    if (idx >= 0 && idx < extraction.sources.length) {
      extraction.sources[idx].summary = summary;
    }
  }

  // Apply notebook-level fields
  extraction.notes = enrichment.notes;
  extraction.rawSummary = enrichment.rawSummary;
  if (enrichment.studyGuide) extraction.studyGuide = enrichment.studyGuide;
  if (enrichment.briefingDoc) extraction.briefingDoc = enrichment.briefingDoc;
  if (enrichment.faq) extraction.faq = enrichment.faq;
  if (enrichment.timeline) extraction.timeline = enrichment.timeline;
}

