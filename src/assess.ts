import { getAuthenticatedContext, closeContext } from "./auth.js";
import { scrapeNotebookPage } from "./scraper.js";
import type { GarrisonConfig } from "./config.js";
import { createProvider, type LLMProvider } from "./llm/providers.js";
import { z } from "zod";

interface Assessment {
  url: string;
  pageTitle: string;
  rawCharCount: number;
  estimatedTokens: number;
  estimatedLLMCost: string;
  estimatedNotebookSize: string;
}

const ScrapeDiagnosisSchema = z.object({
  hasNotebookContent: z.boolean(),
  pageState: z.enum(["notebook", "shell", "auth", "unknown"]),
  reason: z.string(),
  normalizedText: z.string().optional(),
});

type ScrapeDiagnosis = z.infer<typeof ScrapeDiagnosisSchema>;

const SCRAPE_DIAGNOSIS_SYSTEM_PROMPT = `You are diagnosing a NotebookLM scrape capture.
Determine whether the captured page dump contains actual notebook content or only app chrome/login/shell UI.

Return ONLY valid JSON with this shape:
{
  "hasNotebookContent": true,
  "pageState": "notebook",
  "reason": "short explanation",
  "normalizedText": "best-effort plain text content recovered from the dump if present"
}

Rules:
- Use pageState = auth if the dump looks like Google sign-in or access/auth friction.
- Use pageState = shell if the dump is mostly NotebookLM chrome, navigation, or empty-state UI.
- Use pageState = notebook only if you can clearly see actual notebook/source/note content.
- normalizedText should contain only recovered notebook content, not generic UI labels.
- If no notebook content is present, omit normalizedText.`;

/**
 * Rough token estimation: ~4 chars per token for English text.
 * Cost estimation based on Claude Haiku-class pricing (~$0.25/1M input + $1.25/1M output).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateCost(inputTokens: number): string {
  // Assume ~2K output tokens for extraction
  const inputCost = (inputTokens / 1_000_000) * 0.25;
  const outputCost = (2000 / 1_000_000) * 1.25;
  const total = inputCost + outputCost;
  if (total < 0.01) return "< $0.01";
  return `~$${total.toFixed(3)}`;
}

function formatBytes(chars: number): string {
  const bytes = chars * 2; // rough UTF-16
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shouldDiagnoseScrape(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.length < 400 || normalized.includes("welcome to notebooklm");
}

async function diagnoseNotebookScrape(
  provider: LLMProvider,
  rawContent: { title: string; url: string; pageDump?: string; textContent: string }
): Promise<ScrapeDiagnosis> {
  const userPrompt = `Page title: ${rawContent.title}
Page URL: ${rawContent.url}

--- BEGIN PAGE DUMP ---
${(rawContent.pageDump || rawContent.textContent).slice(0, 60_000)}
--- END PAGE DUMP ---`;

  const llmResponse = await provider.complete(SCRAPE_DIAGNOSIS_SYSTEM_PROMPT, userPrompt);
  const parsed = JSON.parse(llmResponse.text.replace(/^```json?\n?/gm, "").replace(/\n?```$/gm, "").trim());
  return ScrapeDiagnosisSchema.parse(parsed);
}

export async function assessCommand(
  link: string,
  config: GarrisonConfig
): Promise<Assessment> {
  console.log("garrison assess -- read-only estimation\n");

  const { context } = await getAuthenticatedContext(config, link);
  try {
    const raw = await scrapeNotebookPage(context, link);
    let assessmentText = raw.textContent;

    if (shouldDiagnoseScrape(raw.textContent)) {
      console.log("Scrape looks thin. Asking configured LLM to diagnose the page capture...");
      try {
        const diagnosis = await diagnoseNotebookScrape(createProvider(config), raw);
        console.log(`LLM scrape diagnosis: ${diagnosis.pageState} -- ${diagnosis.reason}`);

        if (diagnosis.normalizedText && diagnosis.normalizedText.length > assessmentText.length) {
          assessmentText = diagnosis.normalizedText.trim();
        }

        if (!diagnosis.hasNotebookContent && assessmentText.length < 200) {
          throw new Error(
            `NotebookLM opened, but notebook content was not recoverable yet. ${diagnosis.reason}`
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("not recoverable yet")) {
          throw error;
        }
        console.warn(
          `LLM scrape diagnosis failed; continuing with raw scrape only. ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const tokens = estimateTokens(assessmentText);

    const assessment: Assessment = {
      url: link,
      pageTitle: raw.title,
      rawCharCount: assessmentText.length,
      estimatedTokens: tokens,
      estimatedLLMCost: estimateCost(tokens),
      estimatedNotebookSize: formatBytes(assessmentText.length),
    };

    console.log("=== ASSESSMENT ===");
    console.log(`Notebook:          ${assessment.pageTitle}`);
    console.log(`URL:               ${assessment.url}`);
    console.log(`Raw text:          ${assessment.rawCharCount.toLocaleString()} chars`);
    console.log(`Estimated tokens:  ${assessment.estimatedTokens.toLocaleString()}`);
    console.log(`LLM extract cost:  ${assessment.estimatedLLMCost}`);
    console.log(`Notebook size:     ${assessment.estimatedNotebookSize}`);
    console.log("==================\n");

    return assessment;
  } finally {
    await closeContext(context);
  }
}
