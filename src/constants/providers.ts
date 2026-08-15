import type { ProviderConfig } from "@/types";

export const PROVIDER_PRESETS: Array<Pick<ProviderConfig, "name" | "baseUrl" | "models">> = [
  {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
  },
  {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
  },
  {
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [{ id: "qwen-plus" }, { id: "qwen-max" }],
  },
];
