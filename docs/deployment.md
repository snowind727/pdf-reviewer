# pdf-reviewer 生产发布

这是本项目部署技能的共同维护来源；`.qoder` 与 `.opencode` 的技能入口均引用此文档。仅在用户明确要求部署本项目时执行。

## 范围与完成条件

- 发布授权涵盖本次发布范围内的提交、推送、服务器更新、构建、重启和只读验证；不自动包含无关修改或业务代码修复。
- 发布失败时继续进行必要的只读诊断。若用户已授权修复，按该范围修复并验证；否则报告原因及所需修改，不自行改变代码或生产配置。
- 只有目标提交已部署、构建成功、服务运行正常且 HTTP 门禁检查通过，才报告发布完成。无法验证的步骤要明确标为未验证。
- 保留无关的本地和服务器修改；不强推、不重置历史，也不擅自回滚或反复重启。

## 环境

| 项目 | 值 |
| --- | --- |
| 本地仓库 | `/Users/cdf/Documents/code/web/pdf-reviewer` |
| 发布分支 | `origin/main` |
| SSH 密钥文件 | `/Users/cdf/Documents/ext/mac_ssh_01.pem` |
| 服务器 | `root@8.136.206.43` |
| 服务器应用目录 | `/code/pdf-reviewer` |
| systemd 服务名 | `pdf-reviewer` |

SSH 使用现有可信主机配置及上述密钥，可设置 `ConnectTimeout=15`。下文服务器命令在 SSH 会话中执行；不输出密钥、环境变量值或 Cookie。

## 准备发布提交

1. 在本地仓库检查 `git status --short --branch`、`git diff`、`git diff --cached`，并检查本次相关的未跟踪文件内容。仅查看差异统计不足以确定提交范围。
2. 执行 `git fetch origin`，核对当前分支、上游及待发布提交。服务器使用 `main`；若当前不在 `main`，先确认本次目标提交与发布分支的关系，不把其他分支的工作误当成已推送。需要合并时遵循用户已有授权，范围不清时先澄清。
3. 仅暂存本次发布范围内已检查的文件，使用 `git add -- <明确的文件路径>`；同一文件包含无关修改时按块暂存。不要使用 `git add -A` 或 `git add .`。已有暂存区混入无关改动时，先明确提交范围，保留用户原有暂存状态。
4. 提交前核对 `git diff --cached`，确认暂存内容全部属于本次发布。提交信息沿用 `feat:`、`fix:`、`chore:` 前缀。无待提交改动时跳过提交。
5. 按 `AGENTS.md` 执行受影响的检查；已有检查在代码未改变时无需重复。记录目标提交 SHA，核对本地 `main` 指向该提交后执行 `git push origin main`，再确认远端 `main` 与目标提交一致。无待推送提交时只核对一致性。

## 更新服务器与构建

在服务器应用目录检查 `git status --short --branch`，确认工作区干净且位于 `main`。如有未提交改动、分支不符或历史分叉，报告具体差异，不覆盖它们。

```bash
cd /code/pdf-reviewer
git pull --ff-only origin main
git rev-parse HEAD
```

确认服务器 HEAD 与本次目标 SHA 一致后运行 `npm run build`。构建退出码必须为零；构建失败时不继续重启。对耗时命令使用可继续读取输出的执行方式，超时后先确认实际状态，不重复启动构建。

## 重启与验证

构建成功后执行：

```bash
systemctl restart pdf-reviewer
systemctl is-active pdf-reviewer
```

重启命令成功且状态为 `active` 后，检查实际监听地址的 HTTP 响应。默认 Next.js 端口为 3000；若服务有端口覆盖，使用实际端口，不输出完整环境配置。

- 无 Cookie 请求 `/gate`：应返回 200，内容为邀请码入口。
- 无 Cookie 请求 `/`：应重定向到 `/gate`，不能将 500 或任意重定向视为成功。
- 无 Cookie 请求 `/api/editor-spec`：应返回 401，确认 API 门禁生效。

这些检查不提交邀请码，不调用审稿接口或付费模型。启动期间可在 30 秒内有限重试 HTTP 检查；超时或服务失败后停止重试，执行只读诊断，例如 `systemctl status pdf-reviewer --no-pager` 与 `journalctl -u pdf-reviewer --no-pager -n 50`。报告时脱敏，只摘取相关错误。

若任务包含验证已知的对外访问地址，再核对该入口；未检查的反向代理、HTTPS 或完整审稿流程应在结果中说明，不能由本机 HTTP 成功推断全部正常。

最终报告目标提交、服务器提交、构建结果、服务状态、HTTP 检查结果以及未验证项。检查失败时报告发布未完成及已完成步骤，不将验证工作全部交给用户。
