# SPEC-017：单轮函数调用案例粘贴导入原生历史对话

- 状态：**Implemented / 已实施**
- 确认记录：2026-10-14 用户回复“继续实施”，批准包含 Cline 原生消息转换的完善方案。
- 日期：2026-10-14（北京时间）
- 来源：用户要求配置单轮函数回放案例时，粘贴 function call 对话 JSON，一键导入历史输入。用户随后明确导入来源也包括 Cline 原生 messages 记录，2026-10-14 完善此方案。
- 范围：agent-eval Web、案例保存/导入导出及原生单轮请求；不修改 SDK，不执行历史工具调用。
- 关联：SPEC-014、SPEC-016。

## 1. 当前行为与目标

已检查 types.ts、schema.ts、function-call-config.ts、function-call.ts、案例编辑页及 MongoDB 文档合同。当前 EvalMessage 只接受非空文本 user/assistant；页面只能逐条添加两种角色；请求按系统提示词 + history + 本轮 prompt 组装。直接导入原生 assistant.tool_calls / tool.tool_call_id 会被拒绝或丢失结构，不能只增加粘贴按钮。

目标：用户直接粘贴 Cline 原生 messages 文件，或标准 function call JSON，自动识别、预览并一次应用到案例草稿，系统指令、调用参数、调用 ID 与工具结果保持完整。案例依旧只发送本轮一次模型请求，历史不重放、不执行。

## 2. 操作流程

仅在“单轮函数调用 → 输入 → 历史对话”提供明显入口“粘贴 JSON 导入”，同区域显示简短提示“已有 function call 对话可直接粘贴；工具调用不会执行”。

打开导入面板后：

1. 大文本框粘贴 JSON，首选提供“Cline 原生记录”示例，另提供“标准 function call”示例；支持换行、滚动及键盘操作。
2. 点击“解析并预览”，展示识别格式（Cline messages / OpenAI messages / type-data）、原始及发送消息数量、角色数量、工具调用/结果数量和按顺序的消息卡片。调用卡显示工具名、ID、参数，工具结果卡显示对应 ID、内容摘要；长内容折叠，不把整份 JSON 长表塞入主表单。
3. 明确选择导入范围：默认“仅导入历史，保留本轮输入”；另可选“最后一条用户消息作为本轮输入”。后者仅在记录最后一条确实是纯文本 user 时启用；Cline 的 user/tool_result 不是本轮用户问题。对于含后续助手答案的完整记录，增加“选择某条用户消息作为本轮输入”：用户明确选择后，展示该条之前作为历史、该条作为输入、后续若干条不导入的边界，不自动截断。工具结果或混合工具结果的 user 不能作为本轮输入。
4. 点击“导入到案例”。按钮旁显示将替换的历史条数、是否替换本轮输入、是否启用导入系统消息；应用前不改原表单。直接更新草稿、关闭面板、展开历史区，无重复确认弹窗。仍需点击案例的“保存”才写入数据库。
5. 导入后展示角色和工具调用链卡片，以及“重新导入”“清空原生历史”入口；文本可读，结构字段折叠查看。首期结构编辑通过重新导入完成，不将 tool_calls 转成普通文本，也不允许随意删除单条工具结果造成断链。

语法或结构错误定位到 messages[3].data.tool_call_id 等具体路径，提示原因和修正方式；取消、解析失败或校验失败不改变现有草稿。典型示例：“第 4 条工具结果引用 call_2，但前文没有对应调用”。空输入/空消息列表禁用导入；清空使用单独入口。

## 3. 支持的输入形式

### 3.1 OpenAI Chat Completions 原生消息

接受直接消息数组，或仅抽取对象中的 messages 数组（其他外层请求/导出元数据不导入）：

```json
{
  "messages": [
    {"role": "system", "content": "你是代码助手。"},
    {"role": "user", "content": "读取 demo.py"},
    {"role": "assistant", "content": null, "tool_calls": [
      {"id": "call_1", "type": "function", "function": {
        "name": "read_files", "arguments": "{\"paths\":[\"demo.py\"]}"
      }}
    ]},
    {"role": "tool", "tool_call_id": "call_1", "content": "print('hello')"},
    {"role": "user", "content": "把 hello 改成 world"}
  ]
}
```

### 3.2 用户示例的 type/data 包装

```json
{
  "messages": [
    {"type": "system", "data": {"content": "你是代码助手。"}},
    {"type": "user", "data": {"content": "读取 demo.py"}},
    {"type": "assistant", "data": {"content": null, "tool_calls": [
      {"id": "call_1", "type": "function", "function": {
        "name": "read_files", "arguments": "{\"paths\":[\"demo.py\"]}"
      }}
    ]}},
    {"type": "tool", "data": {"tool_call_id": "call_1", "content": "print('hello')"}}
  ]
}
```

明确映射 type → role，data 中提取标准消息字段；type 与 data.role 如同时存在必须一致。允许一个文件混合两种明确格式，但预览说明已规范化。messgaes 作为 messages 的兼容别名，显示“已将 messgaes 规范为 messages”；两者同时存在拒绝，不猜测优先级。

首期支持文本 system、developer、user、assistant、tool。developer 原样保留并提示目标服务须支持此角色。assistant 允许文本或 null/缺省 content + tool_calls。tool.content 必须为文本；不自动将对象 stringify，以免改变协议和语义。

Cline 原生 messages.json 按第 3.3 节明确适配。首期不自动解析 LangChain 序列化、Responses API items、旧 function_call/function 角色或任意多模态消息；遇到时给出明确格式说明。标准/包装消息的未知字段拒绝并指出字段；Cline 已识别的消息元数据按第 3.3 节处理，不当作未知协议字段。支持标准 name 可选字符串。首期不识别任意日志事件包装。

### 3.3 Cline 原生 messages.json（首要来源）

已核对源码：

- sdk/packages/core/src/services/session-data.ts 的 buildMessagesFilePayload；session-manifest-store.ts 的实际保存逻辑。
- sdk/packages/shared/src/llms/messages.ts 的 MessageWithMetadata 和工具内容块。
- sdk/packages/llms/src/providers/compat.ts 的 call_id/id 映射；message-builder.ts 的结构化工具结果。

当前仓库原生文件包含 version、updated_at、agent、sessionId、origin、messages，系统提示词是可选顶层 system_prompt。messages 主要为 role=user/assistant，content 为字符串或内容块数组；并不是标准 OpenAI wire messages，不能直接发给兼容模型服务。

典型导入示例：

```json
{
  "version": 1,
  "agent": "lead",
  "sessionId": "original-session",
  "system_prompt": "你是代码助手。",
  "messages": [
    {"id": "m1", "role": "user", "content": [
      {"type": "text", "text": "读取 demo.py"}
    ]},
    {"id": "m2", "role": "assistant", "content": [
      {"type": "text", "text": "先查看文件。"},
      {"type": "tool_use", "id": "call_1", "name": "read_files", "input": {"paths": ["demo.py"]}}
    ]},
    {"id": "m3", "role": "user", "content": [
      {"type": "tool_result", "tool_use_id": "call_1", "name": "read_files", "content": "print('hello')", "is_error": false}
    ]},
    {"id": "m4", "role": "user", "content": [
      {"type": "text", "text": "把 hello 改成 world，使用 editor 工具。"}
    ]}
  ]
}
```

适配规则：

| Cline 原生字段 | 兼容请求中的结构 |
| --- | --- |
| 顶层 system_prompt | 在历史前插入 system 消息，不再额外叠加配置指令 |
| user.content 的 text 块 | user.content 文本；多个 text 按原顺序连接 |
| assistant 的 text + tool_use | 一条 assistant，文本保留为 content，工具块转成 tool_calls |
| tool_use.input 对象 | JSON.stringify 为 function.arguments 字符串，保留对象值和类型 |
| user 中的 tool_result | 独立 role=tool 消息，不当作普通 user 内容 |
| tool_result.tool_use_id | 查找已登记调用，再映射为相同 tool_call_id |
| 原生 id/ts/modelInfo/metrics/metadata/agent/sessionId | 不混入模型协议；原始消息 ID 和来源信息供预览定位及快照追溯 |

转换必须处理下列细节：

- 一个 user 消息可含多个并行工具结果，转换为多条 tool；若工具结果后还有普通文本，转换为后续 user，前提是 pending 调用已全部闭合。文本夹在未闭合工具链中时给出具体错误，不擅自移动或重排。
- tool_use.id 是内部关联 ID，call_id 是可选 provider ID。发送 ID 优先 call_id，否则 id；建立两种 ID 的同一调用映射。工具结果引用任一别名均映射到同一发送 ID，重复/歧义/碰撞拒绝。不能只替换 assistant ID 而漏掉工具结果。
- tool_result.content 除字符串还可能是文本块或运行时结构化 JSON（例如 read_files 的 query/result/success 数组）。字符串保持原样；纯文本块顺序连接；结构化 JSON 按完整 JSON 文本发送，预览明确提示已编码为文本，并保留原始结构用于查看。允许 is_error=true 的结果，标注错误状态，不将其当作成功；请求中不增加非标准 is_error 字段。
- 原生 file 块仅使用已内联的 path/content，以带文件路径标注的文本转换，预览说明；不访问本地 path，不重新读取文件。未知内容块拒绝。
- thinking/redacted_thinking 及 signature 不当作助手正文，也不能声称可跨模型无损回放。检测到时在预览列出条数，默认阻止应用，用户可明确勾选“仅导入文本和工具轨迹，不发送思考块”后继续。原始内容仅在预览中查看，不拼进模型输入。
- image/media 和工具结果中嵌套的图片等多模态内容首期阻止导入，定位具体块；不能静默丢图后声称成功，也不自动下载媒体。
- 原生记录可能已经压缩；若孤立 tool_result 缺少前文调用，提示“上下文可能已压缩，请导入包含对应调用的完整片段”，不伪造调用或补空结果。
- 顶层 system_prompt 与 messages 内系统指令同时存在时，要求在预览选择指令来源，不自动重复。普通数组不带 system_prompt 时不猜测原系统提示词。
- 文件 agent=subagent/teammate 可作为单个会话上下文导入，预览展示来源；同一导入中混杂不同消息 sessionId 时阻止应用并提示拆分，不把团队会话拼为一条对话。原始 sessionId 不覆盖新执行的 sessionId 或请求头变量。

这是“将 Cline 存储上下文转换为本轮兼容请求”的能力，不保证重现原 SDK/原提供商的逐字节 wire 请求。源码支持的格式与用户内部 Cline 版本可能有差异，实施时以原生样例及严格识别测试为准，不宽松猜测任意事件封装。

## 4. 保存合同与请求组装

functionCall 配置增加可选 history，保存规范化原生消息数组：

```json
{
  "replayMode": "function-call",
  "prompt": "把 hello 改成 world",
  "history": [],
  "functionCall": {
    "tools": ["read_files", "editor"],
    "toolChoice": "auto",
    "history": [
      {"role": "system", "content": "你是代码助手。"},
      {"role": "user", "content": "读取 demo.py"},
      {"role": "assistant", "content": null, "tool_calls": [
        {"id": "call_1", "type": "function", "function": {
          "name": "read_files", "arguments": "{\"paths\":[\"demo.py\"]}"
        }}
      ]},
      {"role": "tool", "tool_call_id": "call_1", "content": "print('hello')"}
    ]
  }
}
```

- 增加可选 functionCall.historySource 保存格式、原 sessionId、原消息 ID/块索引到规范化消息的映射，以及转换提示。完整粘贴 JSON 只存在于导入面板，不额外持久化未选入的后续答案或外层请求；规范化历史和来源摘要随快照固定。
- 独立原生 history 不扩展 EvalMessage/SDK 的普通历史合同。没有 functionCall.history 的旧案例仍按现有 history 执行，现有例子不变。
- 粘贴应用后将旧普通 history 清空，避免双份历史；预览明确“替换当前历史”。有原生 history 时仅使用它，不能同时拼接旧历史。
- 原生历史含 system/developer 时，保留其原始顺序，并不再额外加案例或默认系统提示词；页面显示“本案例使用导入的系统指令，配置中的系统提示词不叠加”。不修改原系统提示词配置。没有原生指令时沿用现有系统提示词优先级。
- 请求顺序是有效系统指令 + 有效历史 + 本轮 user prompt；选择末条 user 为本轮输入时从原生历史移除该条，因此不重复发送。
- 不从历史自动更改本轮可用工具或 toolChoice；历史工具可不在本轮六工具列表内，因为它们只作背景。模型本轮可调用的工具仍由案例配置明确决定。
- 本轮 prompt 仍必填。单轮文字/完整任务不读取 functionCall.history；切换模式保留原生配置并明确提示其仅用于函数调用，不偷偷降成文本。批次强制切换模式同样遵循这一规则。
- functionCall 编辑器更新工具选择时须保留 history；保存、案例复制/移动、导出、快照及历史重跑完整保留结构。Python ctx.case 读取固定案例原生历史，不将其混入本轮 diagnostics.tool_calls 或 functionCallResponse，验证目标依旧只有本轮响应。

## 5. 校验及限制

UI 和服务端共享纯解析/规范化模块；Web 保存/导入和 CLI schema 都校验原生历史，不能仅靠前端。默认上限 UTF-8 1 MiB、500 条消息；粘贴入口在 JSON.parse 前检查大小，结构入口按规范化消息序列化字节检查。

- 不允许非 JSON、未知角色、错误 content 类型、缺失工具名/ID、不合法 tool_calls 封装。标准格式 arguments 必须是严格 JSON 对象文本，保留原字符串而不重新编码；Cline input 必须为 JSON 对象并编码成参数字符串，不自动修复或转换类型；重复键和非标准 JSON 常量拒绝。
- tool_calls 非空，每项 type=function；发送调用 ID 在整个导入历史中唯一，内部 ID/call_id 别名按第 3.3 节校验。每条 tool 必须引用未完成的前文调用，同一调用只能有一条结果；同一 assistant 的并行调用允许工具结果任意顺序。
- 有待完成调用时，只接受其工具结果；不能直接进入下一条 user/assistant。导入结尾仍未完成调用时拒绝，并指出缺少哪些结果，避免追加本轮 user 后形成无效协议。
- system/developer 仅允许在历史前部指令区；多个指令保留顺序、不擅自合并。不对历史工具参数施加本轮六工具业务 schema，保留它们作为原始背景。
- 末条 assistant 的历史允许导入，但预览提示“记录已包含助手回复，请确认这些内容属于历史而非待验证答案”；不隐式删除。解析从不发起模型调用或执行工具。

## 6. 存储与部署兼容

同步 functionCall 类型及 parseFunctionCall、案例 UI、function-call.ts、MongoDB 的 functionCall.history 校验、导入/导出、运行快照和帮助文档。SQLite 的 JSON 记录无需表迁移。MongoDB 已有部署升级时需运行 bun run mongo:prepare；旧历史记录及普通 user/assistant 案例继续有效。

不保存粘贴文本框中的整个外层请求（如 headers、api_key、usage 等）；仅保存规范化 messages。本轮功能不新增 SDK 或模型提供商支持。

## 7. 验收与实施顺序

1. 用户于 2026-10-14 回复“继续实施”，已确认；新增共享消息合同/解析器与错误定位测试。
2. 首先实现 Cline messages 内容块转换、别名 ID 关联、原生系统提示词和元数据识别，再完成粘贴面板、预览、范围选择、导入后卡片、清空/重新导入、系统指令提示；验证取消和失败不覆盖草稿，窄屏和键盘可用。
3. 接入保存及原生请求组装；更新 MongoDB 合同、导出与上下文说明，提供 Cline 原生、标准 messages、type/data 三类可粘贴示例。
4. 使用实际 SDK 保存逻辑生成原生 fixture，并覆盖并行调用、不同 id/call_id、结构化工具结果、文本+工具结果混合、错误结果、思考确认、多模态阻止、压缩断链及回放边界。随后本地 HTTP mock 检查发送的完整 messages：system、assistant.tool_calls、arguments 原文、tool_call_id、tool.content 一致，末条 user 提取后仅发送一次，未执行历史工具，仅检查本轮响应。
5. 验证格式/尺寸/断链/重复调用 ID/重复键/未知字段错误；普通历史兼容、模式切换、工具编辑保留历史、复制与重复执行快照、历史试验证以及 MongoDB 校验合同。
6. 运行类型检查、构建和相关回归；记录真实 MongoDB/目标 provider 等未验证环境。完成后补实施记录并标记 Implemented。


## 8. 实施与验证记录

2026-10-14 在 work 分支实施，未修改 SDK：

- function-call-history.ts 新增共享严格 JSON 解析、三类格式识别、原生内容块转换、发送 ID/内部 ID 关联、工具链完整性与大小限制校验。当前问题单独校验，后续答案明确排除；并行结果不重排，缺失历史调用不补造。
- functionCall.history/historySource 类型、保存/导出合同及 MongoDB 校验器已更新；原案例的普通文本 history 保持兼容。历史来源保存格式、会话及消息索引，不额外持久化未导入内容。
- history-import.ts 提供粘贴弹窗、示例、解析预览、历史/指定问题范围选择、思考确认、系统指令来源选择、来源详情及导入后消息卡片。编辑工具保留历史，模式切换保留配置；取消、错误和页面导航不应用草稿。
- function-call.ts 只发送规范化历史和本轮问题，导入指令替代默认指令，本轮工具仍由配置决定。Python 固定输入的 case.history 为有效历史，case.function_call 保留配置和来源；diagnostics 中仅有本轮响应。
- examples/history-import 提供 Cline 原生、标准消息、type/data 三份粘贴示例，以及已转换的 suite.json 和说明。STARTUP.md、examples/README.md、docs/mongodb.md 补充操作及升级说明。

验证（分组运行，共 26 个不同测试通过、7 个实库测试跳过、0 失败）：

- 7 项共享解析/合同测试：三格式与末条/指定问题提取、后续答案排除、当前问题字段校验、并行调用与别名、JSON/参数原文保留、结构化错误结果/文件内联、思考确认、图片阻止、混杂会话、重复键/ID/结果、断链、大小上限、系统指令冲突、旧合同及 MongoDB 文档往返。
- 1 项实际执行集成：本地模拟模型接收完整标准 messages；Python 读取固定历史且只验证本轮工具响应；重复执行、复制及修改后快照不变。通过真实 SDK 执行生成的 .messages.json 再导入转换，验证原生文件兼容。
- 18 项相关既有回归通过：函数调用、Python 验证与历史试验证、案例复制/移动、请求头快照及 MongoDB 配置。7 项 MongoDB 实库集成因未设置 EVAL_TEST_MONGODB_URI 跳过。
- Playwright 浏览器检查通过：解析错误/取消保留草稿、边界预览排除后续答案、工具编辑与保存重载、模式切换、思考确认、390px 弹窗/页面无横向溢出，以及一次真实函数回放请求的系统指令/调用 ID/结果/执行会话 ID。
- TypeScript 类型检查、构建、git diff --check 通过。

实施边界：模型测试为本地 openai-compatible mock，未验证真实内网提供商或 MongoDB 实库；多模态、原 SDK 请求逐字节回放仍不支持。已有 MongoDB 部署需要 mongo:prepare 更新集合合同。无范围变更。
