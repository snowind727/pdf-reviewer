import { NextResponse } from "next/server";
import { z } from "zod";

import { EDITOR_PUBLISHING_SPEC } from "@/lib/editor-spec";
import { readMinimaxLocalConfig } from "@/lib/minimax-local-config";
import { normalizeIssueKind, repairJsonStringInnerQuotes } from "@/lib/review-types";
import { arkChatCompletion } from "@/lib/volcengine-ark";

const DEFAULT_ANTHROPIC_BASE = "https://api.minimaxi.com/anthropic";
const DEFAULT_MODEL = "MiniMax-M2.7";
const SUPPORTED_ANTHROPIC_MODELS = new Set([
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2.1-highspeed",
  "MiniMax-M2",
]);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(["1000", "1001", "1002", "1024", "1033"]);

const bodySchema = z.object({
  excerpt: z.string().min(1).max(500),
  pageText: z.string().min(1).max(50000),
  provider: z.enum(["minimax", "doubao"]).optional(),
});

const suggestSchema = z.object({
  suggestion: z.string(),
  reason: z.string().optional(),
  kind: z.string().optional(),
});

const SYSTEM = `${EDITOR_PUBLISHING_SPEC}

---

当前任务：用户会给你当前页全文，以及编辑手动框选的一段摘录。请只针对这段摘录给出一条最可执行的修改建议。

要求：
- 只聚焦该摘录，不要输出整页多条问题
- 若该摘录明显存在语病、搭配不当、错别字、标点或表达问题，给出直接可执行的修改建议
- 若问题不够确定，可将 kind 设为 suspected；也允许写中文「错误」「疑似」，程序会自动归一
- suggestion 只写正确内容或具体改法，不要解释原因，不要复述规则，不要写分析过程
- suggestion 尽量短、直接、可落地；例如「改为：xxx」「删除：|」「将『A』改为『B』」
- reason 用一句话简要说明原因，便于折叠展示
- 不要输出 Markdown，不要代码围栏

返回 JSON：
{"suggestion":"改为：xxx","reason":"一句话原因","kind":"error 或 suspected"}`.trim();

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: string; text?: string };

type AnthropicMessagesResponse = {
  content?: AnthropicContentBlock[];
  error?: { type?: string; message?: string };
  message?: string;
  request_id?: string;
};

function extractTextFromAnthropicMessage(data: AnthropicMessagesResponse): string {
  if (!Array.isArray(data.content)) return "";
  return data.content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMiniMaxErrorCode(data: AnthropicMessagesResponse | null, responseText: string): string | null {
  const haystack = [data?.error?.message, data?.message, responseText]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" ");
  const matched = haystack.match(/\((\d+)\)/);
  return matched?.[1] ?? null;
}

function isRetryableFailure(
  status: number,
  data: AnthropicMessagesResponse | null,
  responseText: string,
): boolean {
  const errorCode = parseMiniMaxErrorCode(data, responseText);
  return RETRYABLE_STATUS.has(status) || (errorCode ? RETRYABLE_ERROR_CODES.has(errorCode) : false);
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "参数无效", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { excerpt, pageText, provider = "minimax" } = parsed.data;
  const userContent = `--- 当前摘录 ---\n${excerpt}\n\n--- 页面文本 ---\n${pageText}`;

  if (provider === "doubao") {
    try {
      const ark = await arkChatCompletion({
        system: SYSTEM,
        user: userContent,
        maxTokens: 1200,
        temperature: 0.2,
        timeoutMs: 120_000,
        logPrefix: "[suggest-edit]",
      });

      if (!ark.ok) {
        const statusOut =
          ark.status === 503 ? 503 : ark.status === 504 ? 504 : 502;
        if (ark.status === 503) {
          return NextResponse.json({ error: ark.detail }, { status: 503 });
        }
        return NextResponse.json(
          {
            error: "模型接口错误",
            status: ark.status,
            detail: ark.detail,
            requestId: ark.requestId,
          },
          { status: statusOut },
        );
      }

      const raw = ark.text.trim();
      if (!raw) {
        return NextResponse.json({ error: "模型未返回文本内容" }, { status: 502 });
      }
      console.log("[suggest-edit] AI 模型输出文本（", raw.length, "字符）:");
      console.log(raw);

      let parsedSuggestion: unknown;
      try {
        parsedSuggestion = JSON.parse(raw);
      } catch (first) {
        try {
          parsedSuggestion = JSON.parse(repairJsonStringInnerQuotes(raw));
        } catch {
          throw first;
        }
      }

      const result = suggestSchema.parse(parsedSuggestion);
      const normalizedKind = normalizeIssueKind({
        excerpt,
        reason: result.reason ?? "",
        suggestion: result.suggestion,
        severity: result.kind,
      });
      console.log("[suggest-edit] 解析成功:", {
        suggestion: result.suggestion.trim(),
        reason: result.reason?.trim() ?? "",
        kind: normalizedKind,
      });
      console.log("[suggest-edit] ========== AI 请求结束（成功） ==========");
      return NextResponse.json({
        suggestion: result.suggestion.trim(),
        reason: result.reason?.trim() ?? "",
        kind: normalizedKind,
      });
    } catch (e) {
      const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
      const isZod = e instanceof z.ZodError;
      const message = isTimeout
        ? "AI 建议超时，请重试"
        : isZod
          ? `AI 返回结构不符合预期：${e.issues.map((x) => x.message).join("；")}`
          : e instanceof Error
            ? e.message
            : String(e);
      console.log("[suggest-edit] 请求异常:", message);
      return NextResponse.json(
        { error: message },
        { status: isTimeout ? 504 : 500 },
      );
    }
  }

  const local = readMinimaxLocalConfig();
  const apiKey =
    process.env.MINIMAX_API_KEY?.trim() ||
    process.env.AI_API_KEY?.trim() ||
    local.apiKey;
  const base = (
    process.env.MINIMAX_ANTHROPIC_BASE?.trim() ||
    local.anthropicBase ||
    DEFAULT_ANTHROPIC_BASE
  ).replace(/\/$/, "");
  const configuredModel =
    process.env.MINIMAX_MODEL?.trim() ||
    local.model ||
    DEFAULT_MODEL;
  const model = SUPPORTED_ANTHROPIC_MODELS.has(configuredModel)
    ? configuredModel
    : DEFAULT_MODEL;
  const anthropicVersion =
    process.env.ANTHROPIC_VERSION?.trim() ||
    local.anthropicVersion ||
    "2023-06-01";

  if (configuredModel !== model) {
    console.log(
      `[suggest-edit] 配置模型 ${configuredModel} 不在 Anthropic 兼容接口支持列表内，已自动回退到 ${model}`,
    );
  }

  if (!apiKey) {
    return NextResponse.json({ error: "未配置 API Key" }, { status: 503 });
  }

  const url = `${base}/v1/messages`;
  const anthropicBody = {
    model,
    max_tokens: 1200,
    temperature: 0.2,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userContent }],
      },
    ],
  };
  const bodyStr = JSON.stringify(anthropicBody);

  try {
    console.log("[suggest-edit] ========== AI 请求开始 ==========");
    console.log("[suggest-edit] URL:", url);
    console.log("[suggest-edit] Model:", model);
    console.log("[suggest-edit] anthropic-version:", anthropicVersion);
    console.log("[suggest-edit] API Key (前6/后4):", apiKey.slice(0, 6) + "…" + apiKey.slice(-4));
    console.log("[suggest-edit] Request body 总长:", bodyStr.length, "字符");
    console.log("[suggest-edit] ---------- System Prompt ----------");
    console.log(SYSTEM);
    console.log("[suggest-edit] ---------- User Message ----------");
    console.log(userContent);
    console.log("[suggest-edit] ---------- 提示词结束 ----------");

    const MAX_ATTEMPTS = 3;
    let responseText = "";
    let data: AnthropicMessagesResponse | null = null;
    let status = 500;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": anthropicVersion,
        },
        body: bodyStr,
        signal: AbortSignal.timeout(120_000),
      });

      status = res.status;
      responseText = await res.text();
      console.log("[suggest-edit] ---------- AI 响应 ----------");
      console.log("[suggest-edit] HTTP 状态:", res.status, " 响应长度:", responseText.length, "字符");

      try {
        data = JSON.parse(responseText) as AnthropicMessagesResponse;
      } catch {
        data = null;
      }

      if (res.ok) break;

      if (attempt < MAX_ATTEMPTS && isRetryableFailure(res.status, data, responseText)) {
        const requestId = data?.request_id ?? "unknown";
        console.log(
          `[suggest-edit] 上游瞬时错误，准备第 ${attempt + 1}/${MAX_ATTEMPTS} 次重试；request_id=${requestId}`,
        );
        await sleep(500 * attempt);
        continue;
      }

      return NextResponse.json(
        {
          error: "模型接口错误",
          status: res.status,
          detail:
            data?.error?.message ??
            data?.message ??
            responseText.slice(0, 500),
          requestId: data?.request_id,
        },
        { status: 502 },
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: "模型返回非 JSON", detail: responseText.slice(0, 600) },
        { status: 502 },
      );
    }

    if (status < 200 || status >= 300) {
      return NextResponse.json(
        {
          error: "模型接口错误",
          status,
          detail: data.error?.message ?? data.message ?? JSON.stringify(data).slice(0, 500),
          requestId: data.request_id,
        },
        { status: 502 },
      );
    }

    const raw = extractTextFromAnthropicMessage(data).trim();
    if (!raw) {
      console.log("[suggest-edit] AI 解析：content 中无 text 块");
      return NextResponse.json({ error: "模型未返回文本内容" }, { status: 502 });
    }
    console.log("[suggest-edit] AI 模型输出文本（", raw.length, "字符）:");
    console.log(raw);

    let parsedSuggestion: unknown;
    try {
      parsedSuggestion = JSON.parse(raw);
    } catch (first) {
      try {
        parsedSuggestion = JSON.parse(repairJsonStringInnerQuotes(raw));
      } catch {
        throw first;
      }
    }

    const result = suggestSchema.parse(parsedSuggestion);
    const normalizedKind = normalizeIssueKind({
      excerpt,
      reason: result.reason ?? "",
      suggestion: result.suggestion,
      severity: result.kind,
    });
    console.log("[suggest-edit] 解析成功:", {
      suggestion: result.suggestion.trim(),
      reason: result.reason?.trim() ?? "",
      kind: normalizedKind,
    });
    console.log("[suggest-edit] ========== AI 请求结束（成功） ==========");
    return NextResponse.json({
      suggestion: result.suggestion.trim(),
      reason: result.reason?.trim() ?? "",
      kind: normalizedKind,
    });
  } catch (e) {
    const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
    const isZod = e instanceof z.ZodError;
    const message = isTimeout
      ? "AI 建议超时，请重试"
      : isZod
        ? `AI 返回结构不符合预期：${e.issues.map((x) => x.message).join("；")}`
        : e instanceof Error
          ? e.message
          : String(e);
    console.log("[suggest-edit] 请求异常:", message);
    console.log("[suggest-edit] 异常类型:", (e as Error)?.constructor?.name, "name:", (e as Error)?.name);
    console.log("[suggest-edit] ========== AI 请求结束（异常） ==========");
    return NextResponse.json(
      { error: message },
      { status: isTimeout ? 504 : 500 },
    );
  }
}
