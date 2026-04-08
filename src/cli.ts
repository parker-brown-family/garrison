#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { assessCommand } from "./assess.js";
import { newCommand } from "./ingest.js";
import { statusCommand } from "./status.js";
import { updateCommand } from "./update.js";
import { loadConfig, loadRegistry } from "./config.js";
import { createWorkflowSession, runWorkflowLauncher } from "./workflow.js";

/**
 * Load .env.local then .env from cwd into process.env.
 * Only sets vars that are not already present in the environment.
 * Runs synchronously so credentials are available before any async work.
 */
function loadEnvFiles(): void {
  const candidates = [".env.local", ".env"];
  // Search cwd first, then fall back to the fixed garrison home dir so the
  // CLI finds credentials regardless of which directory the user invokes it from.
  const searchDirs = Array.from(
    new Set([process.cwd(), join(homedir(), "ai-garrison")])
  );
  for (const dir of searchDirs) {
    for (const filename of candidates) {
      const filePath = join(dir, filename);
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex < 1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        // Strip optional surrounding quotes from the value
        const rawValue = trimmed.slice(eqIndex + 1).trim();
        const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
        if (key && !(key in process.env)) {
          process.env[key] = value;
        }
      }
    }
  }
}

loadEnvFiles();

export function createProgram(): Command {
  const program = new Command();

  program
    .name("garrison")
    .description(
      "Ingest Google NotebookLM content into local Jupyter notebooks."
    )
    .version("0.1.0");

  program
    .command("assess <link>")
    .description(
      "Estimate cost and scope of ingesting a NotebookLM notebook. Read-only."
    )
    .action(async (link: string) => {
      const config = await loadConfig();
      await assessCommand(link, config);
    });

  program
    .command("new <name> <link>")
    .description("Ingest a NotebookLM notebook into a local Jupyter notebook.")
    .action(async (name: string, link: string) => {
      const config = await loadConfig();
      await newCommand(name, link, config);
    });

  program
    .command("update <name>")
    .description("Re-scrape and update an existing garrison notebook.")
    .action(async (name: string) => {
      const config = await loadConfig();
      await updateCommand(name, config);
    });

  program
    .command("status")
    .description("List registered notebooks and the size of each local notebook directory.")
    .action(async () => {
      const config = await loadConfig();
      await statusCommand(config);
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = createProgram();

  if (argv.slice(2).length === 0) {
    const session = createWorkflowSession();
    try {
      await runWorkflowLauncher(
        {
          assess: async (link: string) => {
            const config = await loadConfig();
            await assessCommand(link, config);
          },
          createNotebook: async (name: string, link: string) => {
            const config = await loadConfig();
            await newCommand(name, link, config);
          },
          updateNotebook: async (name: string) => {
            const config = await loadConfig();
            await updateCommand(name, config);
          },
          showStatus: async () => {
            const config = await loadConfig();
            await statusCommand(config);
          },
          showHelp: () => {
            program.outputHelp();
          },
          getNotebookList: async () => {
            const config = await loadConfig();
            const registry = await loadRegistry(config);
            return Object.values(registry.notebooks)
              .map((entry) => ({
                name: entry.name,
                sourceCount: entry.sourceCount,
                updatedAt: entry.updatedAt,
              }))
              .sort((a, b) => a.name.localeCompare(b.name));
          },
        },
        session
      );
    } finally {
      session.close();
    }
    return;
  }

  await program.parseAsync(argv);
}

function handleCliError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch(handleCliError);
