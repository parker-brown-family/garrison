import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface GarrisonConfig {
  garrisonDir: string;
  configDir: string;
  registryPath: string;
  authDir: string;
  llm: {
    provider: "claude" | "openai" | "gemini";
    model: string;
  };
}

export interface RegistryEntry {
  name: string;
  link: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  noteCount: number;
  googleAccount?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export interface Registry {
  notebooks: Record<string, RegistryEntry>;
}

const DEFAULT_CONFIG = {
  llm: {
    provider: "claude" as const,
    model: "claude-sonnet-4-20250514",
  },
};

export async function loadConfig(): Promise<GarrisonConfig> {
  const home = homedir();
  const configDir = join(home, ".garrison");
  const authDir = join(configDir, "auth");
  const garrisonDir = join(home, "ai-garrison");
  const registryPath = join(configDir, "registry.json");
  const configPath = join(configDir, "config.yaml");

  // Ensure dirs exist
  if (!existsSync(configDir)) await mkdir(configDir, { recursive: true });
  if (!existsSync(authDir)) await mkdir(authDir, { recursive: true });

  // Load or create config
  let userConfig = {};
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf-8");
    userConfig = parseYaml(raw) || {};
  } else {
    await writeFile(configPath, stringifyYaml(DEFAULT_CONFIG), "utf-8");
  }

  const merged = { ...DEFAULT_CONFIG, ...userConfig };

  return {
    garrisonDir,
    configDir,
    registryPath,
    authDir,
    llm: merged.llm,
  };
}

export async function loadRegistry(
  config: GarrisonConfig
): Promise<Registry> {
  if (!existsSync(config.registryPath)) {
    return { notebooks: {} };
  }
  const raw = await readFile(config.registryPath, "utf-8");
  return JSON.parse(raw) as Registry;
}

export async function saveRegistry(
  config: GarrisonConfig,
  registry: Registry
): Promise<void> {
  await writeFile(
    config.registryPath,
    JSON.stringify(registry, null, 2),
    "utf-8"
  );
}
