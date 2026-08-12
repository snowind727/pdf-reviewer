/**
 * DeepSeek API：OpenAI 兼容的 Chat Completions 接口。
 *
 * 官方文档：
 * https://api-docs.deepseek.com/api/create-chat-completion
 */

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL_ID = "deepseek-v4-flash";

type DeepSeekResponse = {
  id?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

export type DeepSeekChatResult =
  | { ok: true; text: string }
  | {
      ok: false;
      status: number;
      detail: string;
      requestId?: string;
    };

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractAssistantText(data: DeepSeekResponse): string {
  const content = data.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export async function deepseekChatCompletion(opts: {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  logPrefix: string;
  maxAttempts?: number;
}): Promise<DeepSeekChatResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const baseUrl = (
    process.env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULT_BASE_URL
  ).replace(/\/$/, "");
  const model =
    process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_DEFAULT_MODEL_ID;

  if (!apiKey || apiKey === "YOUR_DEEPSEEK_API_KEY_HERE") {
    return {
      ok: false,
      status: 503,
      detail: "未配置 DeepSeek API Key：请设置环境变量 DEEPSEEK_API_KEY",
    };
  }

  const url = `${baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    stream: false,
  });
  const maxAttempts = opts.maxAttempts ?? 3;

  console.log(`${opts.logPrefix} ========== DeepSeek 请求开始 ==========`);
  console.log(`${opts.logPrefix} URL:`, url);
  console.log(`${opts.logPrefix} Model:`, model);
  console.log(`${opts.logPrefix} Request body 总长:`, body.length, "字符");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let responseText = "";
    let data: DeepSeekResponse | null = null;
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
        data = JSON.parse(responseText) as DeepSeekResponse;
      } catch {
        data = null;
      }

      console.log(
        `${opts.logPrefix} HTTP 状态:`,
        status,
        "响应长度:",
        responseText.length,
        "字符",
      );

      if (res.ok) {
        const text = data ? extractAssistantText(data) : "";
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

      const detail = data?.error?.message ?? responseText.slice(0, 500);
      if (attempt < maxAttempts && RETRYABLE_STATUS.has(status)) {
        console.log(
          `${opts.logPrefix} 上游瞬时错误，准备第 ${attempt + 1}/${maxAttempts} 次重试`,
        );
        await sleep(500 * attempt);
        continue;
      }

      return {
        ok: false,
        status,
        detail,
        requestId: data?.id,
      };
    } catch (e) {
      const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
      const message = isTimeout
        ? `DeepSeek 接口超时（${opts.timeoutMs / 1000}s）`
        : e instanceof Error
          ? e.message
          : String(e);

      if (attempt < maxAttempts && !isTimeout) {
        console.log(
          `${opts.logPrefix} 请求异常，准备第 ${attempt + 1}/${maxAttempts} 次重试:`,
          message,
        );
        await sleep(500 * attempt);
        continue;
      }

      return {
        ok: false,
        status: isTimeout ? 504 : 500,
        detail: message,
      };
    }
  }

  return { ok: false, status: 502, detail: "DeepSeek 请求重试次数用尽" };
}
