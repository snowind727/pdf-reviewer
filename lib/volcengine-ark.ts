/** 火山引擎方舟：OpenAI 兼容 chat/completions（豆包 1.5 等）与 /responses（DeepSeek、GLM、Seed 等） */

import {
  ARK_DEFAULT_BASE_URL,
  DEFAULT_ARK_MODEL_ID,
  getArkModelDefinition,
  type ArkModelDefinition,
} from "@/lib/ark-models";

const ARK_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

export type OpenAIChatCompletionResponse = {
  choices?: Array<{ message?: { role?: string; content?: string | null } }>;
  error?: { message?: string; type?: string; code?: string };
  id?: string;
};

/** https://ark.cn-beijing.volces.com/api/v3/responses 非流式返回 */
type ArkResponsesOutputBlock = {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};

export type ArkResponsesApiResponse = {
  id?: string;
  object?: string;
  status?: string;
  error?: { message?: string; type?: string; code?: string };
  output?: ArkResponsesOutputBlock[];
};

export function getArkRuntimeConfig(arkModelId?: string): {
  apiKey: string | undefined;
  baseUrl: string;
  modelDef: ArkModelDefinition;
} {
  const apiKey =
    process.env.ARK_API_KEY?.trim() || process.env.DOUBAO_API_KEY?.trim();
  const baseUrl = (process.env.ARK_BASE_URL?.trim() || ARK_DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
  const resolvedId =
    arkModelId?.trim() ||
    process.env.ARK_MODEL?.trim() ||
    DEFAULT_ARK_MODEL_ID;
  const modelDef =
    getArkModelDefinition(resolvedId) ?? getArkModelDefinition(DEFAULT_ARK_MODEL_ID)!;
  return { apiKey, baseUrl, modelDef };
}

export function extractOpenAIAssistantText(
  data: OpenAIChatCompletionResponse,
): string {
  const c = data.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

/**
 * 从 /responses 的 output 中取助手最终文本：只拼接 type===message 里的 output_text，
 * 忽略 reasoning 等块（与 GLM / Seed 带推理时的行为一致）。
 */
export function extractResponsesAssistantText(data: ArkResponsesApiResponse): string {
  const out = data.output;
  if (!Array.isArray(out)) return "";
  const parts: string[] = [];
  for (const block of out) {
    if (block.type !== "message") continue;
    const content = block.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isArkRetryable(status: number): boolean {
  return ARK_RETRYABLE_STATUS.has(status);
}

export type ArkChatResult =
  | { ok: true; text: string }
  | {
      ok: false;
      status: number;
      detail: string;
      requestId?: string;
    };

export async function arkChatCompletion(opts: {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logPrefix: string;
  maxAttempts?: number;
  reviewModeLog?: { label: string; modeKey: string };
  /** 方舟模型 ID，见 lib/ark-models.ts */
  arkModelId?: string;
}): Promise<ArkChatResult> {
  const { apiKey, baseUrl, modelDef } = getArkRuntimeConfig(opts.arkModelId);
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      detail: "未配置豆包/方舟 API Key：请设置环境变量 ARK_API_KEY 或 DOUBAO_API_KEY",
    };
  }

  if (modelDef.api === "responses") {
    return arkResponsesCompletion({ ...opts, baseUrl, modelDef, apiKey });
  }

  const url = `${baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model: modelDef.id,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });

  const MAX_ATTEMPTS = opts.maxAttempts ?? 3;

  console.log(`${opts.logPrefix} ========== AI 请求开始 ==========`);
  console.log(`${opts.logPrefix} provider: 豆包`);
  console.log(`${opts.logPrefix} URL:`, url);
  console.log(`${opts.logPrefix} Model:`, modelDef.id, `(api: chat)`);
  if (opts.reviewModeLog) {
    console.log(
      `${opts.logPrefix} Review mode:`,
      opts.reviewModeLog.label,
      `(${opts.reviewModeLog.modeKey})`,
    );
  }
  console.log(`${opts.logPrefix} Temperature:`, opts.temperature);
  console.log(`${opts.logPrefix} API Key (前6/后4):`, apiKey.slice(0, 6) + "…" + apiKey.slice(-4));
  console.log(`${opts.logPrefix} Request body 总长:`, body.length, "字符");
  console.log(`${opts.logPrefix} ---------- System Prompt ----------`);
  console.log(opts.system);
  console.log(`${opts.logPrefix} ---------- User Message ----------`);
  console.log(opts.user);
  console.log(`${opts.logPrefix} ---------- 提示词结束 ----------`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let responseText = "";
    let data: OpenAIChatCompletionResponse | null = null;
    let status = 500;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      status = res.status;
      responseText = await res.text();
      try {
        data = JSON.parse(responseText) as OpenAIChatCompletionResponse;
      } catch {
        data = null;
      }

      console.log(`${opts.logPrefix} ---------- AI 响应 ----------`);
      console.log(
        `${opts.logPrefix} HTTP 状态:`,
        res.status,
        " 响应长度:",
        responseText.length,
        "字符",
      );
      console.log(`${opts.logPrefix} 响应体（原始 JSON）:`);
      console.log(responseText);

      if (res.ok) {
        const text = data ? extractOpenAIAssistantText(data) : "";
        if (!text.trim()) {
          return {
            ok: false,
            status: 502,
            detail: data?.error?.message ?? "模型未返回文本内容",
            requestId: data?.id,
          };
        }
        return { ok: true, text };
      }

      const detail =
        data?.error?.message ??
        responseText.slice(0, 500);

      if (attempt < MAX_ATTEMPTS && isArkRetryable(status)) {
        const reqId = data?.id ?? "unknown";
        console.log(
          `${opts.logPrefix} 上游瞬时错误，准备第 ${attempt + 1}/${MAX_ATTEMPTS} 次重试；id=${reqId}`,
        );
        await sleep(500 * attempt);
        continue;
      }

      console.log(`${opts.logPrefix} ========== AI 请求结束（上游失败） ==========`);
      return {
        ok: false,
        status,
        detail,
        requestId: data?.id,
      };
    } catch (e) {
      const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
      const msg = isTimeout
        ? `方舟接口超时（${opts.timeoutMs / 1000}s）`
        : e instanceof Error
          ? e.message
          : String(e);
      if (attempt < MAX_ATTEMPTS && !isTimeout) {
        console.log(
          `${opts.logPrefix} 请求异常，准备第 ${attempt + 1}/${MAX_ATTEMPTS} 次重试:`,
          msg,
        );
        await sleep(500 * attempt);
        continue;
      }
      console.log(`${opts.logPrefix} ========== AI 请求结束（异常） ==========`);
      return {
        ok: false,
        status: isTimeout ? 504 : 500,
        detail: msg,
      };
    }
  }

  console.log(`${opts.logPrefix} ========== AI 请求结束（重试次数用尽） ==========`);
  return { ok: false, status: 502, detail: "方舟请求重试次数用尽" };
}

async function arkResponsesCompletion(opts: {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logPrefix: string;
  maxAttempts?: number;
  reviewModeLog?: { label: string; modeKey: string };
  baseUrl: string;
  modelDef: ArkModelDefinition;
  apiKey: string;
}): Promise<ArkChatResult> {
  const url = `${opts.baseUrl}/responses`;
  /** 官方示例多为单条 user；合并 system 与任务输入，避免部分模型对 system 角色支持不一致 */
  const combinedUserText = `【系统与规范】\n${opts.system}\n\n【本页任务输入】\n${opts.user}`;
  const payload: Record<string, unknown> = {
    model: opts.modelDef.id,
    stream: false,
    temperature: opts.temperature,
    max_output_tokens: opts.maxTokens,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: combinedUserText }],
      },
    ],
  };
  if (opts.modelDef.disableResponsesThinking) {
    payload.thinking = { type: "disabled" };
  }
  const body = JSON.stringify(payload);

  const MAX_ATTEMPTS = opts.maxAttempts ?? 3;

  console.log(`${opts.logPrefix} ========== AI 请求开始 ==========`);
  console.log(`${opts.logPrefix} provider: 豆包`);
  console.log(`${opts.logPrefix} URL:`, url);
  console.log(`${opts.logPrefix} Model:`, opts.modelDef.id, `(api: responses)`);
  if (opts.modelDef.disableResponsesThinking) {
    console.log(`${opts.logPrefix} thinking: disabled (GLM 等关闭推理)`);
  }
  if (opts.reviewModeLog) {
    console.log(
      `${opts.logPrefix} Review mode:`,
      opts.reviewModeLog.label,
      `(${opts.reviewModeLog.modeKey})`,
    );
  }
  console.log(`${opts.logPrefix} Temperature:`, opts.temperature);
  console.log(`${opts.logPrefix} API Key (前6/后4):`, opts.apiKey.slice(0, 6) + "…" + opts.apiKey.slice(-4));
  console.log(`${opts.logPrefix} Request body 总长:`, body.length, "字符");
  console.log(`${opts.logPrefix} ---------- System Prompt ----------`);
  console.log(opts.system);
  console.log(`${opts.logPrefix} ---------- User Message ----------`);
  console.log(opts.user);
  console.log(`${opts.logPrefix} ---------- 提示词结束 ----------`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let responseText = "";
    let data: ArkResponsesApiResponse | null = null;
    let status = 500;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      status = res.status;
      responseText = await res.text();
      try {
        data = JSON.parse(responseText) as ArkResponsesApiResponse;
      } catch {
        data = null;
      }

      console.log(`${opts.logPrefix} ---------- AI 响应 ----------`);
      console.log(
        `${opts.logPrefix} HTTP 状态:`,
        res.status,
        " 响应长度:",
        responseText.length,
        "字符",
      );
      console.log(`${opts.logPrefix} 响应体（原始 JSON）:`);
      console.log(responseText);

      if (res.ok) {
        const text = data ? extractResponsesAssistantText(data) : "";
        if (!text.trim()) {
          const errMsg =
            data?.error?.message ??
            (data?.status && data.status !== "completed"
              ? `响应状态: ${data.status}`
              : "模型未返回文本内容");
          return {
            ok: false,
            status: 502,
            detail: errMsg,
            requestId: data?.id,
          };
        }
        return { ok: true, text };
      }

      const detail =
        data?.error?.message ??
        responseText.slice(0, 500);

      if (attempt < MAX_ATTEMPTS && isArkRetryable(status)) {
        const reqId = data?.id ?? "unknown";
        console.log(
          `${opts.logPrefix} 上游瞬时错误，准备第 ${attempt + 1}/${MAX_ATTEMPTS} 次重试；id=${reqId}`,
        );
        await sleep(500 * attempt);
        continue;
      }

      console.log(`${opts.logPrefix} ========== AI 请求结束（上游失败） ==========`);
      return {
        ok: false,
        status,
        detail,
        requestId: data?.id,
      };
    } catch (e) {
      const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
      const msg = isTimeout
        ? `方舟接口超时（${opts.timeoutMs / 1000}s）`
        : e instanceof Error
          ? e.message
          : String(e);
      if (attempt < MAX_ATTEMPTS && !isTimeout) {
        console.log(
          `${opts.logPrefix} 请求异常，准备第 ${attempt + 1}/${MAX_ATTEMPTS} 次重试:`,
          msg,
        );
        await sleep(500 * attempt);
        continue;
      }
      console.log(`${opts.logPrefix} ========== AI 请求结束（异常） ==========`);
      return {
        ok: false,
        status: isTimeout ? 504 : 500,
        detail: msg,
      };
    }
  }

  console.log(`${opts.logPrefix} ========== AI 请求结束（重试次数用尽） ==========`);
  return { ok: false, status: 502, detail: "方舟请求重试次数用尽" };
}
