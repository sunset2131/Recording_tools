# 录制工具证据包优化设计

## 1. 背景与目标

当前 `tools/Recording_tools` 仅保存用户操作事件。它可以说明用户点击或输入了什么，但无法完整还原操作发生时的页面状态、SPA 路由、网络结果和前端错误，导致后续人工或 AI 生成自动化测试时需要重新访问目标系统并猜测页面行为。

本次升级的目标是生成一次录制即可复盘的结构化证据包，供开发人员或 AI 后续生成测试脚本。升级不包含业务检查点、断言编辑器或自动脱敏功能。

## 2. 范围

### 包含

- 保留现有本地 Web 控制页、Node 服务和 Playwright 浏览器录制流程。
- 记录逻辑步骤和未经归并的原始事件。
- 连续输入归并为最终值的一次 `fill` 事件。
- 记录页面、标签页、iframe、弹窗、下载和 SPA 路由变化。
- 保存步骤前后的截图、精简 DOM、URL 和页面标题。
- 保存请求/响应元数据、失败原因和小型文本/JSON 响应体。
- 保存控制台警告、错误、未捕获异常和页面错误。
- 输出总索引、兼容版动作 JSON、JSONL 日志和可选 Playwright Trace。
- 输出 README，说明使用、查看和让 AI 阅读证据包的方法。

### 不包含

- 本次不实现人工添加检查点或业务断言。
- 不自动脱敏表单输入值；但默认排除 Cookie、Authorization 和其他认证请求头。
- 不保存图片、字体、视频等二进制网络响应体。
- 不改造为浏览器扩展或 CDP 常驻服务。

## 3. 模块设计

`custom-recorder.js` 作为子进程入口，读取环境配置、启动录制会话并接收 IPC 停止消息。采集和写入职责拆分为以下模块：

- `browser-session.js`：管理 Browser、Context、Page、Frame 身份及导航、弹窗、下载和页面生命周期。
- `event-capture.js`：采集 DOM 事件、归并连续输入、生成逻辑步骤。
- `evidence-capture.js`：执行截图、DOM 快照、网络、控制台、页面错误和 Trace 采集。
- `locator-analyzer.js`：生成 testId、role/name、label、placeholder、唯一 CSS 和 XPath 候选，计算唯一性与稳定性评分。
- `evidence-writer.js`：创建会话目录、执行原子写入、输出索引并验证引用完整性。

模块之间通过带有 `sessionId`、`pageId`、`frameId`、`stepId` 和时间戳的事件对象通信。采集失败只影响对应证据项，不能阻断原始动作保存。

## 4. 数据流

1. 服务端创建输出目录并启动带 IPC 通道的录制子进程。
2. 录制器为每个 Page 和 Frame 分配稳定的会话内 ID。
3. 页面事件、导航、网络、控制台和浏览器生命周期事件先写入内存缓冲区及 JSONL 缓冲。
4. 事件捕获器将输入事件按元素和时间窗口归并，并生成逻辑步骤。
5. 每个有效步骤建立前后页面状态，写入截图和 DOM 快照，并关联时间窗口内的网络、控制台事件。
6. 定位分析器为目标元素生成候选定位及 `unique`、`score` 信息。
7. 收到停止消息或浏览器关闭后，录制器关闭浏览器、等待异步事件、写入索引和兼容版 JSON。
8. 写入器检查所有索引引用。完整时设置 `complete: true`，否则设置 `complete: false` 并写入警告。

## 5. 输出结构

每次录制一个目录：

```text
output/<日期_流程名>/
  evidence.json
  actions.json
  network.jsonl
  console.jsonl
  pages/
    state-0001.png
    state-0001.html
  responses/
  downloads/
  trace.zip
  <流程名>_此文件请发给开发人员.json
```

`evidence.json` 是 AI 和人工的首选入口，至少包含：

- `schemaVersion`、录制版本和运行环境。
- 流程名、起始 URL、时间、浏览器、平台和 `complete` 状态。
- 文件索引、缺失文件和警告。
- 按顺序排列的 `steps`。

每个步骤至少包含：

- `stepId`、操作类型、时间戳、`pageId`、`frameId`。
- 目标元素快照和多套定位候选。
- `before` 与 `after` 页面状态：URL、标题、截图和 DOM 文件。
- 关联的网络请求 ID 和控制台事件 ID。
- 新标签页、弹窗、下载或 SPA 路由变化等附加事件。

`actions.json` 保留原始事件，兼容版 JSON 保留现有 `metadata` 和 `actions` 字段。`network.jsonl` 和 `console.jsonl` 采用一行一条事件，便于流式读取。

## 6. 网络与隐私策略

网络默认记录方法、URL、资源类型、状态码、耗时、失败原因、Content-Type、步骤关联和页面关联。请求头只保留非敏感诊断字段，明确排除 Cookie、Authorization、Proxy-Authorization、Set-Cookie 和类似认证字段。

响应体仅在配置允许且满足以下条件时保存：Content-Type 为 JSON、HTML 或文本；大小低于配置上限；不是媒体、字体或二进制资源。响应体单独保存并由网络事件引用。超限或跳过时记录原因，不伪装成完整响应。

## 7. 错误处理与兼容性

- 使用临时文件写入，再原子重命名，避免半截 JSON 被标为成功。
- 浏览器异常关闭仍尝试写出当前缓冲；若无法完成，`complete` 必须为 `false`。
- 截图、DOM、网络、控制台或 Trace 单项失败时写入 `warnings` 并继续保存其他证据。
- 服务端只有在 JSON 可解析、文件非空且完整性校验通过时才报告成功。
- 原有输出 JSON 继续生成，旧消费者无需立即迁移。
- 所有路径使用 `path.join`，文件名继续进行 Windows 保留字符清理。

## 8. 验证方案

### 单元测试

- 输入归并只保留最终值，跨元素或超时后正确拆分。
- 定位候选生成、唯一性检测和评分排序。
- JSON、JSONL 和原子写入失败时产生正确警告。
- 敏感请求头被排除，响应体按 Content-Type 和大小规则处理。

### 集成测试

- 静态页面：点击、输入、选择、复选框和 Enter。
- SPA：pushState、replaceState、popstate 和无完整刷新内容更新。
- 新标签页、iframe、弹窗、下载和网络失败。
- 正常停止、浏览器手动关闭、录制进程异常退出。
- 每次测试验证 `evidence.json` 可解析、引用文件存在、兼容版 JSON 仍可读取。

### 人工验收

用一个公开站点和一个本地 SPA 各录制一次，确认不重新打开目标系统也能从证据包还原：操作顺序、页面 URL/标题、操作前后截图和 DOM、触发请求及控制台错误。

## 9. README 要求

新增 `tools/Recording_tools/README.md`，使用中文说明：

- 启动工具、打开控制页和开始/停止录制。
- 输出目录结构以及每个文件的用途。
- 先读 `evidence.json`，再按需读 `actions.json`、JSONL、HTML、截图和 Trace。
- `complete`、`warnings` 和完整性失败的处理方式。
- 明确当前没有业务断言和自动脱敏。
- 提供以下 AI 使用提示词：

```text
请先阅读此录制目录中的 README.md，再读取 evidence.json。
以 evidence.json.steps 作为逻辑步骤主线，根据每一步的 before/after、locators、networkRequestIds 和 consoleEventIds 还原流程。
仅在需要排查时读取 actions.json、network.jsonl、console.jsonl、pages/*.html、截图和 trace.zip。
优先使用 score 高且 unique=true 的 role、label、testId 定位；不要直接把唯一 CSS/XPath 当作稳定定位器。
请输出测试目的、步骤、可观察结果、断言建议、Playwright 脚本，以及无法从证据确定的业务预期。
```

## 10. 后续升级边界

检查点标记功能作为独立后续升级：由控制页关联最近一步，允许录制人员填写预期并选择 URL、文本、可见性、数量或接口状态等断言类型。本次设计只预留步骤和状态的关联字段，不实现该交互或断言执行。
