/**
 * AI 配置类型。
 * 供应商列表存于仓库级配置（.atelyx/config.json 的 `ai` 段，见 VaultConfig），
 * API key 不随配置落盘——默认仅存 OS keychain（services/keychain，按仓库隔离），
 * 仅 `syncKeys` 显式开启时随仓库配置落盘。
 */
import type { AiConfig } from "@/types";

export const DEFAULT_AI_CONFIG: AiConfig = {
  providers: [],
};
