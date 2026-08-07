/**
 * AI 配置类型。
 * 存于 settings 表的 `ai.config` key，value 为 AiConfig 的 JSON。
 * 当前 key 明文存 DB（本地单用户），后续接 keychain 加密。
 */
import type { AiConfig, ProviderConfig } from "@/types";

export type { ProviderConfig };
export type { AiConfig };

export const DEFAULT_AI_CONFIG: AiConfig = {
  providers: [],
};
