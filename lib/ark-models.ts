/**
 * 火山方舟：模型列表与默认端点（不含密钥；密钥仍用 ARK_API_KEY / DOUBAO_API_KEY）。
 * 可选覆盖：环境变量 ARK_BASE_URL、ARK_MODEL（仅服务端默认值，请求体 arkModel 优先）。
 * chat/completions 的 model 可填控制台「推理接入点」ID（ep-m-…）或官方模型名，二者等价用法见方舟文档。
 */

export const ARK_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

export type ArkModelApiKind = "chat" | "responses";

export type ArkModelDefinition = {
  id: string;
  label: string;
  api: ArkModelApiKind;
  /**
   * 仅 api=responses：部分模型（如 GLM）默认开启思考推理，需在请求体中加 thinking 关闭。
   * 为 true 时发送 `thinking: { type: "disabled" }`，其它模型不传该字段。
   */
  disableResponsesThinking?: boolean;
};

function dedupeArkModelsById(
  items: readonly ArkModelDefinition[],
): ArkModelDefinition[] {
  const seen = new Set<string>();
  const out: ArkModelDefinition[] = [];
  for (const m of items) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** api=chat 走 chat/completions；api=responses 走 /responses */
const ARK_MODELS_RAW: readonly ArkModelDefinition[] = [
  {
    id: "ep-m-20260402154445-v9pc4",
    label: "豆包 1.5 Pro",
    api: "chat",
  },
  {
    id: "ep-m-20260403110517-85lld",
    label: "豆包 Seed 2.0 Mini",
    api: "responses",
  },
  {
    id: "ep-m-20260403110251-h85c2",
    label: "豆包 Seed 2.0 Lite",
    api: "responses",
  },
  {
    id: "ep-m-20260402153013-6wjjb",
    label: "豆包 Seed 2.0 pro",
    api: "responses",
  },
  {
    id: "ep-m-20260403110750-b7p2k",
    label: "DeepSeek V3.2",
    api: "responses",
  },
  {
    id: "ep-m-20260403183308-c9sgx",
    label: "DeepSeek V3.1",
    api: "responses",
  },
  {
    id: "ep-m-20260403183338-rwpqb",
    label: "DeepSeek V3",
    api: "responses",
  },
  {
    id: "ep-m-20260403110728-mwwdv",
    label: "GLM 4.7",
    api: "responses",
    disableResponsesThinking: true,
  },
];

/** 导出前按 id 去重（避免编辑时重复条目导致 React key 冲突） */
export const ARK_MODELS: readonly ArkModelDefinition[] =
  dedupeArkModelsById(ARK_MODELS_RAW);

/** 未传模型时方舟侧默认（与页面统一列表中的「豆包 1.5 Pro 32K」一致） */
export const DEFAULT_ARK_MODEL_ID = "ep-m-20260402154445-v9pc4";

const ID_ORDER = new Map(ARK_MODELS.map((m, i) => [m.id, i]));

export function getArkModelDefinition(
  modelId: string,
): ArkModelDefinition | undefined {
  return ARK_MODELS.find((m) => m.id === modelId);
}

export function isArkModelId(modelId: string): boolean {
  return ID_ORDER.has(modelId);
}

/** 供 zod、前端等使用 */
export const ARK_MODEL_ZOD_ENUM = ARK_MODELS.map((m) => m.id) as [
  string,
  ...string[],
];
