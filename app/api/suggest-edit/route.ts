import { NextResponse } from "next/server";
import { z } from "zod";

import { EDITOR_PUBLISHING_SPEC } from "@/lib/editor-spec";
import { readMinimaxLocalConfig } from "@/lib/minimax-local-config";
import { normalizeIssueKind, repairJsonStringInnerQuotes } from "@/lib/review-types";

const DEFAULT_ANTHROPIC_BASE = "https://api.minimaxi.com/anthropic";

const bodySchema = z.object({
  excerpt: z.string().min(1).max(500),
  pageText: z.string().min(1).max(50000),
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
- suggestion 尽量短、直接、可落地
- reason 用一句话说明原因
- 不要输出 Markdown，不要代码围栏

返回 JSON：
{"suggestion":"建议修改为：xxx","reason":"一句话原因","kind":"error 或 suspected"}`.trim();

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: string; text?: string };

type AnthropicMessagesResponse = {
  content?: AnthropicContentBlock[];
  error?: { type?: string; message?: string };
  message?: string;
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

  const { excerpt, pageText } = parsed.data;
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
  const model =
    process.env.MINIMAX_MODEL?.trim() ||
    local.model ||
    "MiniMax-M2.1";
  const anthropicVersion =
    process.env.ANTHROPIC_VERSION?.trim() ||
    local.anthropicVersion ||
    "2023-06-01";

  if (!apiKey) {
    return NextResponse.json({ error: "未配置 API Key" }, { status: 503 });
  }

  const userContent = `--- 当前摘录 ---\n${excerpt}\n\n--- 页面文本 ---\n${pageText}`;
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

    const responseText = await res.text();
    console.log("[suggest-edit] ---------- AI 响应 ----------");
    console.log("[suggest-edit] HTTP 状态:", res.status, " 响应长度:", responseText.length, "字符");
    console.log("[suggest-edit] 响应原文:");
    console.log(responseText);
    let data: AnthropicMessagesResponse;
    try {
      data = JSON.parse(responseText) as AnthropicMessagesResponse;
    } catch {
      return NextResponse.json(
        { error: "模型返回非 JSON", detail: responseText.slice(0, 600) },
        { status: 502 },
      );
    }

    if (!res.ok) {
      const detail =
        data.error?.message ??
        data.message ??
        JSON.stringify(data).slice(0, 500);
      return NextResponse.json(
        { error: "模型接口错误", status: res.status, detail },
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
