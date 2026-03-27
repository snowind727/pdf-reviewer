# PDF AI 审稿

上传 PDF，按页浏览，对当前页调用 AI 审稿（高亮 + 附注），并下载带标注与「审稿附注」页的 PDF。

## 运行

1. **配置 MiniMax（本地推荐）**  
   复制 `minimax.local.example.json` 为 **`minimax.local.json`**（该文件已加入 `.gitignore`，不会进 Git），填写 `apiKey`。可选字段：`anthropicBase`、`model`、`anthropicVersion`。  
   默认 `anthropicBase` 为国内文档中的 **`https://api.minimaxi.com/anthropic`**，与 [Anthropic API 兼容](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api) 一致。

2. **或改用环境变量（可选）**  
   环境变量优先级高于 `minimax.local.json`：`MINIMAX_API_KEY`、`MINIMAX_ANTHROPIC_BASE`、`MINIMAX_MODEL`、`ANTHROPIC_VERSION`。参见 `.env.example`。

3. 审稿请求为 Anthropic Messages 形态：`POST {anthropicBase}/v1/messages`，请求头含 `x-api-key`、`anthropic-version`。

4. `npm install`（会执行 `postinstall`，将 `pdfjs-dist` 复制到 **`public/pdfjs/`**，供浏览器直接加载，避免 Next 打包 pdf.js 崩溃）→ `npm run dev` → 打开 [http://localhost:3000](http://localhost:3000)。若 404，可手动执行：`node scripts/copy-pdfjs.mjs`。

## 可选：离线中文字体

导出附注页默认会尝试从 jsDelivr 加载思源黑体；也可将 `NotoSansSC-Regular.otf` 放到 `public/fonts/`，优先使用本地文件。

## 技术栈

Next.js（App Router）、pdf.js（`public/` 动态加载）、pdf-lib + fontkit、Zod。
