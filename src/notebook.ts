import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { NotebookExtraction } from "./llm/schemas.js";

interface NotebookCell {
  cell_type: "markdown" | "code";
  metadata: Record<string, unknown>;
  source: string[];
  outputs?: unknown[];
  execution_count?: number | null;
}

interface JupyterNotebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: {
    kernelspec: {
      display_name: string;
      language: string;
      name: string;
    };
    language_info: {
      name: string;
      version: string;
    };
  };
  cells: NotebookCell[];
}

function markdownCell(lines: string[]): NotebookCell {
  return {
    cell_type: "markdown",
    metadata: {},
    source: lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l)),
  };
}

function codeCell(lines: string[]): NotebookCell {
  return {
    cell_type: "code",
    metadata: {},
    source: lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l)),
    outputs: [],
    execution_count: null,
  };
}

export async function buildNotebook(
  extraction: NotebookExtraction,
  outputDir: string,
  name: string,
  link: string
): Promise<string> {
  const cells: NotebookCell[] = [];

  // Header cell
  cells.push(
    markdownCell([
      `# ${extraction.notebookTitle}`,
      "",
      `**Garrison Name:** \`${name}\`  `,
      `**Source:** [NotebookLM](${link})  `,
      `**Ingested:** ${new Date().toISOString()}  `,
      `**Sources:** ${extraction.sources.length} | **Notes:** ${extraction.notes.length}`,
    ])
  );

  // Summary cell
  cells.push(
    markdownCell(["## Summary", "", extraction.rawSummary])
  );

  // Sources
  if (extraction.sources.length > 0) {
    cells.push(markdownCell(["## Sources", ""]));
    for (const source of extraction.sources) {
      const header = source.url
        ? `### ${source.title} (${source.type}) [link](${source.url})`
        : `### ${source.title} (${source.type})`;
      cells.push(
        markdownCell([header, "", `**Summary:** ${source.summary}`, ""])
      );
      cells.push(markdownCell([source.content]));
    }
  }

  // Notes
  if (extraction.notes.length > 0) {
    cells.push(markdownCell(["## Notes", ""]));
    for (const note of extraction.notes) {
      if (note.title) {
        cells.push(markdownCell([`### ${note.title}`, "", note.content]));
      } else {
        cells.push(markdownCell([note.content]));
      }
    }
  }

  // Generated content sections
  for (const [key, label] of [
    ["studyGuide", "Study Guide"],
    ["briefingDoc", "Briefing Document"],
    ["faq", "FAQ"],
    ["timeline", "Timeline"],
  ] as const) {
    const value = extraction[key as keyof NotebookExtraction];
    if (value && typeof value === "string") {
      cells.push(markdownCell([`## ${label}`, "", value]));
    }
  }

  // Analysis starter cell
  cells.push(
    markdownCell([
      "## Analysis Workspace",
      "",
      "Use the cells below for local analysis. This section is yours.",
    ])
  );
  cells.push(
    codeCell([
      "# Analysis workspace - add your code here",
      "# All source data is in the markdown cells above",
    ])
  );

  const notebook: JupyterNotebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
        version: "3.10.12",
      },
    },
    cells,
  };

  // Write notebook
  const notebookDir = join(outputDir, name);
  await mkdir(notebookDir, { recursive: true });

  const notebookPath = join(notebookDir, "notebook.ipynb");
  await writeFile(notebookPath, JSON.stringify(notebook, null, 2), "utf-8");

  // Write individual source files
  const sourcesDir = join(notebookDir, "sources");
  await mkdir(sourcesDir, { recursive: true });
  for (let i = 0; i < extraction.sources.length; i++) {
    const src = extraction.sources[i];
    const filename = `${String(i + 1).padStart(2, "0")}-${src.title.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase().slice(0, 50)}.md`;
    await writeFile(
      join(sourcesDir, filename),
      `# ${src.title}\n\n**Type:** ${src.type}\n${src.url ? `**URL:** ${src.url}\n` : ""}\n## Summary\n\n${src.summary}\n\n## Content\n\n${src.content}\n`,
      "utf-8"
    );
  }

  // Reserve a workspace for downstream AI-generated digests/reports
  const fruitsDir = join(notebookDir, "fruits");
  await mkdir(fruitsDir, { recursive: true });

  // Write manifest
  const manifest = {
    name,
    link,
    notebookTitle: extraction.notebookTitle,
    sourceCount: extraction.sources.length,
    noteCount: extraction.notes.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(
    join(notebookDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  return notebookPath;
}
