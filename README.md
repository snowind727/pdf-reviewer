# PDF AI 审稿

上传 PDF，按页浏览，从当前页起调用 AI 审稿（默认 1 页，可连续最多 10 页，高亮 + 附注），并下载带标注与「审稿附注」页的 PDF。

## 运行

1. **配置密钥**  
   复制 `.env.example` 为 **`.env.local`**，建议同时填写（切换模型时即需对应密钥）：
   - **`MINIMAX_API_KEY`**：M2.5 / M2.1 / M2.7 等 MiniMax 模型（也可用 **`AI_API_KEY`**）。
   - **`ARK_API_KEY`**：豆包 / DeepSeek 等方舟模型（兼容别名 **`DOUBAO_API_KEY`**）。  
   页面上「模型」为统一列表，在 **`lib/ai-review-models.ts`** 中维护（先 MiniMax、后方舟，与 **`lib/minimax-models.ts`** / **`lib/ark-models.ts`** 配置顺序对齐后可再按需微调）。

2. 审稿请求为 Anthropic Messages 形态：`POST {anthropicBase}/v1/messages`，请求头含 `x-api-key`、`anthropic-version`。

3. `npm install`（会执行 `postinstall`，将 `pdfjs-dist` 复制到 **`public/pdfjs/`**，供浏览器直接加载，避免 Next 打包 pdf.js 崩溃）→ `npm run dev` → 打开 [http://localhost:3000](http://localhost:3000)。若 404，可手动执行：`node scripts/copy-pdfjs.mjs`。

## 可选：离线中文字体

导出附注页默认会尝试从 jsDelivr 加载思源黑体；也可将 `NotoSansSC-Regular.otf` 放到 `public/fonts/`，优先使用本地文件。

## 技术栈

Next.js（App Router）、pdf.js（`public/` 动态加载）、pdf-lib + fontkit、Zod。
