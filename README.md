# PDF AI 审稿

上传 PDF，按页浏览，从当前页起调用 AI 审稿（可选 1、5、10、20、30、40、50 页，默认 10 页；超过 5 页时按每 5 页分批发送给 AI，以兼顾上下文与调用次数），并下载带标注与「审稿附注」页的 PDF。

## 运行

1. **配置密钥**  
   复制 `.env.example` 为 **`.env.local`**，然后填写 **`DEEPSEEK_API_KEY`**。当前页面固定使用 `deepseek-v4-flash`。

2. 审稿请求使用 DeepSeek 官方 OpenAI 兼容接口：`POST https://api.deepseek.com/chat/completions`，请求头使用 `Authorization: Bearer <API Key>`，并开启 JSON 输出。

3. `npm install`（会执行 `postinstall`，将 `pdfjs-dist` 复制到 **`public/pdfjs/`**，供浏览器直接加载，避免 Next 打包 pdf.js 崩溃）→ `npm run dev` → 打开 [http://localhost:3000](http://localhost:3000)。若 404，可手动执行：`node scripts/copy-pdfjs.mjs`。

## 可选：离线中文字体

导出附注页默认会尝试从 jsDelivr 加载思源黑体；也可将 `NotoSansSC-Regular.otf` 放到 `public/fonts/`，优先使用本地文件。

## 技术栈

Next.js（App Router）、pdf.js（`public/` 动态加载）、pdf-lib + fontkit、Zod。
