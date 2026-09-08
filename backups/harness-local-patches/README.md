# deepseek-harness 本地提交补丁备份

导出自 `/home/xiaoxin/deepseek-harness`（`origin/master..master` 的 6 个本地提交，
基于 0.1.2-alpha.5 + 本地补丁），生成于 2026-09-02。

## 用途

harness 本体是官方仓库克隆可随时重拉，但以下 6 个提交是**本地独有工作成果**
（官方 upstream 没有），机器丢失即丢失——此为轻量备份。恢复方式：
`git am 0001-*.patch ...`（在 deepseek-harness 仓库内按顺序应用）。

## 提交清单

| 补丁 | 内容 |
|---|---|
| 0001 | feat(mcp-client): MCP 工具 allow/deny 过滤 |
| 0002 | feat: 跨会话 automations + autonomous 预设 + compat-shim + plan-mode 工具 |
| 0003 | chore: tool-catalog 同步 / compat-shim lint 覆盖 / plan-mode 测试 |
| 0004 | fix: compat-shim `ctx.provide` / settings 补 `settingsNamespace`（修 dsh-better-sidebar） |
| 0005 | feat(subagent): `registerContinuableSetup` 钩子（修 @nanmicoder/dsh-agent-teams） |
| 0006 | fix(llm): re-export `deepFreeze`（修 oss-prompt-optimizer） |

## 关联

上游讨论（Issues 已关闭，走 GitHub Discussions）：
https://github.com/deepseek-ai/deepseek-harness/discussions/5440
