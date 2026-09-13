# 录制前选择采集项设计

## 1. 背景与目标

内网环境可能无法稳定传输过大的证据包。当前录制器默认同时保存截图、DOM、网络元数据、响应体、控制台事件、Playwright Trace、下载文件和 ZIP，单次录制的体积和敏感数据范围都偏大。

本次升级在录制开始前让操作者选择采集范围，并让页面明确说明每种模式会产出什么、不会产出什么。目标是：

- 在保留可复盘操作主线的前提下显著减少内网传输体积。
- 让采集策略在服务端、录制器和最终 `evidence.json` 中保持一致。
- 让高级选项有可发现的悬停说明，并在键盘操作时同样可访问。
- 不再提供“仅参数文本文件”模式；参数仍通过始终保留的 `actions.json` 和 `evidence.json` 提供。

本设计只改变采集范围，不解决 `trace.zip` 的查看工具问题。`trace.zip` 仍然指 Playwright Trace，不是 Wireshark 抓包文件。

## 2. 范围与非目标

### 包含

- 控制页在开始录制前提供四种模式：精简、标准、完整、自定义。
- 高级复选框控制截图、DOM、网络、响应体、控制台/页面异常、Trace、下载、第三方请求、静态资源和 ZIP。
- 每个模式显示预计产出和明确不产出的内容。
- 服务端校验并锁定一次录制的有效采集策略。
- 录制器按策略跳过未选择的采集工作和文件写入。
- `evidence.json` 固化实际策略、产出摘要和未采集原因。
- 为策略校验、文件索引和不同模式增加测试。

### 不包含

- 不提供参数文本模式，也不新增 `parameters.txt`。
- 不支持在录制过程中动态切换采集项；开始后策略固定。
- 不支持在响应体内部按业务字段选择“重要数据”。首次实现只控制采集类别；字段级业务语义需要后续单独设计。
- 不重新定义现有敏感头过滤、响应体大小上限、DOM 大小上限和录制停止流程。
- 不把 Playwright Trace 改造成 Wireshark/pcap 文件。

## 3. 设计取舍

### 3.1 方案比较

1. **仅增加四个固定模式**：实现简单，但无法覆盖某个项目只需要 DOM 或只需要网络的情况。
2. **完全自由的几十个开关**：灵活，但容易误选，页面难以解释，策略组合也更难校验。
3. **固定模式 + 高级复选框（采用）**：常用场景一键选择，特殊场景可精确缩减；复选框数量保持在采集类别级别，便于解释和测试。

### 3.2 默认行为

控制页初始选中“标准”模式。标准模式保留能还原页面和定位问题的核心信息，避免默认产生完整模式的巨大 Trace、响应体和下载文件。完整模式必须由操作者显式选择；自定义模式的初始值从标准模式复制。

## 4. 采集策略模型

新增共享模块 `Recording_tools/capture-policy.js`，由服务端和录制器共同使用。策略使用版本化对象传递：

```json
{
  "version": 1,
  "mode": "standard",
  "screenshots": true,
  "dom": true,
  "networkMetadata": true,
  "responseBodies": false,
  "consoleErrors": true,
  "trace": false,
  "downloads": false,
  "includeThirdParty": false,
  "includeStatic": false,
  "archive": true
}
```

`actions.json`、`evidence.json`、步骤、定位信息、URL、标题和录制元数据始终开启，不作为复选框暴露。这样即使选择精简模式，也不会出现只有一个无法解释的参数文本文件。

### 4.1 固定模式

| 模式 | 开启项 | 明确不产出 |
| --- | --- | --- |
| 精简 | 截图、控制台错误/页面异常、基础动作与定位、ZIP | DOM、网络元数据、响应体、Trace、下载文件、第三方请求、静态资源请求 |
| 标准 | 截图、DOM、网络元数据、控制台错误/页面异常、ZIP | 响应体、Trace、下载文件、第三方请求、静态资源请求 |
| 完整 | 截图、DOM、网络元数据、响应体、控制台错误/页面异常、Trace、下载文件、第三方请求、静态资源请求、ZIP | 无采集类别被主动关闭；仍受大小上限和敏感头过滤约束 |
| 自定义 | 由高级复选框决定；基础动作与索引始终保留 | 以当前勾选项为准，页面实时显示 |

“第三方请求”和“静态资源请求”是网络范围过滤器，不会在未开启“网络元数据”时单独产生网络文件。开启响应体时自动要求网络元数据开启；若通过接口传入矛盾组合，服务端拒绝请求而不是静默修正。

### 4.2 高级项说明

每个复选框同时提供可见说明和 `title`/`aria-describedby` 悬停及键盘提示：

- **截图**：保存每个逻辑步骤前后的当前视口 PNG，便于人工确认页面状态；通常体积中等，不包含整页拼接。
- **DOM**：保存页面 HTML 快照和可见文本摘要，便于定位元素和复盘布局；可能包含表单原始值和敏感文本。
- **网络元数据**：保存请求 URL、方法、资源类型、状态、耗时、失败原因及步骤关联；不保存响应正文。
- **响应体**：在现有 Content-Type 和大小上限规则内保存文本/JSON/XML 响应；可能包含业务敏感数据，体积增长最快之一。
- **控制台错误/页面异常**：保存 console warning/error、未捕获异常和 page error；不保存普通日志信息。
- **Trace**：保存 Playwright `trace.zip`，可用 Playwright Trace Viewer 查看；它不是 Wireshark 抓包文件，体积可能较大。
- **下载文件**：保存录制期间触发的下载及其元数据；文件内容可能很大或含敏感信息。
- **第三方请求**：网络开启时包含非目标站点源的请求；可帮助分析外部依赖，但会增加体积和隐私范围。
- **静态资源请求**：网络开启时包含图片、字体、脚本、样式等静态请求；通常数量多、诊断价值低。
- **ZIP 归档**：将当前已生成的证据目录打包成 `evidence.zip`；关闭后仍保留目录本身。

## 5. 组件与接口

### 5.1 控制页

在 URL、流程名称和“开始录制”按钮之间增加“录制前选择采集项”区域：

1. 四个单选模式以紧凑选项展示名称、体积级别和产出摘要。
2. 选择模式后展示“会产出”和“不会产出”两列；内容来自前端固定定义，避免只显示一个模糊的“轻量/完整”标签。
3. “高级选项”折叠区展示复选框和悬停说明。修改任一预设项后自动切换为“自定义”，避免界面显示的模式名称与实际勾选值不一致。
4. 开始录制后整个策略区只读，直到录制结束或启动失败。
5. 若策略无效，按钮恢复可用并显示字段级错误；不打开浏览器、不创建伪成功目录。

### 5.2 启动 API

`POST /api/record/start` 请求新增 `capturePolicy` 字段。服务端执行以下顺序：

1. 解析 JSON、加载并校验现有 `recording.config.json`。
2. 使用 `capture-policy.js` 校验模式、布尔字段和字段依赖，生成不可变的有效策略。
3. 在子进程环境变量 `RECORDER_CAPTURE_POLICY` 中传递 JSON 字符串，避免 Windows 命令行参数转义问题。
4. 将有效策略保存在当前录制状态中，并在日志中记录模式名称。

`GET /api/config` 返回固定模式定义和默认策略，控制页据此渲染，避免前后端各维护一份不同的模式语义。旧客户端不传 `capturePolicy` 时，服务端使用标准模式，保证旧调用仍能启动。

### 5.3 录制器

`RecordingSession` 构造时读取并校验 `RECORDER_CAPTURE_POLICY`，同时继续读取 `recording.config.json` 的大小上限和归档配置。策略只在会话创建时读取一次。

- 初始化时只创建启用类别需要的目录和文件。
- `captureState` 根据 `screenshots` 和 `dom` 分支执行截图、DOM 写入；关闭项直接记录禁用原因，不执行 Playwright 采集。
- 网络监听器在 `networkMetadata` 关闭时不保存网络事件；开启时按 `includeThirdParty`、`includeStatic` 过滤；响应体只有在两个相关选项都开启时处理。
- 控制台监听器只在 `consoleErrors` 开启时保留 warning/error/pageerror，并过滤普通日志。
- Trace 只在 `trace` 开启时启动和停止。
- 下载只在 `downloads` 开启时保存文件；关闭时仍可在必要的动作/警告中记录“下载采集已关闭”。
- ZIP 只在 `archive` 开启时异步生成。

## 6. 输出契约

### 6.1 始终存在

```text
evidence.json
actions.json
```

`actions.json` 继续保存全部原始动作和定位信息。它不是旧版兼容 JSON，也不被移除；本次只是取消“参数文本模式”。

### 6.2 按策略生成

```text
network.jsonl       # networkMetadata=true
console.jsonl       # consoleErrors=true
pages/*.png         # screenshots=true
pages/*.html        # dom=true
responses/*         # responseBodies=true 且存在符合条件的响应
downloads/*         # downloads=true 且触发下载
trace.zip           # trace=true
evidence.zip        # archive=true
```

不启用的类别不创建对应目录或文件。`evidence.json.files` 对未启用项写 `null`，并在 `captureSummary.disabled` 写入稳定的策略键和 `disabled_by_policy` 原因；这与文件生成失败区分开。

### 6.3 `evidence.json` 新字段

```json
{
  "capturePolicy": {
    "version": 1,
    "mode": "slim",
    "screenshots": true,
    "dom": false,
    "networkMetadata": false,
    "responseBodies": false,
    "consoleErrors": true,
    "trace": false,
    "downloads": false,
    "includeThirdParty": false,
    "includeStatic": false,
    "archive": true
  },
  "captureSummary": {
    "enabled": ["screenshots", "consoleErrors", "archive"],
    "disabled": [
      { "item": "dom", "reason": "disabled_by_policy" },
      { "item": "networkMetadata", "reason": "disabled_by_policy" }
    ]
  }
}
```

步骤中的 `before`、`after` 状态以及文件索引必须能区分三种状态：已生成、策略关闭、采集失败。例如关闭截图时写 `{ "file": null, "unavailable": true, "reason": "disabled_by_policy" }`；截图执行失败时写实际错误并追加 `warnings`。只有启用类别对应的必需文件才进入 `missingFiles` 校验。

## 7. 数据流与错误处理

1. 用户在控制页选择模式和高级项。
2. 控制页将完整策略随启动请求发送；服务端校验并冻结策略。
3. 服务端创建输出目录并启动子进程；子进程用同一模块再次校验环境变量，防止直接启动录制器时产生无效包。
4. 录制过程中各采集器只处理启用类别；动作主线始终写入内存和 `actions.json`。
5. 停止时按既有顺序刷新输入、停止 Trace（如启用）、关闭浏览器、写出索引并异步生成 ZIP。
6. 录制结束后服务端读取 `evidence.json`，以 `complete`、必需引用和进程退出状态判断成功。

错误规则：

- 策略 JSON 无法解析、版本未知、字段类型错误或响应体未开启网络时，启动 API 返回 400。
- 运行期间某个启用类别失败，只在对应记录写警告并继续保存其他类别；最终 `complete` 按现有规则变为 `false` 或保留局部证据，不能把禁用类别当作缺失文件。
- 子进程缺少策略环境变量时使用标准模式并在日志中记录兼容警告；环境变量存在但无效时直接启动失败。
- ZIP 生成失败继续保留已通过校验的目录包，在 `warnings` 中记录错误；只有开启 ZIP 且索引把它列为必需文件时才将其列入缺失校验。推荐把 ZIP 作为异步附加产物，不阻塞目录包成功。
- 录制过程中策略不得通过配置文件热更新；`evidence.json` 固化启动时的实际策略。

## 8. 测试与验收

### 单元测试

- 四种模式展开为预期布尔值；自定义策略可序列化并保持字段顺序无关。
- 未知模式、未知字段、非布尔字段和 `responseBodies=true` 且 `networkMetadata=false` 被拒绝。
- 第三方/静态过滤仅影响网络类别；关闭网络时不生成空网络文件。
- 关闭每个类别时，索引写入 `disabled_by_policy` 而不是 `missingFiles`。

### 集成测试

- 精简模式只生成 `evidence.json`、`actions.json`、截图、错误级控制台记录和可选 ZIP，不生成 DOM、网络、响应体、Trace、下载文件。
- 标准模式生成截图、DOM、网络元数据和错误级控制台记录，不生成响应体、Trace、下载文件。
- 完整模式保留现有全量产出和过滤规则。
- 自定义模式至少覆盖“仅截图 + 动作”和“仅网络 + 控制台”两种组合。
- 启动策略与 `evidence.json.capturePolicy` 完全一致；录制中修改本地配置不改变当前包。
- UI 悬停、键盘聚焦和屏幕阅读器可读取每个高级项的作用、体积和敏感性说明。
- 旧客户端不传策略仍能以标准模式录制；已有历史产物不被迁移或重写。

### 人工验收

使用同一个本地页面分别录制四种模式，确认控制页在开始前清楚列出“会产出/不会产出”，录制后从 `evidence.json` 能解释每个缺失文件是主动关闭还是实际失败，并比较精简包与完整包的体积差异。

## 9. 兼容性与迁移

- 不修改历史输出目录；旧目录仍按原结构读取。
- 保留现有 `recording.config.json` 的响应体/DOM 大小上限、过滤和归档相关配置；采集策略是一次录制的运行时覆盖层。
- README 需要新增四种模式和高级项说明，并明确参数文本模式已移除、`actions.json` 是原始动作主文件。
- 版本化策略对象，未来新增采集类别时可通过 `version` 和兼容默认值演进，而不让旧证据包失去可读性。

## 10. 决策清单

| 编号 | 决策 | 结果 |
| --- | --- | --- |
| D1 | 模式数量 | 仅保留精简、标准、完整、自定义四种模式 |
| D2 | 参数文本模式 | 移除，不生成 `parameters.txt` |
| D3 | 默认模式 | 控制页默认标准，完整需显式选择 |
| D4 | 动作主线 | `evidence.json` 与 `actions.json` 始终生成 |
| D5 | 策略时机 | 录制开始前选择，开始后锁定 |
| D6 | 高级选项 | 类别级复选框，带悬停和键盘可访问说明 |
| D7 | 网络依赖 | 响应体依赖网络元数据；过滤器只对网络类别生效 |
| D8 | 未采集语义 | 使用 `disabled_by_policy`，不混入 `missingFiles` |
| D9 | Trace 语义 | 仍为 Playwright `trace.zip`，本次不改变格式 |
| D10 | 业务字段选择 | 本次不实现响应体内部字段级筛选 |
