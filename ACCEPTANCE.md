# dsh-xuanyuan-desktop 验收文档

> 版本：v0.2（2026-09-01）
> 环境：Armbian 26.8.3 noble / aarch64 / XFCE 4.18 + X11 / Electron 44.1.0
> 项目根：`/home/xiaoxin/dsh-xuanyuan-desktop`
> 本文供验收方逐项执行验证命令并对照预期结果。全部命令可在任意终端执行，
> 涉及 GUI 的需要 `DISPLAY=:0`。

---

## 一、架构速览（验收前的背景知识）

```
桌面壳（Electron，~547MB PSS）
 ├─ 本地外壳 UI（frameless 窗口，自绘标题栏 + 骨架屏）
 │    └─ <iframe src=http://127.0.0.1:3080>   ← 同进程渲染，继承 persist:dsh 会话
 ├─ 主进程 webRequest：cookie 注入 + 401 授权墙检测
 ├─ BackendManager：探测 → 复用 / spawn(detached) / systemctl
 └─ 托盘（SNI）+ 全局快捷键 Super+Shift+D
                │ detached + unref
                ▼
dsh web 后端（node，独立进程组，~358MB PSS）
 └─ systemd user unit dsh-web.service（enabled，登录自启）
```

与初版相比的四个关键架构决策（均有实测依据，见第三节）：

| 决策 | 原因 |
|---|---|
| 后端页面用 `<iframe>` 而非 `<webview>` | `<webview>`（OOPIF 独立进程）在软件渲染下**间歇性永久黑帧**，reload/invalidate/hide-show 均不可自愈 |
| 窗口 `webPreferences.partition = persist:dsh` | iframe 继承窗口会话；不设则 cookie 与 webRequest 监听全部落在 defaultSession |
| `onBeforeSendHeaders` 显式注入 cookie | file:// 外壳内嵌 http://127.0.0.1 是跨站上下文，Chromium **拒发** SameSite=Strict cookie（curl 带 cookie 即 200 可证） |
| 后端 cwd = 用户家目录 | dsh 会话按启动目录分组（`~/.dsh/sessions/--home-xiaoxin--/`）；用 checkout 作 cwd 会得到全新空分组，表现为"没有会话记录" |

---

## 二、本轮修复清单（对照 issues.md 的 9 条 + 新发现 4 条）

### issues.md #1 — 托盘未注册【已过期 → 闭环】

原因：测试时 XFCE 尚缺 StatusNotifier 渲染插件（noble 的包名是
`xfce4-sntray-plugin`，**不存在** `xfce4-statusnotifier-plugin`）。

```bash
# 预期：输出包含 StatusNotifierItem-<pid>-1
gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
  --method org.freedesktop.DBus.ListNames | grep -o StatusNotifierItem-[^']* | head -1
```
实测：已注册；面板特写可见蓝鲸图标 + 绿色在线状态点。

### issues.md #2 — 快捷键唤回出现 200×200 空壳【无法复现，判定误判】

合成输入 3 轮 hide/show 循环：隐藏均生效、恢复几何均为 1947×1302
（= 保存的 1290×864 × 1.5 HiDPI，数值吻合），期间无 200×200 可见窗口。
issues.md 自述截图曾受遮挡干扰，200×200 恰为其 #3 辅助窗尺寸。

```bash
# 复测（合成输入版）；真键盘对照见第五节人工项
for i in 1 2 3; do
  DISPLAY=:0 xdotool key --clearmodifiers Super+Shift+d; sleep 1.5
  DISPLAY=:0 xdotool key --clearmodifiers Super+Shift+d; sleep 1.5
  DISPLAY=:0 xdotool getwindowgeometry \
    $(DISPLAY=:0 xdotool search --onlyvisible --name "DeepSeek" | head -1) | grep Geometry
done
# 预期：三次均为 Geometry: 1947x1302（或与 window-bounds.json 成 1.5 倍）
```

### issues.md #6 — stop() 进程组杀连带【成立 → 已修】

`process.kill(-pid)` 会带走 agent 运行中派生的全部子进程（旧 Tauri 壳曾因此
带走整个桌面会话）。已改为**仅对后端 pid 本身**发 SIGTERM（dsh 自带 5s 优雅退出）。

```bash
# 预期：后端停止；前端仍在
cd /home/xiaoxin/dsh-xuanyuan-desktop
E=$PWD/node_modules/electron/dist/electron R=$PWD
DISPLAY=:0 $E $R --quit 2>/dev/null; sleep 2   # 先确保壳在跑（重新启动它）
DISPLAY=:0 nohup $E $R >/dev/null 2>&1 & sleep 12
# 通过 UI/IPC 触发停止后端后：
pgrep -af 'bin.js web'   # 预期：无输出（后端停了）
pgrep -cf "$R"           # 预期：>0（前端还在）
systemctl --user start dsh-web.service   # 测完恢复
```

### issues.md #7 — pid 复用误杀【成立 → 已修】

stop 前新增 `isDshBackendPid()`：读 `/proc/<pid>/cmdline` 校验含 `bin.js` 与
`web`，非 Linux 降级为仅 pidAlive。pid 被复用给无关进程时不再误杀。

### issues.md #8 — 单实例锁缺失【误报】

`app.requestSingleInstanceLock()` 一直存在于 `src/main/index.ts`；
第二实例启动会被拒绝并唤起已有窗口（本清单作者的搜索中断导致漏检）。
另外新增 CLI 通道：`electron <appPath> --quit`（见 #SIGTERM 条目）。

### issues.md #9 — 异常无落盘【成立 → 已修】

```bash
# 预期：文件存在且可读（无异常时可为空）
cat ~/.dsh/desktop/shell.log
```
`uncaughtException` / `unhandledRejection` 均写入该文件（含堆栈）。

### 新发现 A — SIGTERM 无法退出（进程树残留）【已修，重要】

Chromium 在 C 层覆盖 SIGTERM 处理，其行为是"关闭窗口"→ 被托盘应用的
close-preventDefault 拦下 → shutdown 卡死，9 进程残留 ~550MB。
**`process.on('SIGTERM')` 在 Electron 主进程不会触发。**

修复：`quit()` 改用 `app.exit(0)`（立即退出并收割子进程）+ `markQuitting()`
放行 close；外部退出走 `--quit` CLI（经 second-instance 转发）。

```bash
E=/home/xiaoxin/dsh-xuanyuan-desktop/node_modules/electron/dist/electron
R=/home/xiaoxin/dsh-xuanyuan-desktop
DISPLAY=:0 nohup $E $R >/dev/null 2>&1 & sleep 12
DISPLAY=:0 $E $R --quit; sleep 4
pgrep -cf "$R" || echo 0   # 预期：0（全部收割）
systemctl --user is-active dsh-web.service   # 预期：active（后端无恙）
```
注意：**直接 `kill <前端主进程>` 仍会触发上述 Chromium 行为**（窗口隐藏、进程
残留）——这是平台限制，退出请用托盘项或 `--quit`。README 已声明。

### 新发现 B — webview 黑屏（issues #5 的真身）【已修，架构级】

`<webview>`（OOPIF）在禁 GPU 软件渲染下间歇性永久黑帧：DOM 加载完成、骨架
屏按 `did-finish-load` 隐藏、画面永黑；reload / `invalidate()` / hide-show
均无效，且**跨重启随机出现**（实测 14:02 一次正常、之后两次全黑）。

修复：后端页面改用 `<iframe>`（同进程渲染），黑屏路径不复存在。
压测 3 次冷重启：窗口 624-880ms，截图均为 ~275KB（黑屏特征值 ~133KB），
0 次 401。

```bash
# 复测：连续重启 3 次，截图字节数应稳定在 ~270KB 档（13 万 B 档即黑屏）
for run in 1 2 3; do
  DISPLAY=:0 $E $R --quit 2>/dev/null; sleep 2
  DISPLAY=:0 nohup $E $R >/dev/null 2>&1 & sleep 12
done
```

### 新发现 C — iframe 会话错位【已修，伴随 iframe 改造】

iframe 继承窗口 session；窗口必须设 `partition: 'persist:dsh'`，否则
cookie 写入 defaultSession 而 webRequest 监听 persist:dsh，认证永远失败。

### 新发现 D — SameSite=Strict cookie 跨站不发送【已修，隐蔽】

file:// 外壳内嵌 http://127.0.0.1:3080 属跨站上下文，Chromium 拒发后端的
Strict cookie——token 交换明明成功（303 + Set-Cookie），后续请求却全部 401。
curl 对照实验可证后端与 cookie 完全正常：

```bash
TOKEN_URL=$(grep -oE 'dsh web: \S+' ~/.dsh/dsh-web.log | tail -1 | awk '{print $3}')
curl -s -c /tmp/jar -o /dev/null -w '%{http_code}\n' "$TOKEN_URL"        # 303
curl -s -b /tmp/jar -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/  # 200
```

修复：主进程 `onBeforeSendHeaders` 把 session 中已存储的 cookie 显式注入请求头
（cookie 一直存着，只是从不自行发送）。修复后压测 401 计数为 0。

### 新发现 E — 会话列表为空（cwd 分组）【已修】

dsh 会话按后端启动目录分组。此前 systemd unit 与 shell spawn 均以
`/home/xiaoxin/deepseek-harness` 为 cwd → 全新空分组 → 桌面端"没有会话"，
而浏览器端（用户自己从家目录启动的后端）有 8 个历史会话。

修复：spawn cwd 与 systemd `WorkingDirectory` 均改为 `/home/xiaoxin`
（可用 `DSH_BACKEND_CWD` 覆盖）。

```bash
bp=$(pgrep -f 'bin.js web' | head -1)
ls -l /proc/$bp/cwd        # 预期：→ /home/xiaoxin
ls ~/.dsh/sessions/        # 预期：仅 --home-xiaoxin--
ls ~/.dsh/sessions/--home-xiaoxin--/ | wc -l   # 预期：8
```

⚠️ 首次在桌面壳里仍需**手动选择一次工作区**：dsh web 把"当前工作区"存在
浏览器 localStorage，桌面壳 iframe 的 localStorage 是全新独立的（与浏览器
profile 天然隔离）。这是存储隔离的固有差异，选一次即永久（该 localStorage
持久在 Electron 的 persist:dsh 分区）。**这不是数据丢失**——8 个会话都在
磁盘上，选择工作区后即出现。

### 新发现 F — Agent 预设与模型列表"加载不出来"（WebSocket cookie 未注入）【已修，隐蔽】

**症状**：会话与消息正常，但输入区下方的"Agent 预设"下拉要么不显示选项
要么整体不见，"模型"下拉点击后转圈空表。

**根因**：dsh 前端与后端的核心 RPC 走 **WebSocket**（`ws://…/api/remote.mux`，
在 iframe 控制台里即 `Remote stream WebSocket failed to open` 持续重试）。
cookie 注入的 `webRequest` 过滤规则写成了 `http://127.0.0.1:3080/*`——而
Chromium 的 webRequest **按 URL scheme 过滤**，`ws://` 与 `http://` 不互通。
结果是：HTTP 请求的 cookie 被注入（→ 0 次 401），但 WebSocket 升级请求**始终
不带 cookie** → 握手被拒 → 整个 RPC 流瘫掉 → 一切依赖实时 RPC 的功能（预设
列表、模型列表、会话内交互）都不工作。

仅靠主进程侧的 fetch 探测会发现"接口正常"而漏掉这个分支，因为探测全是
HTTP。诊断靠的是 `--remote-debugging-port` + CDP：
```bash
$E $R --remote-debugging-port=9222 &
curl -s http://127.0.0.1:9222/json     # 列出 iframe target
# 通过 webSocketDebuggerUrl 连入，Runtime.evaluate 拿到 iframe 控制台
# 或 Network.enable 后观察 webSocketFrameError
```

**修复**：filter 同时包含 `ws://`（从 `BACKEND_BASE_URL` 派生）：
```ts
const base = C.BACKEND_BASE_URL
const filter = { urls: [`${base}/*`, `${base.replace(/^http/, 'ws')}/*`] }
```

**验证**：
```bash
# iframe 控制台应不再出现 "Remote stream WebSocket failed to open"
# textHead 中应能看到 "自主模式" / "Full access" / 模型名 等字段
```

**教训**：凡是把 cookie 注入当成跨站 iframe 解法的方案，过滤规则必须显式
覆盖所用协议；后端若同时暴露 HTTP API 和 WebSocket，`http://` 的过滤只解决
一半。

### 新发现 H — `--quit` 调用者实例不退出【待修，验收方实测 2026-09-02】

**症状**：`electron <root> --quit` 的预期语义是"转发退出后调用者自灭"。实测：
旧前端实例（10 进程）正常退出、后端 systemd 服务不受影响（active ✓），但
**调用者实例自己没有退出**——11 个 electron 进程留在系统里，反向接管成了
新前端。验收清单第 1 项"前端归零"按字面未达成。

**根因**：第二个实例 `requestSingleInstanceLock()` 失败后走 `app.quit()`
（index.ts:221），而 **app ready 之前调用 quit() 在本平台是空操作**——与
`quit()` 自身注释（index.ts:129-132「quit() 级联重入 close 路径卡死」）记录
的是同一类问题。

**修法（一行）**：`!gotLock` 分支的 `app.quit()` → `app.exit(0)`（与 quit()
的既有结论同源：exit() 立即终止并收割子进程）。

**修后复测**：
```bash
E=.../node_modules/electron/dist/electron; R=<项目根>
DISPLAY=:0 $E $R >/dev/null 2>&1 & sleep 12      # 先起一个实例
DISPLAY=:0 $E $R --quit; sleep 4
pgrep -cf dsh-xuanyuan-desktop                    # 预期：0
systemctl --user is-active dsh-web.service        # 预期：active
```

### 新发现 G — 会话列表显示"未分组"组名（UI 视图偏好，非 bug）【已澄清，2026-09-01 收尾】

**症状**：网页端会话列表为扁平单列表、无组名；桌面端在会话上方显示"未分组"组名。

**根因**：工作区浏览器的"分组方式"偏好存于 localStorage 键 `dsh.workspace.view.v5`
（`deepseek-harness/packages/client/ui-workspace/src/client/stores.ts`），默认值
`groupBy: 'workspace'`。
- `workspace` 模式：会话按 workspace 分组渲染，未归属任何 workspace 的会话落入
  `UNGROUPED_KEY=''` 桶（`tree.ts`：`groupByWorkspace()` 的 stray 分支）→ 显示"未分组"
- `flat` 模式（单列表）：纯扁平列表，不显示任何组名

桌面壳使用 `persist:dsh` 独立 partition，其 localStorage 全新为空 → 取默认值
`workspace` → 显示"未分组"。用户浏览器早已手动切到 `flat`，故两端视图不同。
**会话数据完全一致（同一后端），仅显示方式不同，不是数据丢失。**

**对齐方式**：在桌面壳内点"视图选项（个性化图标）→ 分组方式 → 单列表"，
该选择持久化进桌面壳自己的 `dsh.workspace.view.v5`，之后两端一致。

**复测核对**：
```bash
# 桌面壳 partition 的 localStorage（路径示例，按实际 Partition 目录调整）
# 关键键：dsh.workspace.view.v5，值含 "groupBy":"flat" 即与网页端一致
# 该偏好不跨 profile 同步——每台新机器/清空 partition 后默认回到 workspace 模式
```

---

## 三、七项原始需求的验收结果

| # | 需求 | 结果 | 验证方式 |
|---|---|---|---|
| 1 | 启动快 | ✅ 窗口 624-909ms（后端 5.1s 藏于骨架屏） | 计时脚本 |
| 2 | 缩放到托盘 | ✅ close → hide，进程留存 | `xdotool windowclose` 后 `--onlyvisible` 查不到 |
| 3 | 前端关、后端续跑 | ✅ detached spawn + unref；`--quit` 后 0 前端进程、后端 active | `--quit` 流程 |
| 4 | 双击自动拉起后端 | ✅ 探测 401=复用 / ECONNREFUSED=拉起（systemd 优先） | 代码路径 + 实测 |
| 5 | 后端在跑则直连 | ✅ `reused: true`，从不重启；Cookie 复用 0×401 | 后端重启前后对比 |
| 6 | 蓝鲸图标 | ✅ hicolor 5 尺寸 + 桌面图标 + 标题栏 | 截图 |
| 7 | 托盘显示在线状态 | ✅ 四态图标（在线绿点/启动琥珀/离线灰/异常红）+ 菜单文字 | 截图 + gdbus |

---

## 四、实测数据汇总（PSS，/proc/*/smaps_rollup）

| 场景 | 数值 |
|---|---:|
| 运行稳态（禁 GPU，默认） | ~547 MB |
| 运行稳态（DSH_ENABLE_GPU=1） | ~398 MB，但 webview 时代黑屏；iframe 时代未测，默认仍禁 |
| 隐藏到托盘 | 与可见态 ±5MB（渲染进程保活以维持页面状态） |
| 退出前端后 | **0 进程** |
| dsh 后端 node | ~358 MB（插件树开销，与壳无关） |

---

## 五、需人工验收项

1. **真键盘快捷键对照**：issues #2 与本项目全部测试均为 xdotool 合成输入。
   请用真键盘按 `Super+Shift+D` 数次，确认隐藏/唤回正常、无 200×200 空壳。
2. **真鼠标托盘交互**：点击托盘蓝鲸图标 → 菜单各项（打开/日志/重启/停止/退出）
   逐一点击确认；确认"退出前端并释放内存"后 `pgrep -cf dsh-xuanyuan-desktop` 为 0。
3. **真鼠标工作区选择**：首次在桌面壳内选择工作区，确认 8 个历史会话出现，
   且重启桌面壳后选择被记住（localStorage 持久性）。

---

## 六、已知限制（设计内，非缺陷）

- `kill <前端>` / SIGTERM 不能退出前端（平台限制，见新发现 A）；退出用托盘或
  `--quit`。注销/关机时 X 连接断开，进程会随之终止。
- 桌面壳与浏览器的 dsh web UI 偏好（选中工作区等 localStorage 项）互相独立。
- 外部启动的后端若 stdout 指向管道/终端（非文件），token 自动发现失败 → 走
  授权墙 UI，需"重启后端并授权"一次；stdout 落文件的（nohup、systemd）均可自动发现。
- GNOME 无原生托盘（需 AppIndicator 扩展）；本机 XFCE 已装 sntray 插件。
- Electron 二进制经 npmmirror 下载（github releases 在本机不可达）。

## 七、环境变量参考

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_ENABLE_GPU` | 未设（禁） | 设 `1` 开硬件加速（有真 GPU 的机器） |
| `DSH_TOGGLE_ACCEL` | `Super+Shift+D` | 全局快捷键 |
| `DSH_BACKEND_CWD` | `$HOME` | 后端工作目录（决定会话分组） |
| `DSH_HARNESS_ROOT` | `/home/xiaoxin/deepseek-harness` | 仓库位置 |
| `DSH_NODE_BIN` | `/home/xiaoxin/.hermes/node/bin/node` | Node 解释器 |
| `DSH_HOME` | `~/.dsh` | 必须与后端一致（cookie secret 所在） |
| `DSH_WEB_PORT` | `3080` | 固定端口（cookie 绑定 authority） |

## 八、验收清单（逐项打勾）

- [ ] `--quit` 后 `pgrep -cf dsh-xuanyuan-desktop` = 0，后端仍 active
      （2026-09-02 验收实测：后端 active ✓，前端 11 进程残留 ✗——见新发现 H，修后复测）
- [ ] 冷启动 3 次，每次窗口 <1.5s、截图无黑屏（~275KB 档）、401=0
- [ ] 托盘图标四态正确切换（停止后端 → 灰；重启 → 绿）
- [ ] `stop 后端` 后 `pgrep -af 'bin.js web'` 为空，且 agent 子进程（若有）存活
- [ ] 后端 cwd = /home/xiaoxin，桌面壳内可选到 8 个历史会话
- [ ] `cat ~/.dsh/desktop/shell.log` 可读（当前为空属正常）
- [ ] 真键盘 `Super+Shift+D` 往返正常（人工）
- [ ] 真鼠标托盘菜单全项可用（人工）

---

## 九、优化迭代建议（验收方补充，2026-09-02）

### 9.1 工程保障（立即做）

1. **git init + 首提交**：本项目当前**无版本控制**。旧 Tauri 壳就是因此把「误删」
   变成不可挽回的——全部源码、三个 git 提交、构建产物已随目录删除消失，且无备份。
   本目录（含 ACCEPTANCE.md / issues.md / README）是现存唯一副本。
   建议排除项：`node_modules/`、`dist/`、`build/`。
2. **退化 bounds 过滤**：`persistBounds` 落盘前丢弃 `width < 400` 的采样值。
   issues #2 虽判定为辅助窗误判，但 hide 期间 Electron 确实会发出退化 resize，
   这道防线是免费保险（配合 show 后 `setBounds(saved)` 显式恢复更稳）。

### 9.2 功能补全

3. **右键菜单**：dsh 页面在壳内目前右键无菜单。Electron 的 `Menu` roles
   （copy / cut / paste / selectAll / reload）在 Linux 是真实现（直接调
   webContents 原生命令，不走 muda 那条 GTK 空实现路径），成本很低。
4. **`--quit` 调用者退出**：见新发现 H（一行修复：`!gotLock` 分支
   `app.quit()` → `app.exit(0)`），修后验收清单第 1 项可勾。

### 9.3 健壮性 / 打磨

5. **托盘 XFCE 注册排查**：先用 20 行最小 Electron 脚本隔离（是否 Electron 44
   tray 实现问题）；若确认无解，备选方案是独立 ksni 托盘小进程（纯 DBus，
   旧壳已在本面板验证可行）。
6. **健康轮询降频**：连续稳定 N 次后 3s → 15s，异常时立即恢复 3s（CPU 白拿）。
7. **webview 崩溃恢复入口**：渲染进程崩溃/`did-fail-load` 时 shell.log 已有
   记录，UI 上可加一个「重新加载」按钮兜底（iframe 时代黑屏路径已不存在，
   但恢复入口仍是廉价保险）。
8. **cookie 注入协议清单**：当前 filter 覆盖 `http` + `ws`；将来若启用
   `wss`（TLS）需同步补充，注释里已有伏笔。

### 9.4 测试方法沉淀（本轮验证有效）

9. **GUI 视觉回归链路**：最小化遮挡窗（ZCode）→ 按窗口类
   （`dsh-xuanyuan-desktop`，注意不是 `electron`——那是 10x10/200x200 辅助窗）
   激活目标窗 → 全屏截图按窗口几何裁剪 → 识图对比。每轮迭代跑一遍
   首屏/托盘态/唤回三张，防止「computed style 对了但画面不对」类的盲区。
10. **冷启动验收脚本**：ACCEPTANCE.md 新发现 B 的三连重启 + 截图字节数判据
    （~275KB 正常档 vs ~133KB 黑屏档）已可脚本化，建议收进 `scripts/`。
