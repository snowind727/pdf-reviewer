/**
 * 审稿页「模型」下拉：在此**显式**维护顺序与展示名。
 *
 * 约定：先 **MiniMax**（顺序对齐 `lib/minimax-models.ts`），后 **方舟/豆包**（顺序对齐 `lib/ark-models.ts`）。
 * 增删或改 UI 顺序时改本数组即可；`id` 仍须在两处配置之一中已注册。
 */

import { isArkModelId } from "@/lib/ark-models";
import { isMinimaxModelId } from "@/lib/minimax-models";

export type AiReviewModelEntry = {
  id: string;
  label: string;
};

export const AI_REVIEW_MODELS: readonly AiReviewModelEntry[] = [
  // --- 方舟 / 豆bao（与 ark-models.ts 中顺序一致）---
  { id: "ep-m-20260403110517-85lld", label: "豆包 Seed 2.0" },
  { id: "ep-m-20260403110750-b7p2k", label: "DeepSeek V3.2" },
  { id: "ep-m-20260403110728-mwwdv", label: "GLM 4.7" },
];

export const DEFAULT_AI_REVIEW_MODEL_ID = "ep-m-20260403110728-mwwdv";

const ID_SET = new Set(AI_REVIEW_MODELS.map((m) => m.id));

export function isAiReviewModelId(id: string): boolean {
  return ID_SET.has(id);
}

export const AI_REVIEW_MODEL_ZOD_ENUM = AI_REVIEW_MODELS.map((m) => m.id) as [
  string,
  ...string[],
];

export function getAiReviewProvider(
  modelId: string,
): "minimax" | "doubao" {
  if (!isAiReviewModelId(modelId)) {
    throw new Error(`invalid AI review model: ${modelId}`);
  }
  if (isMinimaxModelId(modelId)) return "minimax";
  if (isArkModelId(modelId)) return "doubao";
  throw new Error(`model id not registered in minimax/ark: ${modelId}`);
}
