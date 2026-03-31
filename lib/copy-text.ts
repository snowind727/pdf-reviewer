/**
 * 复制到剪贴板。HTTP 等非安全上下文中 navigator.clipboard 不可用，降级为 execCommand。
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof window === "undefined") return;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* 权限等原因失败时尝试降级 */
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.cssText =
    "position:fixed;top:-10000px;left:0;width:2px;height:2px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }

  if (!ok) {
    throw new Error(
      "当前页面无法自动复制（请使用 HTTPS 访问，或手动选中文字后使用 Ctrl+C / ⌘+C）",
    );
  }
}
