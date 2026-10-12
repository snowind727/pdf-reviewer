# PDF AI 审稿

上传 PDF，按页浏览，从当前页起调用 AI 审稿，批注自动定位并高亮在原文上，支持导出带标注与「审稿附注」页的 PDF。

## 主要功能

- **AI 批量审稿**：从当前页开始，可选审 1、5、10、20、30 页（默认 20 页）；剩余页数不足时自动处理到文档末页。选择超过 5 页时，按每 5 页一批分次发送给 AI，兼顾上下文质量与调用次数。
- **选区 AI 专审**：在 PDF 中选中文本后可直接「复制」或发起「AI专审」，针对片段深入审校。
- **批注高亮定位**：AI 返回的批注会自动匹配 PDF 文本层并在页面上高亮；无法定位的批注仍会出现在右侧批注列表中。
- **重要讲话数据库**：粘贴讲话原文后按回车即可在本地数据中检索核对。
- **审稿规则可临时修改**：可在页面上修改编辑规范（Editor Spec），仅本次会话有效，刷新后恢复默认。
- **标注 PDF 导出**：基于 pdf-lib 导出带高亮标注与「审稿附注」页的 PDF（导出入口当前隐藏，代码中 `PDF_EXPORT_ENABLED` 置为 `true` 即可恢复）。

## 快速开始

1. **安装依赖**

   ```bash
   npm install
   ```

   `postinstall` 会自动执行 `scripts/copy-pdfjs.mjs`，将 `pdfjs-dist` 复制到 `public/pdfjs/`，供浏览器直接加载（避免 Next 打包 pdf.js 出错）。若页面 404 找不到 pdf.js，可手动执行：

   ```bash
   node scripts/copy-pdfjs.mjs
   ```

2. **配置环境变量**：复制 `.env.example` 为 `.env.local` 并按下表填写。

   | 变量 | 必填 | 说明 |
   | --- | --- | --- |
   | `DEEPSEEK_API_KEY` | 是 | DeepSeek 官方 API Key |
   | `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com`，可指向兼容接口（如本地 LM Studio） |
   | `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-v4-flash` |
   | `INVITE_CODE` | 是 | 邀请码，支持逗号分隔多个；未配置时应用拒绝访问 |
   | `GATE_SECRET` | 是 | 签名登录态 Cookie 的密钥，可用 `openssl rand -hex 32` 生成 |

   **线上（生产）环境**：实际使用的是 `.env.production.local`。部署时需在服务器上**新建**该文件，然后参照仓库中已提交的 `.env.example`，把内容覆盖进去并填写真实密钥。

3. **启动开发环境**

   ```bash
   npm run dev
   ```

   打开 [http://localhost:3000](http://localhost:3000)，首次访问需输入邀请码。

## 邀请码门禁

- 访问页面需先输入邀请码，验证通过后写入 HttpOnly 的 `gate_token` Cookie，**30 天内免重复输入**。
- Cookie 格式为 `{过期时间}.{邀请码Base64}.{HMAC-SHA256 签名}`，由 `GATE_SECRET` 签名；代理层会校验签名、有效期，以及 Cookie 中绑定的邀请码是否仍在当前 `INVITE_CODE` 列表中。
- 从 `INVITE_CODE` 中移除某个邀请码会立即使该邀请码的已有会话失效（不影响其他邀请码）；更换 `GATE_SECRET` 会使全部会话失效。
- 生产环境建议通过反向代理启用 HTTPS。

## AI 接口说明

审稿请求走 DeepSeek 官方 OpenAI 兼容接口：`POST https://api.deepseek.com/chat/completions`，请求头 `Authorization: Bearer <API Key>`，开启 JSON 结构化输出，并对 429/5xx 等瞬时错误自动重试。

## 可选：离线中文字体

导出附注页默认尝试从 jsDelivr 加载思源黑体；也可将 `NotoSansSC-Regular.otf` 放到 `public/fonts/`，存在时优先使用本地文件。

## 项目结构

```text
app/                  # Next.js App Router 页面与 API 路由
  api/gate/verify/    # 邀请码验证接口
  api/review-page/    # AI 批量审稿接口
  api/suggest-edit/   # 选区 AI 专审接口
  api/editor-spec/    # 编辑规范（Editor Spec）读取与重置
  gate/               # 邀请码门禁页面
components/           # PdfReviewer 主界面等客户端组件
lib/                  # DeepSeek 调用、PDF 几何/文本匹配、pdf-lib 导出、门禁签名等
public/pdfjs/         # 由 postinstall 复制的 pdf.js 静态资源
public/fonts/         # 可选离线中文字体
scripts/copy-pdfjs.mjs
```

## 技术栈

Next.js 16（App Router）、React 19、TypeScript、Tailwind CSS、pdf.js（`public/` 动态加载）、pdf-lib + fontkit、Zod。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 生产构建 |
| `npm start` | 启动生产服务（监听 `0.0.0.0`） |
| `npm run lint` | ESLint 检查 |
