/** 邀请码门禁：共享工具函数，供 middleware 与 /api/gate/verify 使用。 */

export const GATE_COOKIE_NAME = "gate_token";
/** 验证通过后的登录态时长：30 天 */
export const GATE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 解析环境变量中的邀请码列表（逗号分隔，去空白与空项） */
export function getInviteCodes(): string[] {
  const raw = process.env.INVITE_CODE ?? "";
  return raw
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

export function getGateSecret(): string {
  return process.env.GATE_SECRET ?? "";
}

/** 门禁是否已正确配置（未配置时 middleware 应直接拒绝访问） */
export function isGateConfigured(): boolean {
  return getInviteCodes().length > 0 && getGateSecret().length > 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function base64UrlToText(encoded: string): string | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** 常量时间字符串比较，避免时序侧信道泄露 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 生成门禁 token：`{过期时间戳}.{邀请码base64}.{HMAC签名}`。
 * 邀请码被绑定进登录态：后续从配置中删除该码，对应登录态立即失效。
 */
export async function createGateToken(secret: string, inviteCode: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + GATE_TOKEN_TTL_SECONDS;
  const payload = `${expiresAt}.${textToBase64Url(inviteCode)}`;
  const signature = await hmacSha256(secret, payload);
  return `${payload}.${signature}`;
}

/**
 * 校验门禁 token：签名正确且未过期时返回 token 中绑定的邀请码，否则返回 null。
 * 注意：调用方还需检查返回的码是否仍在当前配置列表中。
 */
export async function verifyGateToken(token: string, secret: string): Promise<string | null> {
  const firstDot = token.indexOf(".");
  const lastDot = token.lastIndexOf(".");
  if (firstDot <= 0 || lastDot <= firstDot) return null;
  const expiresAtRaw = token.slice(0, firstDot);
  const codeEncoded = token.slice(firstDot + 1, lastDot);
  const signature = token.slice(lastDot + 1);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  const expected = await hmacSha256(secret, `${expiresAtRaw}.${codeEncoded}`);
  if (!constantTimeEqual(signature, expected)) return null;
  return base64UrlToText(codeEncoded);
}

/** 校验用户输入的邀请码，命中时返回配置中对应的码，否则返回 null（常量时间比较） */
export async function verifyInviteCode(input: string): Promise<string | null> {
  const codes = getInviteCodes();
  if (codes.length === 0) return null;
  const secret = getGateSecret();
  const inputHash = await hmacSha256(secret, input);
  for (const code of codes) {
    const codeHash = await hmacSha256(secret, code);
    if (constantTimeEqual(inputHash, codeHash)) return code;
  }
  return null;
}
