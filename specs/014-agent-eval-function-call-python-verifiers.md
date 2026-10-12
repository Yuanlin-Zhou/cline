# SPEC-014：逐工具 Python function call 格式验证与单轮示例

- 状态：**Implemented / 已实施**
- 确认记录：2026-10-12 用户明确要求按本方案执行，工具范围仅限 read_files、search_codebase、run_commands、fetch_web_content、editor、skills；其余回放、归档、导入示例范围保留。
- 日期：2026-10-12（北京时间）
- 基线：work 分支；当前工作区干净，HEAD 60c77bd。
- 来源：用户要求为每个工具提供 Python 结果验证器，分析单轮回放调用轨迹、验证 function call 标准格式，保存到 agent-eval/examples，并提供可导入运行案例。
- 关联：SPEC-011、SPEC-013、docs/agent-eval-intranet-roadmap.md。

## 1. 目标与当前限制

验证模型真实生成的原生 function call 的调用封装、工具名称和参数结构；不把普通回复中描述调用或输出一段 JSON 当作实际 function call，不验证工具执行成功、审批或业务产物。

当前 src/replay.ts 对 single-turn 强制 tools=none、maxIterations=1，runner.ts 设置 enableTools=false；只上传验证器、导入现有单轮案例不会让模型收到工具定义。

Python 上下文 v2 中 conversation.messages[].blocks 支持 tool_call，含 tool_name/tool_call_id/input；diagnostics.tool_calls 是已解析的结果/诊断列表，没有原始 function.arguments 或完整响应封装。仅看这些字段可以检查已观测参数，但不能证明原始 arguments 是合法 JSON 字符串，不能识别 SDK 宽容转换前的错误，也不能确认主会话所有调用均已保存。

SDK 输入校验有容错。例如 read_files 接受 file_path 别名，行号可被转成数字；run_commands 接受多种替代输入。严格标准须以**向模型公布的 inputSchema** 为准，不能拿容错后的输入作为原生响应规范。

## 2. 拟实施范围

### 2.1 保留原模式，新增专门的函数调用单轮

新增显式 replayMode=function-call，页面名称“单轮函数调用（仅检查格式）”。原 single-turn 的文本回放、full-task 的实际工具执行均保持现有语义。

首期使用 OpenAI-compatible Chat Completions：发送一次非流式请求，携带本案例选择的工具 JSON Schema，采集原始响应，不进入 Agent 工具执行循环，不读写任务文件、不运行命令、不抓取网页、不启动子代理。原始请求工具定义、响应及调用轨迹作为本次执行的固定证据保存，可被 Python 与历史试验证读取。

沿用评测服务的模型地址、密钥环境变量、自定义请求头、超时、取消和队列；明确检查 providerId=openai-compatible（兼容服务如 DeepSeek 可用该设置），其他协议预检给出配置说明，不能悄悄改用文字模拟调用。该路径不修改 SDK 源码；它评测兼容服务的原生 function call 响应，不声称评测了 SDK 工具执行行为。

案例新增 functionCall 配置：选择本轮可用工具名称，默认 toolChoice=auto；示例通过提示词要求指定工具，验证器检查期望调用。可选择 required/named 时明确为强制选择场景，不能与自动选择的准确率混同。一次响应可含多个调用，支持精确期望调用数及允许工具列表。该模式只开放 Python 结果验证，不开放 file/command/JS 工具执行验收。

这是完成真实单轮可导入案例所需的新增能力；如果仅提供脚本而不补此路径，当前 single-turn 案例只能得到“缺少调用轨迹”，无法完成用户目标。

### 2.2 工具覆盖

仅覆盖用户指定的 6 个基础工具：read_files、search_codebase、run_commands、fetch_web_content、editor、skills。apply_patch、ask_question、submit_and_exit、子代理、团队、动态 MCP 工具及通用上传验证器均不在本轮范围。

每个工具以向模型公布的 inputSchema 为准。Schema 来源与源码摘要记录在生成清单中，提供刷新/差异检查；不使用运行时容错分支替代公开标准。

### 2.3 Python 文件与交付位置

在 apps/examples/agent-eval/examples/function-calls/ 下提供：

- verify_<tool_name>.py：每工具一个，独立单文件、标准库、入口 def verify(ctx)，可以逐个上传，不依赖相邻 Python 模块。
- schemas.json / manifest.json：Schema 与来源说明；单工具脚本内嵌所需 Schema，上传不依赖这两个文件。
- fixtures/：正确/错误/缺少轨迹的上下文，支持本地直接调用 verify(ctx) 检查验证器。
- README.md：上传/绑定规则、参数、检查范围、失败/证据不足区别、历史試验证以及如何更新 Schema。

apps/examples/agent-eval/examples/importable/function-call-basic.json 提供至少 read_files、search_codebase、run_commands、fetch_web_content、editor、skills 的单工具案例；另提供多调用、包含历史上下文的案例集；本轮仅覆盖上述六工具。任务请求只用于生成参数，不执行工具。

导入文件使用稳定的验证器标识；提供批量上传/绑定准备脚本，经现有上传 API 发布示例验证器并生成已绑定真实 verifierId 的导入文件。用户按“运行准备脚本 → 导入生成的案例 JSON → 配置兼容模型 → 执行”的路径使用，不需要管理员注册或重启。也支持手动上传后在规则卡选择脚本。静态未绑定示例明确标注需先准备，不能把不可用 verifierId 称作开箱即用。

## 3. 输入、判定与错误分类

在现有上下文 v2 中增加明确版本的函数调用响应区（暂定 diagnostics.function_call_response）；保存 source/protocol、请求 tools/tool_choice、响应原始 JSON 文本、选定 choice、调用列表、完整性和归档引用。具体大小限制与正常评测证据机制一致；截断/缺失不能通过。conversation 可以用于辅助解释，不能替代原生封装检查。

通用检查包括：

1. 本次执行与轨迹来源正确，只读取当前单轮响应，不把历史 assistant/tool_result 当作待检调用。
2. 响应 message.role=assistant，tool_calls 为数组；每项 id 为非空字符串且本轮唯一，type=function，function.name 属于请求公布的工具；arguments 为字符串且严格 JSON 可解析为对象。非法 JSON、重复键、NaN/Infinity 不接受。
3. 不自动把字符串数字/布尔转换为正确类型；JSON bool 不当作 int。根据公开 Schema 检查 required/type/enum/数组及嵌套对象/长度/数值约束/组合分支，处理额外字段须遵守 Schema 的 additionalProperties 定义；未明示禁止额外字段时不自行判错。
4. 所有观测调用均须格式有效，并满足脚本指定的目标工具/调用数/允许列表。错误提示定位到 call 索引及 JSON 参数路径，返回 checks 的 expected/actual。
5. 不读取文件以验证存在，不运行 commands，不校验真实工具执行/审批，不增加公开 Schema 以外的补丁或业务语法判分。

判定：完整正常响应无目标调用、工具名错误、封装/JSON/参数错误返回 fail；缺失原始轨迹、截断、来源未知或执行未完整结束返回 insufficient；验证器自身异常由现有 Python runner 标记验证错误。使用 SDK 已解析会话轨迹时仅提供明确的参数检查结果，整体原生格式结论为 insufficient，不能凭归一化数据返回原生格式 pass。

## 4. 兼容与数据行为

- 原两种回放不改语义，旧案例/规则/上下文仍可运行；新增上下文字段可选，旧历史明确不足，不读取当前可变化日志补齐。
- 新 replayMode/functionCall 需要同步案例导入/导出、模式选择、批次覆盖、runner 与 worker 路由、配置快照、MongoDB 校验器、上下文和 Python 单轮预检；SQLite 与 MongoDB 两种存储都支持。
- 已有部署更新 MongoDB validator 的步骤必须写入启动说明；没有原始响应证据的历史不会生成虚假的证据。
- 不修改 SDK 源码，不新增真实工具行为判分能力，不从完整任务结果假冒单轮结果。

## 5. 实施步骤及验收

1. 按已确认的函数调用回放与六工具覆盖范围实施。
2. 从当前公布工具 Schema 建立清单、生成逐工具独立 Python 文件并提供刷新检查。
3. 实现专用一次请求/不执行工具的回放路径、固定证据、上下文与历史试验证；补齐导入/页面模式及存储兼容。
4. 编写批量上传/绑定辅助脚本和可导入示例，更新 examples/README 与启动说明。
5. 用本地 mock 模型验证请求携带真实工具定义、一次响应后不执行工具；导入、上传、执行、结果明细、历史试验证走真实服务路径。
6. 验证全部 6 个 Schema 的合法例、字段缺失/错误类型/无效嵌套等非法例；校验重复调用 ID、重复 JSON 键、错误 arguments 类型、无调用、额外调用、历史污染、缺失/截断响应。检验 Python 标准库运行以及上传单文件可独立工作。
7. 对原 single-turn/full-task 运行回归；类型检查、相关测试、SQLite 与 MongoDB 校验合同验证；记录真实模型验证是否执行，不以 mock 结果声称真实模型全部通过。

## 6. 实施记录

已按用户确认的六工具范围实施，SDK 源码未修改。

### 交付

- examples/function-calls/ 下 6 个独立 `.py` 验证器、13 个正反例/缺失输入 fixture、Schema 快照/来源清单、标准库测试与 prepare.py 上传绑定工具；模板与生成器位于 scripts/。
- importable/function-call-basic.json：6 个单工具案例；function-call-multi.json：一次响应多调用、历史上下文共 2 个案例。准备脚本生成真实 verifierId 绑定后的可执行导入文件，无需管理员注册。
- 新 function-call 模式发送一次非流式 OpenAI-compatible 请求，只保存响应；无需创建 SDK Agent 运行时，不执行工具。请求 Schema 来自源码生成快照；响应原文、请求工具与选择方式纳入固定证据和 Python 上下文 v2 的新增可选字段。
- 支持工具选择/自动或强制调用、案例模式筛选/导入/保存/批次覆盖；现有 Python 试验证直接复用固定原生响应。结果工具诊断明确未执行。
- 更新 MongoDB 模式枚举与 functionCall 校验合同，SQLite 保留原结构；STARTUP 与 examples 操作说明补充升级和运行方式。

### 验证

1. Python 标准库测试 5 组通过，覆盖六工具合法/必填缺失、原生封装、重复 ID/JSON 键、非法 JSON/非有限数、数字字符串/bool、SDK 输入别名、数组与嵌套类型、截断/模式/来源/Schema 缺失、历史不混入当前响应、多调用准确计数。每个脚本可独立运行和上传。
2. function-call.test.ts + importable-examples.test.ts：最终 5 通过、0 失败、141 次断言。真实 Web 服务上传六文件、prepare.py 绑定、HTTP 导入 8 个案例、worker 请求本地 mock、Python 验证 8 个正例通过；新增字符串行号端到端负例返回业务 fail。固定输入预览与历史试验证通过，历史试验证请求数不增加、原结论不变化。
3. 请求参数与自定义请求头、一次请求、不执行命令/其他工具、超时、512 KiB 正文上限、旧回放配置、MongoDB 文档往返与模式合同均通过相关测试。
4. 完整 src 回归首次 81 通过、8 跳过、2 失败；失败来自旧示例测试写死文件/案例名单。更新名单以包含新增 8 案例后定向复测通过，其他 81 项已通过；因此当前涉及的 83 项测试均已验证。8 项跳过为 7 项未配置实库的 MongoDB 集成与 1 项 Windows 专属进程测试。没有声称运行实际 MongoDB。
5. Chromium：工具/选择方式载入保存、运行一次模型请求/Python 通过、工具诊断说明、模式切换保留值、没有工具时展开输入页并定位错误、390px 无横向溢出通过；浏览器无 pageerror。
6. 类型检查、tsc 构建、Node 加载编译后 JSON Schema、生成器 --check、git diff --check 通过。未修改 SDK，无真实模型供应商请求。

### 边界与细节

仅覆盖已确认六工具，无 apply_patch/提问/提交/团队/子代理/MCP 通用验证器。原始响应上限 512 KiB；验证器最多 15 项调用，以匹配平台 100 条 checks 限制，超限报告不足。明细大值截断并明确标注，完整原始输入仍可查看/下载。严格格式检查按 Schema 定义，不增加文件存在、命令成功、URL 可访问等业务条件。

当前首期仅支持 OpenAI-compatible Chat Completions，其他 providerId 预检提示调整配置；SDK 解析后的旧轨迹不会被当作原生响应通过。真实模型效果及实际 MongoDB 部署需在对应环境验证；MongoDB 升级需运行 mongo:prepare，已在启动说明注明。


## 7. 已批准结果展示范围内的缺陷修复（2026-10-12）

用户反馈验证失败时只有检查项 expected/actual，看不到本轮模型输出。原因是结果页仍仅渲染 result.text，原生 function call 的 message.content 通常为 null；虽已固定归档 functionCallResponse，结果页没有渲染它。本次补齐既有方案的模型响应可查看要求，不新增回放模式、判分或存储行为。

- “结果与断言”在检查结论之前展示“本轮模型响应”，包括回复、调用名称/id/type 和 arguments 的原始值；非字符串 arguments 和异常调用结构也直接呈现。
- 模型返回的 reasoning_content 可单独展开；完整原始正文可查看、复制和下载，保留无效 JSON、重复字段和服务错误正文，不从验证器检查项反推模型输出。
- HTTP 错误或异常响应结构仍显示已有原始正文；旧历史缺少原始响应时明确说明，普通文字回复也放到检查结论前。
- 使用相同结果查看组件，适用于案例调试和历史/批次结果；已有原始归档数据无需重新评测。未改后端、SDK 或数据字段。

验证：类型检查与 git diff --check 通过；Chromium 通过四类真实 worker/验证器场景：字符串行号导致验证失败、仅文字无调用、非法响应 JSON、HTTP 503 正文。确认响应区域在检查结论前，原始 arguments 和思考内容可读，完整原文查看/复制/下载与模拟服务返回内容一致，390px 无横向溢出，页面无错误且未产生额外模型请求。
