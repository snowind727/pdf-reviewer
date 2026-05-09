import { z } from "zod";

export const issueKindSchema = z.enum(["error", "suspected"]);

/** 与请求体 page text 一致的 UTF-16 下标区间 [start, end)，可选，用于程序精确定位 */
export const textRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((r) => r.start < r.end, { message: "textRange: start < end" });

export const issueSchema = z.object({
  /** 所在页的 0-based 索引；多页审稿时必须返回，单页时可省略 */
  pageIndex: z.number().int().nonnegative().optional(),
  excerpt: z.string(),
  reason: z.string(),
  /** 具体修改意见，如「建议替换为：xxx」「建议删除」 */
  suggestion: z.string().optional(),
  /** 错误类型：error=确定错误（红），suspected=疑似错误（蓝） */
  kind: issueKindSchema.optional(),
  /** 可选：页面文本串中的字符区间，与 excerpt 对应子串一致时由前端优先采用 */
  textRange: textRangeSchema.optional(),
  /** 兼容旧版 severity */
  severity: z.string().optional(),
});

export const reviewResponseSchema = z.object({
  issues: z.array(issueSchema),
});

export type IssueKind = z.infer<typeof issueKindSchema>;
export type ReviewIssue = z.infer<typeof issueSchema>;
export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

/** API 返回给前端的规范条目（route 已归一化 kind） */
export type TextRange = z.infer<typeof textRangeSchema>;

export type NormalizedReviewIssue = {
  pageIndex: number;
  excerpt: string;
  reason: string;
  suggestion: string;
  kind: IssueKind;
  textRange?: TextRange;
};

/** 统一批注类型：AI 生成和手动标注共用 */
export type Annotation = {
  id: string;
  source: "ai" | "manual" | "selection-ai";
  excerpt: string;
  kind: IssueKind;
  suggestion: string;
  reason: string;
  charRange: [number, number] | null;
};

/** 将模型可能返回的中文或其它别名规范为 error | suspected */
export function normalizeIssueKind(issue: ReviewIssue): IssueKind {
  const raw = (issue.kind ?? issue.severity ?? "").toString().trim().toLowerCase();
  if (
    raw === "error" ||
    raw === "错误" ||
    raw === "确定" ||
    raw === "definite" ||
    raw === "高" ||
    raw === "high"
  ) {
    return "error";
  }
  if (
    raw === "suspected" ||
    raw === "疑似" ||
    raw === "可疑" ||
    raw === "中" ||
    raw === "低" ||
    raw === "medium" ||
    raw === "low"
  ) {
    return "suspected";
  }
  return "suspected";
}

/**
 * 模型常在 suggestion/reason 里写 改为"xxx"、动词"推动" 等，未转义 ASCII " 会导致 JSON.parse 失败。
 * 在「冒号后的字符串值」内，将不表示字段结束的 " 转义为 \"。
 */
export function repairJsonStringInnerQuotes(jsonStr: string): string {
  let out = "";
  let i = 0;
  const s = jsonStr;
  const n = s.length;

  const afterValueColon = (tail: string) => {
    const x = tail.replace(/\s+$/, "");
    return x.endsWith(":");
  };

  while (i < n) {
    const c = s[i]!;

    if (c === '"') {
      if (afterValueColon(out)) {
        out += '"';
        i++;
        while (i < n) {
          const ch = s[i]!;
          if (ch === "\\") {
            out += ch;
            i++;
            if (i < n) out += s[i]!;
            i++;
            continue;
          }
          if (ch === '"') {
            const rest = s.slice(i + 1);
            if (/^\s*([,}\]])/.test(rest)) {
              out += '"';
              i++;
              break;
            }
            out += '\\"';
            i++;
            continue;
          }
          out += ch;
          i++;
        }
        continue;
      }
      out += '"';
      i++;
      while (i < n) {
        const ch = s[i]!;
        if (ch === "\\") {
          out += ch;
          i++;
          if (i < n) out += s[i]!;
          i++;
          continue;
        }
        out += ch;
        i++;
        if (ch === '"') break;
      }
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

export function parseReviewJson(raw: string): ReviewResponse {
  const trimmed = raw.trim();
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = codeBlock ? codeBlock[1].trim() : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (first) {
    try {
      parsed = JSON.parse(repairJsonStringInnerQuotes(jsonStr));
    } catch {
      throw first;
    }
  }
  return reviewResponseSchema.parse(parsed);
}
