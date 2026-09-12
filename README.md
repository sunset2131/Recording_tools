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

录制前会读取 `Recording_tools/recording.config.json`。仓库只提供 `Recording_tools/recording.config.example.json`，需要时复制为 `recording.config.json` 后再修改。配置文件无效、包含未知字段或数值越界时，录制会在启动前拒绝并返回字段级错误；录制过程中不会重新读取配置。

## 输出文件

每个录制目录以 `evidence.json` 为主入口，常见文件如下：

- `evidence.json`：证据包索引，包含录制元数据、`steps`、每步的 `before`/`after` 状态、定位候选、网络/控制台关联 ID、警告、错误和完整性状态。
- `actions.json`：全部原始操作事件，供审计、排查和还原逻辑步骤使用。
- `network.jsonl`：每行一个 Page/Frame 网络请求事件，包含 URL、资源类型、状态码、耗时、失败原因、Content-Type、关联步骤和页面 ID。认证 Cookie、Authorization、Proxy-Authorization、Set-Cookie 等敏感请求头不会写入。
- `console.jsonl`：控制台消息、页面异常、发生时间和页面 ID。
- `pages/state-xxxx.png`：操作前后 viewport 截图。
- `pages/state-xxxx.html`：对应 DOM。表单原始值和可见文本会保留；超过限制时保存截断前缀并标记 `truncated`。
- `responses/`：仅在配置允许、响应类型为文本/JSON/HTML 且未超过大小上限时保存响应体。
- `downloads/`：录制期间下载的文件。
- `trace.zip`：Playwright Trace（默认开启）。
- `evidence.zip`：录制完成后异步生成的完整证据目录压缩包；压缩失败不会改变已写入的证据目录。

## 查看证据

先读取录制目录中的 `evidence.json`，以 `steps` 的顺序理解流程。分析某一步时，先查看该步的 `before`、`after` 和 `locators`，再根据 `networkRequestIds`、`consoleEventIds` 读取对应的 JSONL 行。只有需要排查细节时，才打开 `actions.json`、DOM、截图或 `trace.zip`。

`complete: false` 表示浏览器异常关闭、停止超时、文件写入失败或证据缺失。此时必须先检查 `warnings`、`errors` 和 `missingFiles`，不能把部分证据包当作成功录制。

## 给 AI 的提示词（可直接复制）

将下面整段提示词复制给其他 AI，并同时提供一个录制证据目录（至少包含 `evidence.json`）：

```text
你现在要分析一个 Playwright 浏览器录制证据包。请先读取我提供的录制目录中的 evidence.json；如果同时提供 README.md，可以把它作为补充，但不要把 README.md 作为必要前置条件。

请遵循以下规则：
1. 以 evidence.json.steps 的顺序作为逻辑步骤主线。对每一步说明操作、操作前状态（before）、操作后状态（after）以及页面 URL、标题、页面或 frame 信息。
2. 使用该步骤的 locators 还原元素定位。优先选择 score 较高且 unique=true 的 role、label、text 或 testId 定位器；不要直接把唯一 CSS/XPath 当作稳定定位器。若只能使用 CSS/XPath，请明确标注稳定性风险。
3. 根据 networkRequestIds 和 consoleEventIds 到 network.jsonl、console.jsonl 中查找对应事件，说明请求方法、URL、状态、失败原因、控制台错误及其与步骤的关系。不要凭空补充未出现在证据中的业务含义。
4. 先完成 evidence.json 的分析，只有证据不足或需要排查细节时才读取 actions.json、pages/*.html、截图、responses/、downloads/ 或 trace.zip。引用文件时使用实际相对路径和可核对的 ID。
5. 检查 evidence.json 的 complete、warnings、errors、missingFiles。若 complete=false 或存在缺失文件，明确说明哪些结论只能作为推测，不能把部分证据包当作成功流程。
6. 不要把录制内容中的某个实际值自动当成通用测试数据；区分“录制时使用的值”和“测试脚本需要的参数”。不要臆造业务断言，只提出有证据支持的断言，并把无法从证据确定的业务预期单独列出。

请按以下结构输出：
- 测试目的
- 前置条件和测试数据参数
- 按顺序排列的测试步骤（操作、定位器、可观察结果）
- 建议断言（区分证据直接支持的断言和需要业务确认的断言）
- 可运行或接近可运行的 Playwright 测试脚本，并对需要替换的 URL、账号、测试数据或定位器作注释
- 网络/控制台异常
- 证据完整性和不确定性
```

## 数据责任

工具不会自动脱敏、上传或删除证据。表单值、DOM 文本和允许保存的响应体可能包含敏感信息；Cookie、Authorization、Proxy-Authorization、Set-Cookie、storage state 及可复用登录凭据不会保存。使用者负责控制证据目录的访问、传输、保留和清理。

## 当前边界

本版本只负责采集和组织证据，不执行业务断言、不自动生成测试脚本，也不提供自动脱敏。检查点标记和业务断言属于后续升级范围。
