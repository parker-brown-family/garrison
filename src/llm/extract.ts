import type { LLMProvider, LLMResponse, TokenUsage } from "./providers.js";
import { NotebookExtractionSchema, type NotebookExtraction } from "./schemas.js";
import type { RawPageContent } from "../scraper.js";
import { type EnrichmentResult } from "./local-extract.js";

export { type TokenUsage } from "./providers.js";

/* ------------------------------------------------------------------ */
/*  LEGACY: Full-content LLM extraction (fallback when no deep scrape) */
/* ------------------------------------------------------------------ */

const EXTRACTION_SYSTEM_PROMPT = `You are a structured data extraction agent.
You will receive the raw text content scraped from a Google NotebookLM page.
Your job is to extract ALL meaningful content and return it as valid JSON.

The JSON must match this schema:
{
  "notebookTitle": "string - the notebook title",
  "sources": [
    {
      "title": "string - source title",
      "type": "string - e.g. website, pdf, youtube, text",
      "summary": "string - brief summary of what this source contains",
      "content": "string - full extracted text content",
      "url": "string (optional) - source URL if it is a web link"
    }
  ],
  "notes": [
    {
      "title": "string (optional)",
      "content": "string - the note content"
    }
  ],
  "studyGuide": "string (optional) - if a study guide was generated",
  "briefingDoc": "string (optional) - if a briefing document was generated",
  "faq": "string (optional) - if an FAQ was generated",
  "timeline": "string (optional) - if a timeline was generated",
  "rawSummary": "string - your overall summary of what this notebook contains"
}

General rules:
- Return ONLY valid JSON. No markdown fencing, no explanation.
- Extract every source and every note you can identify.
- If a section is not present, omit the optional field.
- Preserve source content as faithfully as possible — do not paraphrase or shorten it.
- If you cannot determine a field, use a reasonable placeholder.`;

/**
 * LEGACY fallback: sends full page content to LLM for extraction.
 * Only used when deep scrape produced zero sources.
 */
export interface ExtractionWithUsage {
  extraction: NotebookExtraction;
  usage?: TokenUsage;
}

export async function extractContent(
  provider: LLMProvider,
  rawContent: RawPageContent
): Promise<ExtractionWithUsage> {
  const userPrompt = `Here is the raw text content from a Google NotebookLM notebook page.

Page title: ${rawContent.title}
Page URL: ${rawContent.url}
Scraped at: ${rawContent.timestamp}

--- BEGIN RAW CONTENT ---
${rawContent.textContent}
--- END RAW CONTENT ---

Extract all structured content and return as JSON.`;

  const inputChars = userPrompt.length;
  const estimatedTokens = Math.ceil(inputChars / 4);
  console.log(`  [Legacy extraction] Input: ${inputChars.toLocaleString()} chars (~${estimatedTokens.toLocaleString()} tokens)`);
  console.log(`  Awaiting LLM response...`);

  const llmResponse = await timedComplete(provider, EXTRACTION_SYSTEM_PROMPT, userPrompt);
  const extraction = parseAndValidateExtraction(llmResponse.text);
  return { extraction, usage: llmResponse.usage };
}

/* ------------------------------------------------------------------ */
/*  NEW: Lightweight enrichment (summaries, notes, study guide only)   */
/* ------------------------------------------------------------------ */

const ENRICHMENT_SYSTEM_PROMPT = `You are a notebook enrichment agent.
You will receive a METADATA DIGEST of sources already extracted from a Google NotebookLM notebook.
The full source content has already been saved locally. You do NOT need to return it.

Your job is to generate enrichment data: summaries, notes, and optional study materials.

Return ONLY valid JSON matching this schema:
{
  "summaries": { "<source_index>": "1-2 sentence summary of that source", ... },
  "notes": [
    { "title": "string (optional)", "content": "string - a useful note or insight" }
  ],
  "rawSummary": "string - overall summary of what this notebook contains",
  "studyGuide": "string (optional) - a study guide if the content is educational",
  "briefingDoc": "string (optional) - a briefing document if the content is informational",
  "faq": "string (optional) - frequently asked questions derived from the sources",
  "timeline": "string (optional) - a timeline if the content has chronological elements"
}

Rules:
- Return ONLY valid JSON. No markdown fencing, no explanation.
- "summaries" keys are zero-based source indices as strings (e.g. "0", "1", "2").
- Write concise, informative summaries based on the title, type, URL, and content preview.
- Generate 2-5 notes that capture cross-cutting themes or key insights.
- Only include studyGuide/briefingDoc/faq/timeline if the content warrants it.`;

/**
 * Lightweight LLM call for enrichment only.
 * Input: metadata digest (~30K tokens for 142 sources).
 * Output: summaries, notes, study materials.
 * Does NOT receive or return full source content.
 */
export interface EnrichmentWithUsage {
  enrichment: EnrichmentResult;
  usage?: TokenUsage;
}

export async function enrichExtraction(
  provider: LLMProvider,
  metadataDigest: string,
  notebookTitle: string,
  notebookUrl: string
): Promise<EnrichmentWithUsage> {
  const userPrompt = `Notebook: ${notebookTitle}
URL: ${notebookUrl}

--- BEGIN SOURCE METADATA DIGEST ---
${metadataDigest}
--- END SOURCE METADATA DIGEST ---

Generate enrichment data (summaries, notes, study materials) for this notebook.`;

  const inputChars = userPrompt.length;
  const estimatedTokens = Math.ceil(inputChars / 4);
  console.log(`  [Enrichment] Input: ${inputChars.toLocaleString()} chars (~${estimatedTokens.toLocaleString()} tokens)`);
  console.log(`  Awaiting LLM response...`);

  const llmResponse = await timedComplete(provider, ENRICHMENT_SYSTEM_PROMPT, userPrompt);

  let parsed: unknown;
  try {
    const cleaned = llmResponse.text.replace(/^```json?\n?/gm, "").replace(/\n?```$/gm, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `LLM enrichment returned invalid JSON. First 500 chars: ${llmResponse.text.slice(0, 500)}`
    );
  }

  // Basic shape validation
  const obj = parsed as Record<string, unknown>;
  const summaries: Record<number, string> = {};
  if (obj.summaries && typeof obj.summaries === "object") {
    for (const [k, v] of Object.entries(obj.summaries as Record<string, unknown>)) {
      summaries[Number(k)] = String(v);
    }
  }

  return {
    enrichment: {
      summaries,
      notes: Array.isArray(obj.notes)
        ? obj.notes.map((n: Record<string, unknown>) => ({
            title: n.title ? String(n.title) : undefined,
            content: String(n.content ?? ""),
          }))
        : [],
      rawSummary: String(obj.rawSummary ?? `Notebook with sources extracted from NotebookLM.`),
      studyGuide: obj.studyGuide ? String(obj.studyGuide) : undefined,
      briefingDoc: obj.briefingDoc ? String(obj.briefingDoc) : undefined,
      faq: obj.faq ? String(obj.faq) : undefined,
      timeline: obj.timeline ? String(obj.timeline) : undefined,
    },
    usage: llmResponse.usage,
  };
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

async function timedComplete(
  provider: LLMProvider,
  systemPrompt: string,
  userPrompt: string
): Promise<LLMResponse> {
  const startMs = Date.now();
  const ticker = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    process.stdout.write(`\r  Elapsed: ${elapsed}s ...`);
  }, 1000);

  let llmResponse: LLMResponse;
  try {
    llmResponse = await provider.complete(systemPrompt, userPrompt);
  } finally {
    clearInterval(ticker);
    process.stdout.write("\r" + " ".repeat(30) + "\r");
  }

  console.log(`  Response received: ${llmResponse.text.length.toLocaleString()} chars`);
  if (llmResponse.usage) {
    console.log(`  Tokens used: ${llmResponse.usage.inputTokens.toLocaleString()} input, ${llmResponse.usage.outputTokens.toLocaleString()} output`);
  }
  return llmResponse;
}

function parseAndValidateExtraction(response: string): NotebookExtraction {
  let parsed: unknown;
  console.log(`  Parsing response JSON...`);
  try {
    const cleaned = response.replace(/^```json?\n?/gm, "").replace(/\n?```$/gm, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `LLM returned invalid JSON. First 500 chars: ${response.slice(0, 500)}`
    );
  }

  console.log(`  Validating extraction schema...`);
  const result = NotebookExtractionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `LLM output failed schema validation: ${result.error.message}`
    );
  }

  const { sources, notes } = result.data;
  console.log(`  Extracted: ${sources.length} source(s), ${notes.length} note(s)`);
  return result.data;
}
