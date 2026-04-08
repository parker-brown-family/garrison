import { readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  loadRegistry,
  type GarrisonConfig,
  type Registry,
} from "./config.js";

export interface NotebookStatus {
  name: string;
  sizeBytes: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function getPathSize(targetPath: string): Promise<number> {
  const targetStat = await stat(targetPath);
  if (!targetStat.isDirectory()) {
    return targetStat.size;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = `${targetPath}/${entry.name}`;
      return getPathSize(entryPath);
    })
  );

  return sizes.reduce((total, size) => total + size, 0);
}

export async function collectNotebookStatuses(
  registry: Registry
): Promise<NotebookStatus[]> {
  const names = Object.keys(registry.notebooks).sort((left, right) =>
    left.localeCompare(right)
  );

  return Promise.all(
    names.map(async (name) => {
      const entry = registry.notebooks[name];
      try {
        return {
          name,
          sizeBytes: await getPathSize(dirname(entry.localPath)),
          totalInputTokens: entry.totalInputTokens ?? 0,
          totalOutputTokens: entry.totalOutputTokens ?? 0,
        };
      } catch {
        return { name, sizeBytes: null, totalInputTokens: entry.totalInputTokens ?? 0, totalOutputTokens: entry.totalOutputTokens ?? 0 };
      }
    })
  );
}

function formatTokens(count: number): string {
  if (count === 0) return "-";
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function renderStatusReport(statuses: NotebookStatus[]): string {
  if (statuses.length === 0) {
    return "No notebooks registered.";
  }

  const sizeLabels = statuses.map((status) =>
    status.sizeBytes === null ? "MISSING" : formatBytes(status.sizeBytes)
  );
  const tokenLabels = statuses.map((status) => {
    const total = status.totalInputTokens + status.totalOutputTokens;
    if (total === 0) return "-";
    return `${formatTokens(status.totalInputTokens)} in / ${formatTokens(status.totalOutputTokens)} out`;
  });

  const nameWidth = Math.max("NAME".length, ...statuses.map((status) => status.name.length));
  const sizeWidth = Math.max("SIZE".length, ...sizeLabels.map((label) => label.length));
  const tokenWidth = Math.max("TOKENS".length, ...tokenLabels.map((label) => label.length));
  const totalBytes = statuses.reduce(
    (total, status) => total + (status.sizeBytes ?? 0),
    0
  );
  const totalInput = statuses.reduce((t, s) => t + s.totalInputTokens, 0);
  const totalOutput = statuses.reduce((t, s) => t + s.totalOutputTokens, 0);

  const lines = [
    `Registered notebooks: ${statuses.length}`,
    "",
    `${"NAME".padEnd(nameWidth)}  ${"SIZE".padStart(sizeWidth)}  ${"TOKENS".padStart(tokenWidth)}`,
    `${"-".repeat(nameWidth)}  ${"-".repeat(sizeWidth)}  ${"-".repeat(tokenWidth)}`,
  ];

  for (let index = 0; index < statuses.length; index++) {
    lines.push(
      `${statuses[index].name.padEnd(nameWidth)}  ${sizeLabels[index].padStart(sizeWidth)}  ${tokenLabels[index].padStart(tokenWidth)}`
    );
  }

  lines.push("");
  lines.push(`Total size: ${formatBytes(totalBytes)}`);
  if (totalInput + totalOutput > 0) {
    lines.push(`Total tokens: ${formatTokens(totalInput)} input, ${formatTokens(totalOutput)} output (${formatTokens(totalInput + totalOutput)} total)`);
  }
  return lines.join("\n");
}

export async function statusCommand(config: GarrisonConfig): Promise<void> {
  const registry = await loadRegistry(config);
  const statuses = await collectNotebookStatuses(registry);
  console.log(renderStatusReport(statuses));
}