import { z } from "zod";

export const SourceSchema = z.object({
  title: z.string(),
  type: z.string().describe("e.g. website, pdf, youtube, text, etc."),
  summary: z.string(),
  content: z
    .string()
    .default("")
    .describe("Full extracted text content of this source (empty when deep scrape unavailable)"),
  url: z.string().optional(),
});

export const NoteSchema = z.object({
  title: z.string().optional(),
  content: z.string(),
});

export const NotebookExtractionSchema = z.object({
  notebookTitle: z.string(),
  sources: z.array(SourceSchema),
  notes: z.array(NoteSchema),
  studyGuide: z.string().optional().describe("If a study guide was generated"),
  briefingDoc: z.string().optional().describe("If a briefing document was generated"),
  faq: z.string().optional().describe("If an FAQ was generated"),
  timeline: z.string().optional().describe("If a timeline was generated"),
  rawSummary: z.string().describe("Overall summary of the notebook content"),
});

export type Source = z.infer<typeof SourceSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type NotebookExtraction = z.infer<typeof NotebookExtractionSchema>;
