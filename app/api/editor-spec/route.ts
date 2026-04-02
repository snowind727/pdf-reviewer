import { NextResponse } from "next/server";

import { EDITOR_PUBLISHING_SPEC } from "@/lib/editor-spec";

/**
 * 供前端「豆包搜索」在勾选「审稿提示」时拉取 editor-spec.md 全文，与文本框内容拼接后复制。
 */
export async function GET() {
  return NextResponse.json({ spec: EDITOR_PUBLISHING_SPEC });
}
