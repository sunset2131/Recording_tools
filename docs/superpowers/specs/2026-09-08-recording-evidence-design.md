# 录制工具证据包优化设计

## 1. 背景与目标

当前 `Recording_tools` 仅保存用户操作事件。它可以说明用户点击或输入了什么，但无法完整还原操作发生时的页面状态、SPA 路由、网络结果和前端错误，导致后续人工或 AI 生成自动化测试时需要重新访问目标系统并猜测页面行为。

本次升级的目标是生成一次录制即可复盘的结构化证据包，供开发人员或 AI 后续生成测试脚本。升级不包含业务检查点、断言编辑器或自动脱敏功能。

已确认的默认取舍：每个逻辑步骤前后采集独立状态；默认开启 Trace 但不录视频；文本/JSON 响应体单项上限 1 MB；DOM 快照单项上限 5 MB；连续输入的原始事件全部保留而逻辑步骤只保留最终值；停止请求优雅等待 15 秒后才允许强制兜底；同源 iframe 深采集、跨域 iframe 只采集边界信息；继续输出兼容版动作 JSON。

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

### 4.1 事件与状态规则

- `actions.json` 保留全部原始事件；每个逻辑步骤通过 `rawEventIds` 显式引用其来源，禁止依赖时间猜测关联关系。
- 连续输入按元素和 800 ms 窗口归并。停止时先刷新尚未提交的输入缓冲，以当前 DOM `value` 生成最终 `fill`。
- 操作后的状态等待导航或 SPA 路由事件；没有路由变化时等待网络空闲，最多 2 秒。实际等待原因和耗时写入状态元数据。
- `pushState`、`replaceState` 和 `popstate` 作为独立生命周期事件，并关联触发它们的逻辑步骤。
- 每次录制使用全新的隔离 BrowserContext，不读取用户现有 Chrome 配置；登录由录制人员在流程中手动完成。
- 所有实体使用会话内稳定 ID：逻辑步骤为 `step-0001`，页面状态为 `state-0001`，网络事件为 `req-0001`，控制台事件为 `console-0001`。每个实体同时记录 ISO 8601 UTC 时间和自录制开始起的单调耗时。
- 每个逻辑步骤的 `before` 与 `after` 必须各自创建新的页面状态 ID，即使两个快照内容相同也不得复用同一状态文件。
- 网络事件保留全局生命周期，并使用 `stepIds` 数组关联一个或多个逻辑步骤；关联基于请求开始时间和步骤状态采集窗口，不只关联单一最近步骤。

## 5. 输出结构

每次录制一个目录，名称格式为 `<YYYY-MM-DD>_<流程名>_<HHmmss>_<四位短随机ID>`。即使同秒录制同名流程也必须生成不同目录，绝不覆盖既有产物；临时文件不属于最终证据包，也不得进入分发 ZIP。

```text
output/<YYYY-MM-DD>_<流程名>_<HHmmss>_<四位短随机ID>/
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
- `before` 与 `after` 页面状态：独立的状态 ID、URL、标题、视口 PNG 截图、DOM 文件、稳定等待原因和耗时。截图只保存操作当时的视口，不使用整页拼接截图。
- 关联的网络请求 ID 和控制台事件 ID。
- 新标签页、弹窗、下载或 SPA 路由变化等附加事件。

`actions.json` 保留原始事件，兼容版 JSON 保留现有 `metadata` 和 `actions` 字段。`network.jsonl` 和 `console.jsonl` 采用一行一条事件，便于流式读取。

默认保存 `trace.zip`，包含 Playwright 的 `screenshots`、`snapshots` 和 `sources`；响应体不重复写入 Trace，而由 `responses/` 规则管理。录制目录是主产物，完成后额外生成 ZIP；ZIP 生成失败只写入警告，不使目录证据包失败。

DOM 快照保留表单的原始 `value` 和页面可见文本，不自动脱敏。超过 5 MB 时，写入完整 HTML 的前 1 MB、目标元素祖先链和可见文本摘要，并在状态元数据中标记 `truncated: true`、原始大小与截断原因。状态截图使用原始尺寸的 PNG 文件。

## 6. 网络与隐私策略

网络默认记录方法、URL、资源类型、状态码、耗时、失败原因、Content-Type、步骤关联和页面关联。请求头只保留非敏感诊断字段，明确排除 Cookie、Authorization、Proxy-Authorization、Set-Cookie 和类似认证字段。

响应体仅在配置允许且满足以下条件时保存：Content-Type 为 JSON、HTML 或文本；大小低于配置上限；不是媒体、字体或二进制资源。响应体单独保存并由网络事件引用。超限或跳过时记录原因，不伪装成完整响应。

表单原始值、DOM 原始值、页面文本和允许保存的响应体都可能包含敏感信息；本次不自动脱敏。工具不自动上传或删除证据，使用方必须自行控制 `output/` 的访问、传输、保留和清理。Cookie、Authorization、Proxy-Authorization、Set-Cookie、storage state 和其他可复用登录凭据仍不得保存。

仓库跟踪 `Recording_tools/recording.config.example.json`；运行时只读取同目录且被 Git 忽略的 `Recording_tools/recording.config.json`，缺失时使用默认值。配置包含响应体上限（默认 1 MB）、DOM 快照上限（默认 5 MB）、网络过滤、Trace 开关和 ZIP 开关；实际生效的完整配置必须复制到 `evidence.json`，确保离线阅读时可解释录制结果。录制开始前必须校验配置；JSON 解析失败、未知字段或值超出允许范围时拒绝开始，并向控制页返回字段级错误，禁止静默回退。录制期间配置不得变更，每个证据包固定记录本次的有效配置快照。

网络记录范围为 Context 中所有 Page/Frame 请求，包括第三方和静态资源；通过 `kind` 区分 `document`、`xhr`、`fetch`、`websocket` 和 `static`，便于 AI 默认过滤静态资源。

## 7. 错误处理与兼容性

- 使用临时文件写入，再原子重命名，避免半截 JSON 被标为成功。
- 浏览器异常关闭仍尝试写出当前缓冲；若无法完成，`complete` 必须为 `false`。
- 截图、DOM、网络、控制台或 Trace 单项失败时写入 `warnings` 并继续保存其他证据。
- 服务端只有在 JSON 可解析、文件非空且完整性校验通过时才报告成功。
- 原有输出 JSON 继续生成，旧消费者无需立即迁移。
- 所有路径使用 `path.join`，文件名继续进行 Windows 保留字符清理。
- 点击“完成并保存”后，服务端最多等待 15 秒让录制器优雅关闭并落盘；超时才强制终止，并将结果标记为 `complete:false`。
- 浏览器崩溃、写入失败或停止超时都尽力保留部分证据，返回明确的 `warnings/errors`，不得标记为成功。
- 最终目录通过完整性校验后再异步生成 ZIP。ZIP 必须包含目录中所有最终证据文件，包括 DOM、PNG、响应体、Trace 和下载文件；ZIP 失败仅记录可诊断警告，不改变已经通过校验的目录包状态。

## 8. 验证方案

### 单元测试

- 输入归并只保留最终值，跨元素或超时后正确拆分。
- 定位候选生成、唯一性检测和评分排序。
- JSON、JSONL 和原子写入失败时产生正确警告。
- 敏感请求头被排除，响应体按 Content-Type 和大小规则处理。
- DOM 超过 5 MB 时保留规定的 1 MB HTML 前缀、目标元素祖先链和可见文本摘要，并正确标记截断。
- 配置缺失时使用默认值；无效 JSON、未知字段和越界值在录制开始前被拒绝；`evidence.json` 固化有效配置快照。

### 集成测试

- 静态页面：点击、输入、选择、复选框和 Enter。
- SPA：pushState、replaceState、popstate 和无完整刷新内容更新。
- 新标签页、iframe、弹窗、下载和网络失败。
- 正常停止、浏览器手动关闭、录制进程异常退出。
- 每次测试验证 `evidence.json` 可解析、引用文件存在、兼容版 JSON 仍可读取。
- 验证同源 iframe 的内部 DOM 与操作定位、跨域 iframe 的边界信息，以及输入停止时最终值不会丢失。
- 同名流程并发或同秒连续录制不覆盖目录；每个逻辑步骤均有独立的前后状态 ID；跨越多个步骤窗口的请求正确写入多个 `stepIds`。

### 人工验收

用一个公开站点和一个本地 SPA 各录制一次，确认不重新打开目标系统也能从证据包还原：操作顺序、页面 URL/标题、操作前后截图和 DOM、触发请求及控制台错误。

## 9. README 要求

新增仓库根目录 `README.md`，使用中文说明：

- 启动工具、打开控制页和开始/停止录制。
- 输出目录结构以及每个文件的用途。
- 先读 `evidence.json`，再按需读 `actions.json`、JSONL、HTML、截图和 Trace。
- `complete`、`warnings` 和完整性失败的处理方式。
- `recording.config.example.json` 与仅本地使用的 `recording.config.json` 的关系、默认配置和启动前校验失败的处理方式。
- 表单值、DOM、文本和响应体可能含敏感信息，工具不会自动脱敏、上传或删除；使用方必须控制证据目录的访问、传输、保留和清理。
- 明确当前没有业务断言和自动脱敏。
- 提供以下可独立复制给其他 AI 使用的提示词。提示词不得要求 AI 先阅读仓库 README，至少在只提供 `evidence.json` 的情况下也能执行分析：

```text
请先读取我提供的录制目录中的 evidence.json；如果同时提供 README.md，可以把它作为补充，但不要把 README.md 作为必要前置条件。
以 evidence.json.steps 作为逻辑步骤主线，根据每一步的 before/after、locators、networkRequestIds 和 consoleEventIds 还原流程。
仅在需要排查时读取 actions.json、network.jsonl、console.jsonl、pages/*.html、截图和 trace.zip。
优先使用 score 高且 unique=true 的 role、label、text 或 testId 定位；不要直接把唯一 CSS/XPath 当作稳定定位器。
检查 complete、warnings、errors、missingFiles；不要臆造业务断言或把录制值直接当成通用测试数据。
请输出测试目的、前置条件和参数、步骤、可观察结果、断言建议、Playwright 脚本、网络/控制台异常，以及无法从证据确定的业务预期。
```

## 10. 后续升级边界

检查点标记功能作为独立后续升级：由控制页关联最近一步，允许录制人员填写预期并选择 URL、文本、可见性、数量或接口状态等断言类型。本次设计只预留步骤和状态的关联字段，不实现该交互或断言执行。

## 11. 已确认决策清单

| 编号 | 决策 | 结果 |
| --- | --- | --- |
| D1 | 产物定位 | 以证据包为主，不在录制阶段自动生成测试脚本 |
| D2 | 状态采集 | 每个逻辑步骤前后各采集一次 |
| D3 | 网络采集 | 全量 Page/Frame 请求元数据；响应体按类型和 1 MB 上限选择性保存 |
| D4 | 凭据与上下文 | 全新隔离 Context；不保存 storage state；认证头和 Cookie 排除 |
| D5 | 兼容性 | 始终生成旧格式动作 JSON |
| D6 | 异常语义 | 只有可解析、非空且完整性通过才算成功；否则保留部分包并标记不完整 |
| D7 | 后续功能 | 检查点和业务断言另行设计，不在本次实现 |
| D8 | 目录与文件 ID | 目录使用日期、流程名、时间和短随机 ID，永不覆盖；实体使用稳定递增 ID 与 UTC/单调时间 |
| D9 | 状态与网络关联 | 每个步骤前后强制独立状态；网络全局保留，并可通过 `stepIds` 关联多个步骤 |
| D10 | DOM 与截图 | DOM 保留原始值并按 5 MB 规则截断；截图保存原始视口 PNG |
| D11 | 配置与归档 | 仅本地 `recording.config.json` 可覆盖受跟踪示例；启动前严格校验；ZIP 包含所有最终文件且异步生成 |
| D12 | 数据保留责任 | 不自动脱敏、上传或删除；使用方负责证据目录中的敏感数据管理 |
