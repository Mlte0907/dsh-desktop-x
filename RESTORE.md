# 重刷系统后：dsh 环境复原清单

> 写于 2026-09-11，为「重刷宿主机」后的重建准备。**本文件不含任何密钥**——密钥值无法从仓库恢复，需自行从服务商后台取回（见第四节）。

## 一、需要拉回的仓库

| 仓库 | 地址 | 说明 |
|---|---|---|
| dsh-desktop-x | `github.com/Mlte0907/dsh-desktop-x` | 本机（本文件所在） |
| dsh-teams-x | `github.com/Mlte0907/dsh-teams-x` | TeamsX 多 agent 团队插件 |
| dsh-remote-x | `github.com/Mlte0907/dsh-remote-x` | 移动端注入层插件 |
| pangu | `github.com/Mlte0907/pangu` | 盘古 |
| deepseek-harness（分叉） | `github.com/Mlte0907/deepseek-harness` | 可选：含 17 个本地提交（presets / pi-ai header / deepFreeze 等）；上游是 `deepseek-ai/deepseek-harness` |

推送走 **gh-proxy**（直连 github.com 会超时）：`https://gh-proxy.org/github.com/<owner>/<repo>.git`

## 二、profile 插件清单（`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`）

```json
[
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dshmarket",
  "@liustack/modlens",
  "dsh-context",
  "dsh-univer-office",
  "dsh-cost-meter",
  "dsh-find-plugin",
  "dsh-pangu",
  "dsh-remote-x",
  "dsh-teams-x",
  "dsh-better-sidebar",
  "@wxg-prc-cpg/browser-skill-dsh-plugin"
]
```

自研的两个（dsh-teams-x / dsh-remote-x）在本机是**符号链接指向本地仓库**，刷完需重新链接或 `pnpm build` 后重装。

## 三、`~/.dsh/settings.yaml` 关键片段

模型供应商（`llm-pi-ai.providers.opencode-go`）——opencode-go 走 `OPENCODE_GO_API_KEY`：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      # deepseek-flash 不在 pi-ai 内置目录（只到 v4-flash/v4-pro），模型条目没有
      # per-model 的 api/baseURL，所以这两项必须写在路由级；同族的 glm/mimo 协议一致，无影响。
      api: openai-completions
      baseURL: https://opencode.ai/zen/go/v1
      models:
        - id: glm-5.3-flash
          name: GLM-5.3 Flash
          contextWindow: 1000000
          maxTokens: 131072
        - id: mimo-v2.5
          name: MiMo V2.5
          contextWindow: 1000000
          maxTokens: 128000
        # DeepSeek V4.1 Flash（网关实测：1M 上下文、max_tokens 可到 384000、支持图片、会思考）
        - id: deepseek-flash
          name: DeepSeek V4.1 Flash
          contextWindow: 1000000
          maxTokens: 384000
          input: [text, image]
          reasoningEfforts:
            off:
            low: low
            high: high
            max: max
          # 必须显式声明：pi-ai 对 opencode.ai 的自动探测会给 max_completion_tokens /
          # thinkingFormat=openai / requiresReasoningContent…=false，三者都与该端点不符。
          compat:
            supportsStore: false
            supportsDeveloperRole: false
            maxTokensField: max_tokens
            requiresReasoningContentOnAssistantMessages: true
            thinkingFormat: deepseek
    openrouter:
      models:
        - id: inclusionai/ling-3.0-flash-fin:free

agent-default-model:
  provider: opencode-go
  model: deepseek-flash
```

> 注意：在 composer 里切模型会**自动改写** `agent-default-model`（dsh web 的设计）。

## 四、`~/.dsh/.credentials.yaml`：只有键结构，值需自填

```
refs:
  OPENCODE_GO_API_KEY: <从 opencode.ai 后台取>
  ...（其它供应商同理）
```

**这是我无法替你恢复的部分**——刷机前若没拷走 `~/.dsh/.credentials.yaml`，只能重新申请/复制。

## 五、`~/.dsh/profiles/web/cordis.patch.yml` 关键块

```yaml
- id: dsh-remote-x
  config:
    accessKey: '<与 dsh-remote-proxy.service 的 --access-key 一致，自定>'

# 不要再写 insert 行——会和 bundle 层撞 duplicate loader entry id "teams-x"
- id: teams-x
  config:
    stateDir: .teams-x
    memberProvider: spawn
    executionPrompt: ''
    memberMaxDepth: 1
    maxMembers: 8
```

- 禁用第三方插件用 patch 层（`- id: <entry短名>` + `disabled: true`），**不要改 package.json**——dshmarket 会把卸载的插件加回 bundles。
- `dsh-better-sidebar` 的 entry id 是 **`better-sidebar`**（不是包名）。

## 六、已知环境坑（刷完同样适用）

- `/var/log` 挂在 **47M zram**（armbian-ramlog），**重启即清空**；journald `SystemMaxUse=20M` 太小 → 断电原因查不到。想留证据：调大 `SystemMaxUse`、把用户加进 `adm` 组。
- 机器是骁龙平台的 ARM 本，**电池已老化**（health=Dead、738 循环），电量到 0 会整机掉电；掉电后 RTC 归零（1972），时间靠 NTP 纠正。
- **browser-skill 0.2.1 的已知崩溃**：若同时装了 dsh-better-sidebar，其 `observationTabOpen` 会对 better-sidebar 的状态（只有 `bottomSplits`、没有 `splits`）调 `leafNodes(undefined)` → 全屏错误层挡住所有点击（手机整个点不动）。修法：`node_modules/@wxg-prc-cpg/browser-skill-dsh-plugin/lib/client.cjs` 的 `function* leafNodes(node) {` 首行加 `if (node == null) return;`。**插件更新会覆盖该补丁，需重打。**
- dsh-context 0.48.0 的 guide 条目缺 `description` 会在侧栏留个空方块（上游已修未发版）。

## 七、刷完的验证清单（移动端 390×844 + 桌面 1440）

1. 模型选择器：长模型名以 `…` 收尾、不溢出弹层。
2. 会话头「展开侧栏」：能开出全屏抽屉（文件/上下文/…/TeamsX/终端/浏览器都在）。
3. TeamsX 三个入口：会话头徽标浮窗、右栏 tab（抽屉 guide 里的 TeamsX 胶囊）、左栏活动栏图标 → 主栏面板。
4. TeamsX 面板排版：任务行不错位、成员状态不悬出卡片。
5. 远程访问：二维码/固定访问口令可连。
