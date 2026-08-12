"use client";

import { useState, type FormEvent } from "react";

/** 邀请码门禁页：验证通过后服务端写入 HttpOnly Cookie，并跳回首页 */
export default function GatePage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      if (res.ok) {
        // 整页跳转，确保 middleware 重新校验 Cookie
        window.location.replace("/");
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "验证失败，请重试");
    } catch {
      setError("网络异常，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-zinc-900">AI 审稿</h1>
        <p className="mt-1 text-sm text-zinc-500">请输入邀请码后继续使用</p>
        <input
          type="password"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="邀请码"
          autoFocus
          autoComplete="off"
          className="mt-4 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
        />
        {error !== null && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting || code.trim() === ""}
          className="mt-4 w-full rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? "验证中…" : "进入"}
        </button>
      </form>
    </main>
  );
}
