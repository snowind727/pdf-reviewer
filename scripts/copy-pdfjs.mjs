/**
 * 将 pdf.min.mjs / worker 复制到 public，供浏览器原生 dynamic import 加载，
 * 避免 Next/Webpack 二次打包 pdfjs 导致运行时崩溃。
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "pdfjs");
mkdirSync(outDir, { recursive: true });

function resolvePkg(sub) {
  try {
    return require.resolve(sub, { paths: [root] });
  } catch {
    return null;
  }
}

const main = resolvePkg("pdfjs-dist/build/pdf.min.mjs");
const worker = resolvePkg("pdfjs-dist/build/pdf.worker.min.mjs");

if (!main || !worker || !existsSync(main)) {
  console.warn(
    "[copy-pdfjs] 跳过：未找到 pdfjs-dist，请先 npm install（需依赖 pdfjs-dist）"
  );
  process.exit(0);
}

copyFileSync(main, join(outDir, "pdf.min.mjs"));
copyFileSync(worker, join(outDir, "pdf.worker.min.mjs"));
console.log("[copy-pdfjs] 已复制到 public/pdfjs/");
