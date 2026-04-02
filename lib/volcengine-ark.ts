/** 火山引擎方舟 OpenAI 兼容 Chat Completions（豆包等） */

const DEFAULT_ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_ARK_MODEL = "doubao-1-5-pro-32k-250115";

const ARK_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

export type OpenAIChatCompletionResponse = {
  choices?: Array<{ message?: { role?: string; content?: string | null } }>;
  error?: { message?: string; type?: string; code?: string };
  id?: string;
};

export function getArkRuntimeConfig(): {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
} {
  const apiKey =
    process.env.ARK_API_KEY?.trim() || process.env.DOUBAO_API_KEY?.trim();
  const baseUrl = (process.env.ARK_BASE_URL?.trim() || DEFAULT_ARK_BASE).replace(
    /\/$/,
    "",
  );
  const model = process.env.ARK_MODEL?.trim() || DEFAULT_ARK_MODEL;
  return { apiKey, baseUrl, model };
}

export function extractOpenAIAssistantText(
  data: OpenAIChatCompletionResponse,
): string {
  const c = data.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
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

/**
 * 非流式 chat/completions，带有限次重试。
 * 日志格式与 MiniMax（Anthropic 兼容）分支对齐。
 */
export async function arkChatCompletion(opts: {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logPrefix: string;
  maxAttempts?: number;
  reviewModeLog?: { label: string; modeKey: string };
}): Promise<ArkChatResult> {
  const { apiKey, baseUrl, model } = getArkRuntimeConfig();
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      detail: "未配置豆包/方舟 API Key：请设置环境变量 ARK_API_KEY 或 DOUBAO_API_KEY",
    };
  }

  const url = `${baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model,
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
  console.log(`${opts.logPrefix} Model:`, model);
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
