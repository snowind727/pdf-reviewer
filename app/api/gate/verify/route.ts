import { NextResponse, type NextRequest } from "next/server";

import {
  GATE_COOKIE_NAME,
  GATE_TOKEN_TTL_SECONDS,
  createGateToken,
  getGateSecret,
  isGateConfigured,
  verifyInviteCode,
} from "@/lib/gate";

/* 简单内存限流：同一 IP 连续失败 5 次后锁定 15 分钟，防暴力撞码。
   注意：计数存在进程内存中，服务重启后清零；多实例部署时各自独立计数。 */
const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_LOCK_MS = 15 * 60 * 1000;
const RATE_LIMIT_IDLE_MS = 60 * 60 * 1000;
type RateRecord = { failures: number; lockedUntil: number; lastFailure: number };
const rateLimitMap = new Map<string, RateRecord>();

/** 取客户端 IP：优先反向代理设置的 x-real-ip，其次 x-forwarded-for 首个地址 */
function getClientIp(request: NextRequest): string {
  const realIp = request.headers.get("x-real-ip");
  if (realIp !== null && realIp.trim() !== "") return realIp.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.trim() !== "") {
    return forwarded.split(",")[0].trim();
  }
  return "unknown";
}

/** 顺手清理已解锁且闲置超过 1 小时的记录，避免内存无限增长 */
function purgeStaleRecords(now: number): void {
  for (const [ip, record] of rateLimitMap) {
    if (record.lockedUntil <= now && now - record.lastFailure > RATE_LIMIT_IDLE_MS) {
      rateLimitMap.delete(ip);
    }
  }
}

function recordFailure(ip: string, now: number): boolean {
  const record = rateLimitMap.get(ip);
  const failures = (record?.failures ?? 0) + 1;
  if (failures >= RATE_LIMIT_MAX_FAILURES) {
    rateLimitMap.set(ip, { failures: 0, lockedUntil: now + RATE_LIMIT_LOCK_MS, lastFailure: now });
    return true;
  }
  rateLimitMap.set(ip, { failures, lockedUntil: 0, lastFailure: now });
  return false;
}

export async function POST(request: NextRequest) {
  if (!isGateConfigured()) {
    return NextResponse.json(
      { error: "服务未正确配置门禁（缺少 INVITE_CODE 或 GATE_SECRET 环境变量）" },
      { status: 500 },
    );
  }

  const ip = getClientIp(request);
  const now = Date.now();
  purgeStaleRecords(now);
  const record = rateLimitMap.get(ip);
  if (record !== undefined && record.lockedUntil > now) {
    const minutes = Math.ceil((record.lockedUntil - now) / 60000);
    return NextResponse.json(
      { error: `失败次数过多，请 ${minutes} 分钟后再试` },
      { status: 429 },
    );
  }

  let code = "";
  try {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body.code === "string") code = body.code.trim();
  } catch {
    // 请求体非法时按空输入处理
  }

  // 命中时返回配置中的码，后续绑定进 token，删除该码即可作废对应登录态
  const matched = code !== "" ? await verifyInviteCode(code) : null;
  if (matched === null) {
    const locked = recordFailure(ip, now);
    if (locked) {
      return NextResponse.json(
        { error: "连续失败次数过多，已锁定 15 分钟" },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: "邀请码错误" }, { status: 401 });
  }

  // 验证通过，清除该 IP 的失败计数
  rateLimitMap.delete(ip);
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
