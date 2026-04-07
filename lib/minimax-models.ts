/**
 * MiniMax：Anthropic 兼容 Messages API（/v1/messages）的模型列表。
 * 密钥用环境变量 MINIMAX_API_KEY（或 AI_API_KEY）；基址默认见 MINIMAX_DEFAULT_ANTHROPIC_BASE。
 */

/** 国内文档默认基址：https://platform.minimaxi.com/docs/api-reference/text-anthropic-api */
export const MINIMAX_DEFAULT_ANTHROPIC_BASE = "https://api.minimaxi.com/anthropic";

export type MinimaxModelDefinition = {
  id: string;
  label: string;
};

function dedupeMinimaxModelsById(
  items: readonly MinimaxModelDefinition[],
): MinimaxModelDefinition[] {
  const seen = new Set<string>();
  const out: MinimaxModelDefinition[] = [];
  for (const m of items) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** 与控制台/文档中的模型名一致；新增型号时在此追加即可 */
const MINIMAX_MODELS_RAW: readonly MinimaxModelDefinition[] = [
  { id: "MiniMax-M2.5", label: "MiniMax-M2.5" },
  { id: "MiniMax-M2.7", label: "MiniMax-M2.7" },
];

export const MINIMAX_MODELS: readonly MinimaxModelDefinition[] =
  dedupeMinimaxModelsById(MINIMAX_MODELS_RAW);

export const DEFAULT_MINIMAX_MODEL_ID = "MiniMax-M2.5";

const ID_SET = new Set(MINIMAX_MODELS.map((m) => m.id));

export function isMinimaxModelId(modelId: string): boolean {
  return ID_SET.has(modelId);
}

/** 供 zod 等使用 */
export const MINIMAX_MODEL_ZOD_ENUM = MINIMAX_MODELS.map((m) => m.id) as [
  string,
  ...string[],
];

/**
 * 解析顺序：请求体 minimaxModel → 环境变量 MINIMAX_MODEL → 默认。
 * 若解析结果不在支持列表内，回退默认并应由调用方打日志。
 */
export function resolveMinimaxAnthropicModelId(input: {
  requestModel?: string | undefined;
  envModel?: string | undefined;
}): string {
  const raw =
    input.requestModel?.trim() ||
    input.envModel?.trim() ||
    DEFAULT_MINIMAX_MODEL_ID;
  return isMinimaxModelId(raw) ? raw : DEFAULT_MINIMAX_MODEL_ID;
}
