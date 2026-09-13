# Recording_tools

这是一个基于 Playwright 的浏览器操作证据录制工具。它在独立的浏览器上下文中记录人工操作，并将操作前后状态、定位候选、网络与控制台关联信息、截图、DOM 和 Trace 汇总为一个可供开发人员或 AI 分析的证据包。

## 系统要求

- **操作系统**：Windows 10 或 Windows 11（推荐）。启动脚本还包含针对 Windows 8/8.1 和 Windows Server 2012 系列的备用 Node.js 路径，但这些系统不是当前主要验证环境。
- **浏览器**：本机需要安装可正常启动的 Google Chrome。录制器默认通过 Playwright 的 `channel: chrome` 启动 Chrome；如果 Chrome 被安全策略、杀毒软件或组策略阻止，录制无法开始。
- **Node.js/npm**：无需单独安装。项目内已自带 Node.js 运行时和 Playwright 依赖，`start.bat` 会按 Windows 版本选择 `Recording_tools/node-win10/node.exe`（当前为 Node.js 24.19.0）或 `Recording_tools/node-win2012/node.exe`（当前为 Node.js 16.20.2）；随包 Playwright 当前为 `1.63.0-alpha-2026-08-05`。
- **网络**：控制页面使用本机 `http://localhost:19832`；启动时该 TCP 端口必须可用。录制目标为远程网站时，还需要本机能够访问目标 URL 及其依赖的接口。
- **文件权限**：当前 Windows 用户需要对仓库目录具有读取和写入权限，尤其是 `Recording_tools/output/`，因为截图、DOM、Trace 和证据 JSONL 都会写入这里。
- **资源建议**：建议至少保留 4 GB 可用内存和 2 GB 可用磁盘空间。实际磁盘占用取决于录制时长、页面数量、Trace、DOM、下载文件以及允许保存的响应体数量；长流程应在录制前确认有足够空间。

### 启动前检查

1. 确认 `Recording_tools/start.bat`、`Recording_tools/server.js` 和 `Recording_tools/custom-recorder.js` 文件存在。
2. 在开始录制前关闭会占用 `19832` 端口的旧服务；控制页面无法打开时先检查端口占用和本机防火墙规则。
3. 直接打开 Chrome，确认系统没有阻止浏览器启动；不要使用需要额外登录参数或受限沙箱策略的浏览器快捷方式。
4. 确认 `Recording_tools/output/` 可写，并检查磁盘空间。录制工具不会自动上传或清理历史证据。

## 使用

1. 双击 `Recording_tools/start.bat`，等待控制台显示控制页面地址。
2. 打开控制页面，选择系统或输入 URL，填写流程名称，然后点击“开始录制”。
3. 在新打开的浏览器中手动完成业务操作。操作结束后，在控制页面点击“完成并保存”，或直接关闭浏览器窗口。
4. 每次录制都会创建新的目录，不覆盖已有结果：

   `Recording_tools/output/<YYYY-MM-DD>_<流程名>_<HHmmss>_<4位ID>/`

开始录制前需要选择采集模式，默认是“标准”：

| 模式 | 会产出 | 不会产出 |
| --- | --- | --- |
| 精简 | `evidence.json`、`actions.json`、截图、错误级控制台信息、可选 ZIP | DOM、网络元数据、响应体、Trace、下载文件、第三方/静态请求 |
| 标准 | 精简内容，加 DOM、网络元数据、错误级控制台信息、可选 ZIP | 响应体、Trace、下载文件、第三方/静态请求 |
| 完整 | 全部采集项：截图、DOM、网络、响应体、控制台、Trace、下载、第三方/静态请求、ZIP | 无主动关闭的采集类别（仍受大小上限和敏感头过滤约束） |
| 自定义 | 由“高级采集项”勾选的内容 | 当前未勾选的采集项 |

精简模式仍然保留截图；本工具已移除“仅参数文本模式”，不会生成 `parameters.txt`。动作和参数始终在 `actions.json` 与 `evidence.json` 中保存。高级选项支持悬停和键盘聚焦说明，开始录制后不能再修改本次策略。

录制前会读取两个本地配置文件：系统网址列表 `Recording_tools/config.txt` 和录制参数 `Recording_tools/recording.config.json`。仓库提供 `Recording_tools/config.example.txt` 与 `Recording_tools/recording.config.example.json` 作为模板；需要时复制为对应的运行时文件后再修改。两个运行时配置文件都不会被 Git 追踪。录制参数配置无效、包含未知字段或数值越界时，录制会在启动前拒绝并返回字段级错误；录制过程中不会重新读取配置。

## 输出文件

每个录制目录以 `evidence.json` 为主入口，常见文件如下：

- `evidence.json`：证据包索引，包含录制元数据、`steps`、每步的 `before`/`after` 状态、定位候选、网络/控制台关联 ID、警告、错误和完整性状态。
- `actions.json`：全部原始操作事件，供审计、排查和还原逻辑步骤使用。
- `network.jsonl`：启用网络元数据时生成；每行一个 Page/Frame 网络请求事件，包含 URL、资源类型、状态码、耗时、失败原因、Content-Type、关联步骤和页面 ID。认证 Cookie、Authorization、Proxy-Authorization、Set-Cookie 等敏感请求头不会写入。
- `console.jsonl`：启用控制台错误/页面异常时生成，只保存 warning、error、未捕获异常和 page error。
- `pages/state-xxxx.png`：启用截图时生成的操作前后 viewport 截图。
- `pages/state-xxxx.html`：启用 DOM 时生成的对应快照。表单原始值和可见文本会保留；超过限制时保存截断前缀并标记 `truncated`。
- `responses/`：启用响应体且满足配置的 Content-Type 和大小上限时生成。
- `downloads/`：启用下载文件时生成。
- `trace.zip`：启用 Trace 时生成的 Playwright Trace，可用 Trace Viewer 打开；它不是 Wireshark 抓包文件。
- `evidence.zip`：启用 ZIP 归档时异步生成的完整证据目录压缩包；压缩失败不会改变已写入的证据目录。

`evidence.json` 的 `capturePolicy` 是本次实际生效策略，`captureSummary.disabled` 中的 `disabled_by_policy` 表示主动关闭，不属于文件缺失。未启用的文件在 `files` 中为 `null`；真正的采集或写入失败才会进入 `warnings`/`missingFiles`。

## 查看证据

先读取录制目录中的 `evidence.json`，以 `steps` 的顺序理解流程。分析某一步时，先查看该步的 `before`、`after` 和 `locators`，再根据 `networkRequestIds`、`consoleEventIds` 读取对应的 JSONL 行。只有需要排查细节时，才打开 `actions.json`、DOM、截图或 `trace.zip`。

`complete: false` 表示浏览器异常关闭、停止超时、文件写入失败或证据缺失。此时必须先检查 `warnings`、`errors` 和 `missingFiles`，不能把部分证据包当作成功录制。

## 给 AI 的提示词（自动化测试/爬虫）

将下列提示词之一复制给其他 AI，并同时提供对应的录制证据目录。无论哪种模式，都必须提供 `evidence.json`；其他文件是否存在，以 `evidence.json.files` 和 `captureSummary` 为准，不要要求 AI 读取未生成的文件。

### 证据文件与模式

| 采集模式 | 通常可读取的文件 | 适合用途 |
| --- | --- | --- |
| 精简 | `evidence.json`、`actions.json`、`pages/*.png`、启用时的 `console.jsonl` | 基础页面操作测试、短流程回放 |
| 标准 | 精简文件，加 `pages/*.html`、`network.jsonl`、`console.jsonl` | 推荐用于自动化测试和带接口观察的流程脚本 |
| 完整 | 标准文件，加 `responses/`、`downloads/`、`trace.zip`、`evidence.zip` | 复杂流程排查、响应数据驱动脚本 |
| 自定义 | 以 `evidence.json.capturePolicy` 实际勾选项为准 | 针对特定数据范围生成脚本 |

通用约束：先读 `evidence.json`，再按实际文件索引读取细节；检查 `complete`、`warnings`、`errors`、`missingFiles`；优先使用 `unique=true` 且评分高的 `role`、`label`、`testId` 定位器；不要把一次录制值直接当成通用测试数据；不要臆造未录制的页面、业务断言、账号、分页或异常分支。下面每段提示词都要求 AI 输出“证据能支持的结论”和“需要人工确认的假设”。

### 精简模式：自动化测试

```text
请根据我提供的精简模式 Playwright 录制证据生成自动化测试脚本。先读取 evidence.json，确认 capturePolicy.mode、files、captureSummary 和 complete；只读取索引中实际存在的 actions.json、pages/*.png、console.jsonl。不要尝试读取未生成的 DOM、network.jsonl、responses、downloads 或 trace.zip。

以 evidence.json.steps 顺序还原操作。使用步骤中的 locators，优先选择 unique=true 且 score 高的 role、label、testId；CSS/XPath 只能作为后备，并标注稳定性风险。截图只能作为页面状态的视觉证据，不能从截图臆造不可见的 DOM、接口响应或业务断言。

请输出：测试目的；前置条件和需要替换的 URL/账号/参数；按顺序排列的操作和可观察结果；证据直接支持的断言；需要人工确认的断言；可运行或接近可运行的 Playwright 测试脚本；证据完整性、warnings/errors/missingFiles 和不确定性。脚本应保留录制顺序，并对无法从精简证据确定的等待条件和断言加 TODO 注释。
```

### 精简模式：爬虫

```text
请根据我提供的精简模式 Playwright 录制证据生成一个范围受控的 Playwright 爬虫脚本。先读取 evidence.json，确认 capturePolicy.mode、files 和 complete；只读取实际存在的 actions.json、pages/*.png、console.jsonl。不要读取或假设未生成的 DOM、网络响应和接口数据。

把录制流程视为“已验证的导航入口和操作路径”，只爬取证据中出现或由明确链接操作到达的页面，不要扩展成整个网站爬取。根据 steps、URL、标题、截图和定位器生成导航、翻页或详情访问逻辑；如果证据没有给出列表、分页、去重键或详情字段，必须输出待确认项，不要自行猜测。

请输出：爬取范围；入口和停止条件；字段提取方案及证据依据；去重、超时、重试和限速策略；可运行或接近可运行的 Playwright 爬虫脚本；无法从精简证据确定的数据字段和风险。不得把截图中的文字当成稳定字段选择器。
```

### 标准模式：自动化测试

```text
请根据我提供的标准模式 Playwright 录制证据生成自动化测试脚本。先读取 evidence.json，检查 capturePolicy、files、captureSummary、complete、warnings、errors、missingFiles；再按索引读取 actions.json、pages/*.html、pages/*.png、network.jsonl 和 console.jsonl。

以 evidence.json.steps 为主线还原每个动作的 before/after、URL、标题、frame 和 locators。优先使用 unique=true 且 score 高的 role、label、testId；用 DOM 验证元素和可观察文本，用 networkRequestIds/consoleEventIds 关联请求状态和前端异常。只提出证据支持的 URL、可见性、文本、数量、状态码等断言，不把录制值直接当成通用数据。

请输出：测试目的；前置条件、登录要求和参数化数据；步骤与可观察结果；证据直接支持的断言和需要人工确认的业务断言；可运行或接近可运行的 Playwright 测试脚本；网络/控制台异常；证据完整性和不确定性。脚本中对登录态、动态数据、等待条件和不稳定定位器明确标注替换位置。
```

### 标准模式：爬虫

```text
请根据我提供的标准模式 Playwright 录制证据生成范围受控的 Playwright 爬虫脚本。先读取 evidence.json，再读取实际存在的 actions.json、pages/*.html、pages/*.png、network.jsonl 和 console.jsonl；不要假设 responses、downloads 或 trace.zip 存在。

只围绕证据中出现的入口、导航、列表、详情和交互路径设计爬取，不要凭空遍历整个站点。用 DOM 快照确认列表/详情元素，用 network.jsonl 判断是否存在分页、搜索、详情请求或失败请求；如果没有足够证据确定字段、分页参数、认证方式或停止条件，列为人工确认项。禁止输出绕过权限、验证码或访问控制的逻辑。

请输出：爬取范围与入口；页面/接口关系；字段提取和数据模型；分页、去重、重试、超时、限速和停止条件；可运行或接近可运行的 Playwright 爬虫脚本；证据支持与证据不足的部分。脚本不得把一次录制中的账号、密码、Token 或业务值硬编码进去。
```

### 完整模式：自动化测试

```text
请根据我提供的完整模式 Playwright 录制证据生成自动化测试脚本。先读取 evidence.json 并检查 capturePolicy、files、captureSummary、complete、warnings、errors、missingFiles；再按需读取 actions.json、pages/*.html、pages/*.png、network.jsonl、console.jsonl、responses/、downloads/ 和 trace.zip。trace.zip 只作为 Playwright Trace 辅助证据，不是 Wireshark 抓包。

以 steps 的 before/after 和 locators 还原 UI 流程，以 networkRequestIds/consoleEventIds 关联网络和前端错误，以 responses/补充已实际保存的文本/JSON 响应，以 downloads/确认下载结果。优先生成稳定定位器和明确等待条件；区分 UI 断言、网络断言和需要业务确认的断言。不得因为证据完整就臆造未录制的分支或通用测试数据。

请输出：测试目的；前置条件、登录态和参数化方案；详细步骤；UI/网络/下载断言；需要人工确认的业务预期；可运行或接近可运行的 Playwright 测试脚本；异常、敏感数据风险、证据完整性和不确定性。所有账号、密码、Token 和录制值都必须改成环境变量或测试夹具占位符。
```

### 完整模式：爬虫

```text
请根据我提供的完整模式 Playwright 录制证据生成一个合规、范围受控的 Playwright 爬虫脚本。先读取 evidence.json，再按 files 和 capturePolicy 读取 actions.json、pages/*.html、pages/*.png、network.jsonl、console.jsonl、responses/、downloads/ 和 trace.zip；不要把 trace.zip 当作 Wireshark 文件，也不要把 responses/ 中偶然出现的字段当成完整接口契约。

以证据中出现的页面和明确导航为爬取边界。用 DOM 和已保存响应确认字段、列表、详情、分页或搜索；用 network.jsonl 只辅助理解已观察到的请求，不要绕过页面权限直接调用未验证接口。为分页、去重、限速、重试、超时、下载和停止条件给出实现；证据不足之处必须列为待确认项。禁止绕过登录、验证码、权限、robots 或站点访问限制。

请输出：授权范围假设；入口、页面和字段模型；爬虫流程；数据清洗与去重；错误处理和限速策略；可运行或接近可运行的 Playwright 爬虫脚本；已证实能力、推测内容和需要人工确认的事项。不得硬编码任何敏感凭据或录制时的真实业务数据。
```

### 自定义模式：自动化测试

```text
请根据我提供的自定义模式 Playwright 录制证据生成自动化测试脚本。先读取 evidence.json.capturePolicy 和 files，建立“实际可用文件清单”，只读取清单中的 evidence.json、actions.json、pages/*.html、pages/*.png、network.jsonl、console.jsonl、responses/、downloads/、trace.zip。对每个未启用项按 disabled_by_policy 处理，不要把它当成采集失败或自行补齐。

以 evidence.json.steps 为主线生成脚本。根据实际存在的 DOM、截图、网络、响应体和下载证据选择定位器、等待方式和断言；优先 unique=true 且 score 高的定位器。明确哪些结论来自证据，哪些是业务假设；不要把录制值、凭据或 Token 写入脚本。

请输出：可用证据清单；测试目的和前置条件；步骤、定位器、等待和断言；可运行或接近可运行的 Playwright 测试脚本；缺失采集项带来的限制；warnings/errors/missingFiles 和待人工确认项。
```

### 自定义模式：爬虫

```text
请根据我提供的自定义模式 Playwright 录制证据生成范围受控的 Playwright 爬虫脚本。先读取 evidence.json.capturePolicy、files 和 captureSummary，只使用实际存在的文件；对 disabled_by_policy 项不要猜测内容。根据实际提供的 DOM、截图、network.jsonl、responses/ 和 downloads/ 选择页面或接口观察方式。

爬取范围只能来自证据中出现的入口、页面和明确导航。只有当证据明确展示列表、字段、分页、详情、搜索或停止条件时才实现对应逻辑；否则输出人工确认项。必须设计限速、超时、重试、去重、错误记录和停止条件，不得绕过权限、验证码或访问控制，也不得硬编码敏感凭据。

请输出：实际可用证据及限制；授权和爬取范围假设；字段与数据模型；爬取流程和错误处理；可运行或接近可运行的 Playwright 爬虫脚本；证据支持、推测和待确认事项。
```

## 数据责任

工具不会自动脱敏、上传或删除证据。表单值、DOM 文本和允许保存的响应体可能包含敏感信息；Cookie、Authorization、Proxy-Authorization、Set-Cookie、storage state 及可复用登录凭据不会保存。使用者负责控制证据目录的访问、传输、保留和清理。

## 当前边界

本工具本身只负责采集和组织证据，不在录制时执行业务断言或自动生成脚本，也不提供自动脱敏；上面的提示词用于把已采集证据交给其他 AI 生成自动化测试或爬虫脚本。检查点标记和业务断言属于后续升级范围。
