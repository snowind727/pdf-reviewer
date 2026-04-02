import { NextResponse } from "next/server";
import { z } from "zod";
import { readMinimaxLocalConfig } from "@/lib/minimax-local-config";
import { normalizeIssueKind, parseReviewJson } from "@/lib/review-types";
import { arkChatCompletion } from "@/lib/volcengine-ark";
import { EDITOR_PUBLISHING_SPEC } from "@/lib/editor-spec";

/** 国内文档默认基址：https://platform.minimaxi.com/docs/api-reference/text-anthropic-api */
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
/** 含 529：部分上游在负载高时返回 529，与 MiniMax overloaded 类错误 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const RETRYABLE_ERROR_CODES = new Set(["1000", "1001", "1002", "1024", "1033"]);
const reviewModeSchema = z.enum(["precise", "discover-more"]);

const bodySchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  text: z.string().max(50000),
  mode: reviewModeSchema.optional(),
  provider: z.enum(["minimax", "doubao"]).optional(),
});

/** 任务指令 + JSON 输出格式（与编辑规范拼接组成完整 system prompt） */
const TASK_INSTRUCTIONS = `
---

当前任务：用户会提供 **PDF 某一页** 的纯文本（保留了原始排版的换行与段落）。请在该页范围内，依据以上规范发现问题并给出修改建议。单页无法核实的项（如全书术语统一、参考文献全文）请标 kind 为 suspected 并说明需扩展核对范围。

必须只输出一个 JSON 对象，不要 Markdown，不要代码围栏。
**JSON 语法硬性要求**：excerpt、suggestion、reason 等所有字符串值内禁止使用未转义的英文双引号 "（会破坏解析）。如需给词加引号，请用中文直角引号「」『』或书名号《》，或写成「改为：坚持生态优先」而不要用 "坚持生态优先"。

**摘录与原文标点一致（极其重要）**：
- 字段 excerpt 必须是你在「页面文本」里能搜到的**连续子串**，须与原文**逐字相同**，包括**一切标点与引号**：中文直角引号「」『』、弯引号“”‘’、书名号《》、顿号、全角符号等，均须与页面文本一致。
- **禁止**为了「规范」而把原文里的中文引号改成英文直引号 " 或 '；**禁止**在 excerpt 里自行改写标点后再匹配。例如页面里是「贵州省创新「村BA」「村超」模式」或类似写法，excerpt 必须按页面文本原样摘录，不能把其中的「」改成 "。
- 若问题与引号嵌套有关，仍须在 excerpt 中保留页面上的**实际字符**；仅在 suggestion、reason 中说明建议改成何种引号格式（那里用「」表述即可）。

结构为：
{"issues":[
  {
    "excerpt":"用于在页面上精确标出的最短连续原文，必须逐字来自本页文本（忽略换行符）。只包含有问题的字、词或标点，不要包含前后无关的标题或整句（例如只删「|」则 excerpt 仅为「|」，不要写成「| 编写说明」）",
    "kind":"error 或 suspected",
    "suggestion":"修改意见，用简短可操作的中文。删除类请写清对象，例如：删除字符：|；替换类：建议替换为：xxx",
    "reason":"一句话说明为何是问题（可选补充），可引用上述规范中的具体条款或标准名称"
  }
]}

字段说明：
- excerpt 越短越好，且须与页面文本逐字一致（忽略换行）。程序会用 excerpt 在 PDF 文本层中搜索并高亮对应位置。扫描件常见 l/| 混淆时，可写你看到的字形；程序会尝试少量等价字形匹配。
- excerpt 必须是从「页面文本」中直接复制出的原文，不能脑补、不能纠正错别字后再填写、不能把「地」改成「的」或把原文没有的字补进去。例如原文是「并诚挚地欢迎」，excerpt 不能写成「诚挚的欢迎」。
- excerpt 中的**引号、括号、书名号**必须与页面文本**字符级一致**：不要把页面里的「」改成 "，也不要把 " 改成「」，除非页面文本里本来就是该字符。
- kind 必填：error 表示确定错误（严重/明确）；suspected 表示疑似错误（不确定、需人工复核）。
- suggestion 必填：给用户可直接执行的修改建议；删除类务必写「删除字符：具体字符/串」，程序会在摘录匹配到的区间内只标该片段，避免整段被圈红。
若无问题，返回 {"issues":[]}。`;

const REVIEW_MODE_CONFIG = {
  precise: {
    label: "精确查找",
    temperature: 0.2,
    extraInstructions: `
---

审稿模式：精确查找
- 保持保守，只返回必要的确定错误
- 对 suspected 项提高门槛；只有当疑点比较明确、确实值得人工复核时才返回
- 不要为了“覆盖更多问题”而勉强输出疑似项
- 若某条问题把握不足，宁可不报，也不要凑数`,
  },
  "discover-more": {
    label: "发现更多",
    temperature: 0.45,
    extraInstructions: `
---

审稿模式：发现更多
- 在保证基本合理的前提下，除必要的确定错误外，尽可能多发现值得人工复核的 suspected 项
- 对存在一定依据、但仍需人工确认的用法、统一性、措辞、格式、术语、标点问题，可更积极地标为 suspected
- 可以比默认模式返回更多 suspected，但不要编造原文中不存在的问题`,
  },
} as const;

type ReviewMode = keyof typeof REVIEW_MODE_CONFIG;

function buildSystemPrompt(mode: ReviewMode): string {
  return `${EDITOR_PUBLISHING_SPEC}\n${TASK_INSTRUCTIONS.trim()}${REVIEW_MODE_CONFIG[mode].extraInstructions}`;
}

/** Anthropic Messages API 响应（MiniMax 兼容层，非流式） */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: string; text?: string };

type AnthropicMessagesResponse = {
  content?: AnthropicContentBlock[];
  type?: string;
  message?: string;
  request_id?: string;
  error?: { type?: string; message?: string };
};

function extractTextFromAnthropicMessage(data: AnthropicMessagesResponse): string {
  if (!Array.isArray(data.content)) return "";
  return data.content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof b.text === "string"
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
  if (data?.error?.type === "overloaded_error") return true;
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
      { status: 400 }
    );
  }

  const { text, mode = "precise", provider = "minimax" } = parsed.data;

  const systemPrompt = buildSystemPrompt(mode);
  const temperature = REVIEW_MODE_CONFIG[mode].temperature;
  const userContent = `--- 页面文本 ---\n${text}`;

  if (!text.trim()) {
    return NextResponse.json(
      { issues: [], notice: "本页无可用文本层，无法精确定位；可更换为可复制文本的 PDF。" },
      { status: 200 },
    );
  }

  if (provider === "doubao") {
    try {
      const ark = await arkChatCompletion({
        system: systemPrompt,
        user: userContent,
        maxTokens: 8192,
        temperature,
        timeoutMs: 120_000,
        logPrefix: "[review-page]",
        reviewModeLog: {
          label: REVIEW_MODE_CONFIG[mode].label,
          modeKey: mode,
        },
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

      const raw = ark.text;
      console.log("[review-page] AI 模型输出文本（", raw.length, "字符）:");
      console.log(raw);

      try {
        const review = parseReviewJson(raw);
        const normalized = {
          issues: review.issues.map((issue) => ({
            excerpt: issue.excerpt,
            reason: issue.reason,
            suggestion: issue.suggestion?.trim() || "",
            kind: normalizeIssueKind(issue),
          })),
        };
        console.log("[review-page] 解析成功，issues:", normalized.issues.length, "条");
        console.log("[review-page] ========== AI 请求结束（成功） ==========");
        return NextResponse.json(normalized);
      } catch (parseErr) {
        console.log(
          "[review-page] JSON 解析失败:",
          parseErr instanceof Error ? parseErr.message : parseErr,
        );
        return NextResponse.json(
          { error: "模型返回的 JSON 无法解析", raw: raw.slice(0, 800) },
          { status: 502 },
        );
      }
    } catch (e) {
      const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
      const isAbort = e instanceof DOMException && e.name === "AbortError";
      const rawMsg = e instanceof Error ? e.message : String(e);
      const cause = (e as { cause?: unknown })?.cause;
      const causeMsg = cause instanceof Error ? ` [cause: ${cause.message}]` : "";
      const message = isTimeout
        ? `AI 接口超时（120s），请重试`
        : isAbort
          ? "请求被取消"
          : rawMsg + causeMsg;

      console.log("[review-page] 请求异常:", message);
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
      `[review-page] 配置模型 ${configuredModel} 不在 Anthropic 兼容接口支持列表内，已自动回退到 ${model}`,
    );
  }

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "未配置 API Key：请在仓库根目录复制 minimax.local.example.json 为 minimax.local.json 并填写 apiKey，或设置环境变量 MINIMAX_API_KEY",
      },
      { status: 503 },
    );
  }

  const url = `${base}/v1/messages`;

  const anthropicBody = {
    model,
    max_tokens: 8192,
    temperature,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userContent }],
      },
    ],
  };

  const bodyStr = JSON.stringify(anthropicBody);

  console.log("[review-page] ========== AI 请求开始 ==========");
  console.log("[review-page] URL:", url);
  console.log("[review-page] Model:", model);
  console.log("[review-page] Review mode:", REVIEW_MODE_CONFIG[mode].label, `(${mode})`);
  console.log("[review-page] Temperature:", temperature);
  console.log("[review-page] anthropic-version:", anthropicVersion);
  console.log("[review-page] API Key (前6/后4):", apiKey.slice(0, 6) + "…" + apiKey.slice(-4));
  console.log("[review-page] Request body 总长:", bodyStr.length, "字符");
  console.log("[review-page] ---------- System Prompt ----------");
  console.log(systemPrompt);
  console.log("[review-page] ---------- User Message ----------");
  console.log(userContent);
  console.log("[review-page] ---------- 提示词结束 ----------");

  const TIMEOUT_MS = 120_000;

  try {
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      status = res.status;
      responseText = await res.text();

      console.log("[review-page] ---------- AI 响应 ----------");
      console.log("[review-page] HTTP 状态:", res.status, " 响应长度:", responseText.length, "字符");

      try {
        data = JSON.parse(responseText) as AnthropicMessagesResponse;
      } catch {
        data = null;
      }

      if (res.ok) break;

      if (attempt < MAX_ATTEMPTS && isRetryableFailure(res.status, data, responseText)) {
        const requestId = data?.request_id ?? "unknown";
        console.log(
          `[review-page] 上游瞬时错误，准备第 ${attempt + 1}/${MAX_ATTEMPTS} 次重试；request_id=${requestId}`,
        );
        await sleep(500 * attempt);
        continue;
      }

      const detail =
        data?.error?.message ??
        data?.message ??
        responseText.slice(0, 500);
      return NextResponse.json(
        {
          error: "模型接口错误",
          status: res.status,
          detail,
          requestId: data?.request_id,
        },
        { status: 502 }
      );
    }

    if (!data) {
      return NextResponse.json(
        {
          error: "模型返回非 JSON",
          detail: responseText.slice(0, 600),
        },
        { status: 502 }
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
        { status: 502 }
      );
    }

    const raw = extractTextFromAnthropicMessage(data);
    if (!raw.trim()) {
      console.log("[review-page] AI 解析：content 中无 text 块");
      return NextResponse.json({ error: "模型未返回文本内容" }, { status: 502 });
    }

    console.log("[review-page] AI 模型输出文本（", raw.length, "字符）:");
    console.log(raw);

    try {
      const review = parseReviewJson(raw);
      const normalized = {
        issues: review.issues.map((issue) => ({
          excerpt: issue.excerpt,
          reason: issue.reason,
          suggestion: issue.suggestion?.trim() || "",
          kind: normalizeIssueKind(issue),
        })),
      };
      console.log("[review-page] 解析成功，issues:", normalized.issues.length, "条");
      console.log("[review-page] ========== AI 请求结束（成功） ==========");
      return NextResponse.json(normalized);
    } catch (parseErr) {
      console.log("[review-page] JSON 解析失败:", parseErr instanceof Error ? parseErr.message : parseErr);
      return NextResponse.json(
        { error: "模型返回的 JSON 无法解析", raw: raw.slice(0, 800) },
        { status: 502 }
      );
    }
  } catch (e) {
    const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    const raw = e instanceof Error ? e.message : String(e);
    const cause = (e as { cause?: unknown })?.cause;
    const causeMsg = cause instanceof Error ? ` [cause: ${cause.message}]` : "";
    const message = isTimeout
      ? `AI 接口超时（${TIMEOUT_MS / 1000}s），请重试`
      : isAbort
        ? "请求被取消"
        : raw + causeMsg;

    console.log("[review-page] 请求异常:", message);
    console.log("[review-page] 异常类型:", (e as Error)?.constructor?.name, "name:", (e as Error)?.name);
    if (cause) console.log("[review-page] 异常 cause:", cause);
    console.log("[review-page] ========== AI 请求结束（异常） ==========");

    return NextResponse.json(
      { error: message },
      { status: isTimeout ? 504 : 500 },
    );
  }
}
