# AGENTS.md

## 项目概览

这是一个基于 Next.js App Router 的 PDF AI 审稿工具。用户上传 PDF 后，可以按页或按选区调用 AI 审稿，并在 PDF 文本层上定位批注、高亮和导出标注后的 PDF。

主要技术栈：Next.js 16、React 19、TypeScript、Tailwind CSS、pdf.js、pdf-lib、fontkit 和 Zod。

## 常用命令

```bash
npm install        # 安装依赖，并通过 postinstall 准备 public/pdfjs/
npm run dev        # 启动开发服务器
npm run lint       # 执行 ESLint 检查
npm run build      # 执行生产构建
npm start          # 启动生产服务
```

修改代码后，优先运行 `npm run lint`；涉及构建配置、路由、服务端代码或依赖时，再运行 `npm run build`。

## 目录约定

- `app/`：Next.js 页面、布局和 API 路由。
- `components/`：客户端 UI 组件，尤其是 PDF 审稿主界面。
- `lib/`：AI 调用、门禁签名、PDF 几何与文本匹配、PDF 导出等共享逻辑。
- `public/pdfjs/`：由 `pdfjs-dist` 复制生成的浏览器静态资源。
- `public/fonts/`：可选的本地中文字体资源。
- `scripts/`：项目维护脚本。
- `editor-spec.md`：默认编辑规范；编辑规范相关功能应与该文件保持一致。

## 开发规则

- 保持 TypeScript 类型明确，避免无必要的 `any`。
- 服务端 API 路由中的密钥和模型调用逻辑不得移入客户端组件。
- 不要把 API Key、邀请码、签名密钥或其他敏感配置写入代码、日志或提交记录。
- 环境变量使用 `.env.local` 或 `.env.production.local`；以 `.env.example` 作为配置字段参考。
- 修改 PDF 文本匹配、坐标计算、高亮定位或导出逻辑时，要同时检查页面缩放、旋转和无法匹配文本时的降级行为。
- 修改门禁逻辑时，要保留 HttpOnly Cookie、签名校验、过期时间和邀请码失效机制。
- `public/pdfjs/` 是生成的静态资源；除非确实需要更新 pdf.js，否则不要手工修改其中的文件。
- 保留用户已有的未提交修改和未跟踪文件，不要使用破坏性 Git 操作覆盖它们。

## API 与配置

审稿接口依赖 DeepSeek 或兼容的 OpenAI 接口。相关配置包括：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_BASE_URL`
- `DEEPSEEK_MODEL`
- `INVITE_CODE`
- `GATE_SECRET`

修改 API 请求格式、模型配置或结构化输出时，同时检查 `lib/deepseek.ts`、`lib/ai-review-models.ts` 以及对应的 `app/api/` 路由。

## 验证要求

完成修改后，根据影响范围执行：

1. `npm run lint`
2. 必要时执行 `npm run build`
3. 如果改动涉及 PDF 交互、门禁或 API 请求，补充手动验证对应用户流程。

不要为了验证而调用真实的生产密钥或提交敏感信息。
