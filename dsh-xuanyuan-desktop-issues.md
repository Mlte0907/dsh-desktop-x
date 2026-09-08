# dsh-xuanyuan-desktop 实测问题清单

> 测试时间：2026-09-01
> 测试环境：aarch64 Linux / XFCE / Electron 44.1.0 / 后端 node 独立进程
> 测试方式：真实启动 + 合成输入（xdotool）+ 截图识图 + PSS/RSS 内存采样 + 源码审读
> 本清单只列现象与证据，不含修复方案。

---

## 一、实测复现的问题

### 1. 托盘图标在 XFCE 上未注册，托盘菜单整套不可达

- **现象**：StatusNotifierWatcher 的 `RegisteredStatusNotifierItems` 属性中无本应用条目（多次查询一致）。托盘菜单的全部功能——打开 DeepSeek Harness / 后端状态显示 / 重新连接 / 重启后端 / 停止后端 / 退出前端——因此均不可达。
- **对照**：旧 Tauri 壳的托盘在同一面板、同一会话中注册成功且可编程点击，说明面板的 StatusNotifier 支持本身正常。
- **影响**：唯一交互入口退化为全局快捷键 `Super+Shift+D`。
- **验证方式**：`gdbus call ... org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems`。

### 2. 快捷键唤回出现退化窗口

- **现象**：`Super+Shift+D` 隐藏方向正常（窗口消失，进程留存）。再次按键唤回时，X 窗口树中出现 `200x200 @ 0,0` 的 "electron" 类窗口，屏幕上呈现为空壳（透出其后方的其他窗口），未见恢复到保存的 1290x864 @ 274,100 边界。
- **旁证**：`~/.config/dsh-xuanyuan-desktop/window-bounds.json` 中保存的边界值本身是正确的。
- **待区分**：合成按键（xdotool）与真实键盘的行为可能不同，需真键盘复测确认。
- **验证方式**：窗口树快照（xwininfo -root -tree）+ 分窗口截图识图。

### 3. 两个小尺寸 "electron" 辅助窗口常驻 X 窗口树

- **现象**：`10x10 @ 10,10` 与 `200x200 @ 0,0` 两个 WM_CLASS 为 "electron" 的窗口长期存在。
- **影响**：无直接功能影响，但会干扰按窗口类/尺寸做的自动化与截屏定位（本次测试中多次误判）。

### 4. 隐藏后内存不下降

- **现象**：窗口可见 PSS ≈ 333 MB（10 进程），隐藏后 PSS ≈ 343 MB（11 进程）；RSS 口径 1014 → 714 MB。
- **对照**：项目 README 已声明此为设计取舍（隐藏时保留 renderer 以维持页面状态，"torn-down on show would lose scroll position"）。列在此处仅作实测记录。
- **对照数据（旧 Tauri 壳）**：收起即销毁渲染进程，992 MB → 553 MB。

### 5. 重启后 12 秒时窗口仍停留在本地壳页

- **现象**：杀掉前端后重新启动，+12 秒截图显示窗口内容为本地 Codex 风格壳页（"下午好呀…"），尚未观察到 dsh web 页面接管完成。
- **待区分**：webview 接管可能只是较慢（后端已复用、理论上只需导航），未能二次截图确认；且本次截图受前台窗口遮挡问题干扰过。

---

## 二、代码审读发现（未运行触发，语义确定性高）

### 6. `BackendManager.stop()` 使用进程组杀，会连带终止 dsh 派生的子进程

- **位置**：`src/main/backend.ts` stop()：`process.kill(-state.pid, 'SIGTERM')`（负 pid = 整个进程组）。
- **风险**：dsh 运行中派生的工具子进程（agent 起的 shell、构建等）同属该进程组，会被一并终止。
- **背景**：旧 Tauri 壳在 2026-08-31 的「重启后端连带杀掉所有进程」事故（桌面会话被带走）根因即为组杀，旧壳的修复方向是废除组杀、只对精确 pid 动手。

### 7. `stop()` 的 kill 仅校验 pid 存活，存在 pid 复用误杀风险

- **位置**：`src/main/backend.ts` stop()：`readState()` 取 pid 后仅做 `pidAlive()` 校验。
- **风险**：状态文件中的 pid 过期后被系统复用给无关进程时，stop 会向该进程发 SIGTERM（且经进程组扩大）。
- **旁证**：state 文件以明文 pid 长期落盘，跨重启长期有效，复用概率随时间上升。

---

## 三、待确认（未完成验证）

### 8. 单实例锁是否存在

- 首 50 行源码未见 `requestSingleInstanceLock`，全文件搜索因故未完成。若缺失：双开会产生双窗口、双健康轮询与端口竞争。

### 9. 主进程异常是否有落盘

- 未在源码中见到 `uncaughtException` / `unhandledRejection` 兜底；当前异常仅进启动终端的 stdout，进程消失后无堆栈可查。

---

## 四、实测通过项（供对照，非问题）

- 后端复用：外部后端（pid 24558）在多次前端重启过程中未被触碰，探针 401 → `reused: true` 路径正确。
- 前端退出后端存活：多次终止前端进程，后端持续运行。
- 分离式 spawn（detached + unref）+ pid 落盘：源码与行为一致。
- 快捷键隐藏方向：正常。
- token 恢复链路：壳自身日志 + `/proc` 扫描运行中后端的 stdout 落盘文件，双通道设计成立。

---

## 五、测试方法局限（影响部分结论的置信度）

- 全部按键为合成输入（xdotool），未做真键盘对照。
- 截图受前台窗口遮挡影响，中途改为「最小化遮挡窗 + 按窗口类名精确匹配」后才可靠；此前有两轮结论因此误判（一轮把遮挡窗当成了壳窗口，一轮按错误的窗口类搜索漏掉了真实窗口）。
- 内存为 PSS/RSS 采样口径；后端 node 内存随使用波动（300–430 MB），单次采样不代表稳态。
