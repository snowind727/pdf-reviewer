import { NextResponse, type NextRequest } from "next/server";

import {
  GATE_COOKIE_NAME,
  GATE_TOKEN_TTL_SECONDS,
  createGateToken,
  getGateSecret,
  isGateConfigured,
  verifyInviteCode,
} from "@/lib/gate";

export async function POST(request: NextRequest) {
  if (!isGateConfigured()) {
    return NextResponse.json(
      { error: "服务未正确配置门禁（缺少 INVITE_CODE 或 GATE_SECRET 环境变量）" },
      { status: 500 },
    );
  }

  let code = "";
  try {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body.code === "string") code = body.code.trim();
  } catch {
    // 请求体非法时按空输入处理
  }

  if (code === "") {
    return NextResponse.json({ error: "邀请码错误" }, { status: 401 });
  }
  // 命中时返回配置中的码，后续绑定进 token，删除该码即可作废对应登录态
  const matched = await verifyInviteCode(code);
  if (matched === null) {
    return NextResponse.json({ error: "邀请码错误" }, { status: 401 });
  }

  const token = await createGateToken(getGateSecret(), matched);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(GATE_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: GATE_TOKEN_TTL_SECONDS,
  });
  return response;
}
