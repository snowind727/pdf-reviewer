import { NextResponse, type NextRequest } from "next/server";

import {
  GATE_COOKIE_NAME,
  getGateSecret,
  getInviteCodes,
  isGateConfigured,
  verifyGateToken,
} from "@/lib/gate";

/** 门禁放行路径：邀请码输入页与校验接口本身 */
const PUBLIC_PATHS = new Set(["/gate", "/api/gate/verify"]);
/** 无需门禁的路径前缀：静态资源与 public 目录文件 */
const PUBLIC_PREFIXES = ["/_next/", "/pdfjs/", "/fonts/", "/favicon.ico", "/file.svg", "/globe.svg", "/next.svg", "/vercel.svg", "/window.svg"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  // 未配置邀请码 / 密钥时直接拒绝，避免忘记配置导致裸奔
  if (!isGateConfigured()) {
    const message = "服务未正确配置门禁（缺少 INVITE_CODE 或 GATE_SECRET 环境变量）";
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: message }, { status: 500 });
    }
    return new NextResponse(message, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const token = request.cookies.get(GATE_COOKIE_NAME)?.value ?? "";
  // 校验签名与有效期，并确认 token 中绑定的邀请码仍在配置列表中（删码即作废）
  const usedCode = token !== "" ? await verifyGateToken(token, getGateSecret()) : null;
  if (usedCode !== null && getInviteCodes().includes(usedCode)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "未通过邀请码验证" }, { status: 401 });
  }

  const gateUrl = request.nextUrl.clone();
  gateUrl.pathname = "/gate";
  gateUrl.search = "";
  return NextResponse.redirect(gateUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
