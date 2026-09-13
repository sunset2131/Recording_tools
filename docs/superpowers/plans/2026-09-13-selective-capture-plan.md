# 录制前选择采集项实施计划

设计依据：`docs/superpowers/specs/2026-09-13-selective-capture-design.md`

## 实施顺序

### 1. 建立共享策略模块

文件：

- 新增 `Recording_tools/capture-policy.js`
- 新增 `Recording_tools/tests/capture-policy.test.js`

工作内容：

- 定义四种模式的默认策略和可展示的中文产出说明。
- 定义允许字段、布尔类型校验、版本校验和 `responseBodies` 依赖 `networkMetadata` 的规则。
- 提供 `resolveCapturePolicy(requested, recordingConfig)`，返回深拷贝后的不可变有效策略。
- 将本地 `recording.config.json.zip` 作为归档能力上限：请求关闭归档时关闭；本地配置关闭归档时也不能被请求打开，并记录 `archiveDisabledByConfig`，避免破坏现有本地配置语义。
- 测试四种模式展开、字段类型错误、未知字段、网络依赖、默认策略和归档上限。

完成标准：服务端和录制器只依赖这一份策略解析逻辑，不能各自维护模式默认值。

### 2. 接入服务端启动接口

文件：`Recording_tools/server.js`

工作内容：

- 引入策略模块。
- `GET /api/config` 增加模式定义、默认策略和高级项说明。
- `POST /api/record/start` 读取 `capturePolicy`，在创建输出目录前完成校验，失败返回 400 且不启动子进程。
- 通过 `RECORDER_CAPTURE_POLICY` 环境变量传递冻结后的 JSON；保留现有 URL、流程名和浏览器通道传递方式。
- `currentRecord` 保存有效策略和模式名；开始日志写入模式。
- 兼容旧客户端：未传策略时使用标准模式。
- 状态接口继续以 `evidence.json.complete` 判定结果，并在返回值中提供模式和策略摘要。

验证：使用 Node 内置 HTTP 请求测试有效启动请求、无效组合和缺省策略；无效请求不能生成输出目录。

### 3. 改造录制器采集分支

文件：`Recording_tools/custom-recorder.js`

工作内容：

- 构造会话时读取并校验 `RECORDER_CAPTURE_POLICY`；缺失时使用标准模式并记录兼容警告；存在但无效时启动失败。
- 只创建启用类别需要的 `pages/`、`responses/`、`downloads/` 和 JSONL 文件。
- `init` 仅在 `trace` 开启时启动 Playwright tracing。
- `onConsole` 仅保留 warning/error/pageerror；关闭时不创建 console 文件。
- `onDownload` 在关闭时不保存文件；开启时保留现有下载动作关联。
- `onRequest`、`onRequestFinished`、`onRequestFailed` 在网络关闭时跳过记录；网络开启时使用策略过滤第三方和静态请求；响应体以策略和现有大小/Content-Type 配置共同限制。
- `captureState` 按截图/DOM开关执行采集；关闭项写 `disabled_by_policy` 状态，不产生伪文件引用。
- `finalize` 生成策略、`captureSummary`、动态 `files` 索引和按策略计算的 `missingFiles`；始终写 `evidence.json` 与 `actions.json`。
- `assignLinks` 对未采集网络/控制台类别生成空关联，而不是访问不存在的记录。
- ZIP 仅在有效策略 `archive` 开启时异步生成，失败写 warning，不把禁用 ZIP 当作缺失文件。

验证：用临时输出目录和模拟策略运行无浏览器的 finalize 单元路径，检查禁用项不会创建文件，索引原因为 `disabled_by_policy`。

### 4. 改造控制页交互

文件：`Recording_tools/public/index.html`

工作内容：

- 在开始录制区域加入四个模式单选项，默认标准。
- 增加“会产出/不会产出”说明区域，随模式和自定义勾选实时更新。
- 增加高级复选框：截图、DOM、网络元数据、响应体、控制台/页面异常、Trace、下载、第三方请求、静态资源、ZIP。
- 从 `/api/config` 读取模式定义和说明，避免 UI 与服务端分叉。
- 修改预设项后自动切换自定义；响应体未勾选网络时立即提示并阻止启动，而不是自动隐式勾选。
- 启动请求发送完整 `capturePolicy`；请求失败时恢复控件。
- 录制期间锁定策略控件，结束后恢复。
- 每个高级项提供可见短说明、`title` 和 `aria-describedby`，支持鼠标悬停、键盘聚焦和屏幕阅读器。

验证：浏览器手工检查四种模式、响应体依赖提示、策略锁定和移动宽度下的布局；用 DOM 检查说明文本不溢出。

### 5. 更新使用文档

文件：`README.md`（不修改本地忽略的 `CONTEXT.md`）

工作内容：

- 说明录制前选择模式、默认标准和高级项作用。
- 明确精简模式仍保留截图，参数文本模式已移除，`actions.json` 始终生成。
- 给出四种模式的产出矩阵、Trace 是 Playwright Trace 的说明和敏感数据提示。
- 说明 `evidence.json.capturePolicy`、`captureSummary` 和禁用原因。

### 6. 增加回归测试并验证

文件：`Recording_tools/tests/recording-config.test.js`、`Recording_tools/tests/capture-policy.test.js`、`Recording_tools/tests/recorder-index.test.js`

工作内容：

- 保持原有配置测试通过。
- 测试四种策略的字段展开和输出摘要。
- 测试策略与证据索引一致、禁用项不进入 `missingFiles`。
- 测试旧客户端缺省策略回退标准。
- 使用项目内置 Node 运行全部 `tests/*.test.js`。
- 若 Playwright 浏览器可用，运行一次本地静态页录制，比较精简/标准/完整产物目录和 ZIP 体积，检查 `evidence.json` 的实际策略。

## 风险与控制

- 录制器目前是单文件实现，改动集中在事件监听、状态采集和 finalize；每一步保留现有证据字段，避免历史读取器失效。
- `network.jsonl` 和 `console.jsonl` 从“始终存在”变为按策略生成；证据索引会用 `null` 和 `disabled_by_policy` 明确表示，这是本次输出契约的有意变化。
- 大响应体、Trace 和下载仍可能超出内网承载能力；精简和标准默认关闭它们，完整模式由操作者显式承担。
- 高级项只控制采集类别，不理解业务字段；文档和 UI 必须避免承诺“只采集重要业务数据”。

## 完成定义

- 服务端、录制器和控制页使用同一策略定义。
- 四种模式都能在开始前被选择并被 UI 清楚解释。
- 精简模式仍有动作、定位、截图、错误级控制台信息和证据索引，但不生成 DOM、网络、响应体、Trace、下载文件。
- `evidence.json` 能区分主动关闭、实际失败和成功生成。
- 现有配置测试和新增策略测试通过；至少完成一次真实浏览器录制验收。
