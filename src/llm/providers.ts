import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { join } from "node:path";
import type { GarrisonConfig } from "../config.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  text: string;
  usage?: TokenUsage;
}

export interface LLMProvider {
  complete(systemPrompt: string, userPrompt: string): Promise<LLMResponse>;
}

type ProviderName = GarrisonConfig["llm"]["provider"];

interface ProviderCredentialSpec {
  envVars: string[];
}

function getProviderCredentialSpec(provider: ProviderName): ProviderCredentialSpec {
  switch (provider) {
    case "claude":
      return { envVars: ["ANTHROPIC_API_KEY"] };
    case "openai":
      return { envVars: ["OPENAI_API_KEY"] };
    case "gemini":
      return { envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] };
  }
}

export function resolveProviderApiKey(config: GarrisonConfig): string | null {
  const spec = getProviderCredentialSpec(config.llm.provider);
  for (const envVar of spec.envVars) {
    const value = process.env[envVar]?.trim();
    if (value) return value;
  }
  return null;
}

export function getProviderCredentialError(config: GarrisonConfig, operation: string): string {
  const spec = getProviderCredentialSpec(config.llm.provider);
  const envVarList = spec.envVars.map((envVar) => `\`${envVar}\``).join(" or ");
  const configPath = join(config.configDir, "config.yaml");

  return [
    `Missing LLM credentials for provider \"${config.llm.provider}\".`,
    `${operation} requires model \"${config.llm.model}\" to call the configured LLM provider.`,
    `Set ${envVarList} in your shell environment, then rerun garrison.`,
    `Config file: ${configPath}`,
  ].join("\n");
}

export function assertProviderCredentials(config: GarrisonConfig, operation: string): string {
  const apiKey = resolveProviderApiKey(config);
  if (!apiKey) {
    throw new Error(getProviderCredentialError(config, operation));
  }
  return apiKey;
}

class ClaudeProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(model: string, apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = response.content[0];
    if (block.type !== "text") throw new Error("Unexpected response type from Claude");
    return {
      text: block.text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(model: string, apiKey: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return {
      text: response.choices[0]?.message?.content || "",
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  }
}

export function createProvider(config: GarrisonConfig): LLMProvider {
  const { provider, model } = config.llm;
  const apiKey = assertProviderCredentials(config, "LLM extraction");

  switch (provider) {
    case "claude":
      return new ClaudeProvider(model, apiKey);
    case "openai":
      return new OpenAIProvider(model, apiKey);
    case "gemini":
      // Gemini uses OpenAI-compatible API
      return new OpenAIProvider(model, apiKey);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
