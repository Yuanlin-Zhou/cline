# 日志平台一键导入接入（Python 3.10+）

本目录交给内网 Agent 即可作为后端接入参考。`import_cases.py` 提供可调用函数和命令行入口，依赖 PyMongo。普通入口直接使用现有单轮案例，不新增类型；Bad case 仅增加 `definition.badCase`，不会自动判失败或成为 Judge 参考答案。

## 已有完整 messages：优先使用这两个新入口

现在可以直接传入完整对话，不用手工整理 `history` 和 `prompt`：

- `import_case_from_conversation(client, database, payload)`：按网页“历史对话 JSON（批量生成案例）”生成普通案例。
- `import_bad_case_from_conversation(client, database, payload)`：同样转换历史，并保存独立的 Bad case 错误输出。

这两个入口生成已有的 **单轮函数调用（function-call）** 案例，支持 system/developer/user/assistant/tool 与现代 `tool_calls/tool_call_id`。系统消息、工具调用 ID、参数和结果链保留；只生成下一次模型响应，不执行历史工具。需要 `defaults.providerId="openai-compatible"`。仅支持现有六种工具的本轮工具声明；任意内部工具的声明适配不在此参考实现内。

请将 **import_cases.py 与 conversation_history.py 一起复制**，放在同一目录或可导入的模块路径中；运行只依赖 Python + PyMongo，不调用评测 Web API，也不依赖 Bun/Node。

```python
import os
from pymongo import MongoClient
from import_cases import (
    preview_conversation_case,
    import_bad_case_from_conversation,
    import_case_from_conversation,
)

payload = {
    "moduleId": "目标模块的真实字符串ID",
    "source": {"platform": "internal-agent-logs", "taskId": "task-123", "turnId": "turn-7"},
    "name": "任务123-第7轮-Bad case",
    "conversation": {
        "messages": [
            {"role": "system", "content": "项目使用 Bun。"},
            {"role": "user", "content": "如何安装依赖？"},
            {"role": "assistant", "content": "请执行 npm install。"},
            {"role": "user", "content": "这是后续消息，不参与这次回放"}
        ]
    },
    "badMessageIndex": 2,
    "badCase": {"observedOutput": "请执行 npm install。", "reason": "忽略了项目使用 Bun"},
    "options": {"tools": ["editor", "run_commands"], "continuation": "继续"},
    "defaults": {
        "providerId": "openai-compatible", "modelId": "你的模型名称",
        "baseUrl": "https://模型地址/v1", "apiKeyEnv": "EVAL_API_KEY"
    }
}

# 纯本地预览：可展示 definition.functionCall.history、prompt、boundary、notices。
# 参数错误抛出 ValueError，先处理该错误，再允许用户点击实际导入。
preview = preview_conversation_case(payload, bad=True)

with MongoClient(os.environ["EVAL_MONGODB_URI"], serverSelectionTimeoutMS=5000,
                 connectTimeoutMS=5000, socketTimeoutMS=15000) as client:
    result = import_bad_case_from_conversation(client, "ma_table", payload)
    # 普通入口传不含 badCase/badMessageIndex 的参数：
    # result = import_case_from_conversation(client, "ma_table", ordinary_payload)
```

`conversation` 可以是：完整 JSON 记录对象、直接消息数组，或包含整份 JSON 的字符串。支持 `messages`、`messgaes` 别名（不能同时存在）、标准 OpenAI 消息、`type/data` 包装及网页支持的 Cline 原生内容块。外层日志字段无需一一展开到 Python 参数；将原记录放进 conversation 即可。

输入字段与边界：

| 字段 | 要求 |
|---|---|
| moduleId / source / name / defaults | 沿用原入口；模块已创建，source 标识稳定，模型配置显式传入 |
| conversation | 必填；最多 500 条原始消息、1 MiB UTF-8；转换展开后的历史也最多 500 条 |
| badCase.observedOutput | Bad case 必填；错误示例独立提供，可为文本或 JSON 字符串，不自动猜测/抽取 |
| badMessageIndex | **完整对话包含目标错误回复时必填**；原始消息数组的零基下标，须选中 assistant，不能填平台 turnId；被选中消息和其后内容均排除 |
| options.tools | 可选，默认现有六种工具；可选工具子集，不重复 |
| options.toolChoice | 可选，默认 auto；也可为 required 或所选工具名 |
| options.continuation | 可选，默认“继续”；当实际末条不是普通用户文本时使用 |
| options.ignoreThinking | 可选，默认 false；有 thinking/reasoning_content 时，只有显式 true 才丢弃思考内容，转换通知说明处理结果 |
| options.systemSource | 有顶层 system_prompt 且消息内也有系统指令时必须明确选 file/messages，其他情况可省略 |

**两种用法要区分：**

1. 平台已经导出了“选中响应之前”的输入前缀：省略 badMessageIndex；Bad case 的错误输出另传。此时保留整份已选历史，并在 notices 提醒调用方确认其中没有目标错误回复或未来消息。
2. 平台传入含目标错误回复的完整记录：填写 badMessageIndex，先截取此前内容，再按网页规则转换。`boundary` 返回原始/选入/排除数量，便于前端显示。

转换按**实际末条**处理：末条是普通用户文本，就提为 prompt，其前内容作为原生历史；末条是助手或工具结果，就完整保留并追加 continuation。不会向前寻找更早的 user 来截断。对于原始由工具结果触发、没有新用户输入的调用，这与网页一样会追加续接文案，不能宣称原始请求逐字节一致。

系统指令、工具 ID/别名、结果顺序及 Cline 文件块内联文本按网页规则转换；不读取文件路径、不执行工具。未知角色/媒体、旧 function_call/function 协议、断裂或重复工具链、混合 sessionId、重复 JSON 键等在写库前报错。不要同时传旧入口的 history/prompt/functionCall/replayMode，避免混用来源。

新入口返回原有 status/caseId/moduleId，另附 `boundary` 和 `notices`。历史来源记录保存在 functionCall.historySource，Bad case 保存在 definition.badCase。新旧入口使用相同去重身份；同一轮次改用不同参数或增加转换元数据后如内容不同，会返回 conflict，不能自动覆盖旧案例。记录标识仍须保持稳定。

新入口可运行样例：

- `conversation-bad-case.json`：完整文本对话，排除目标错误回复和未来消息。
- `conversation-openai-tools-bad-case.json`：含 system、tool_calls、tool 结果的完整对话，选择错误回复。
- `conversation-cline-bad-case.json`：Cline 原生内容块，保留调用别名映射，排除错误回复。
- `conversation-normal.json`、`conversation-cline.json`、`conversation-type-data.json`：不新增 Bad case 信息的普通回放。

```bash
# 以下是终端命令；先设置实际连接信息，替换样例 moduleId 和模型配置。
python import_cases.py conversation-bad-case.json --conversation --bad-case --validate-only
python import_cases.py conversation-bad-case.json --conversation --bad-case
python import_cases.py conversation-openai-tools-bad-case.json --conversation --bad-case
python import_cases.py conversation-normal.json --conversation
```

Python 新用法不需要再修改集合或增加索引；它写入现有 functionCall.history/historySource、prompt 和 badCase 合同。下方原来的手工规范化入口继续可用。

## 先准备评测系统

1. 升级评测系统到支持 SPEC-031 的版本。旧版本编辑会丢弃新字段，不可混用。
2. 由 DBA 在**实际业务库**执行新版 `docs/mongodb-admin/update-collections.txt` 中 cases 对应的完整 `collMod`；首次建库使用 create 文件。本功能不改变 modules/verifiers 规则，不要求删除重建集合。
3. 数据库须支持事务（副本集或支持事务的分片集群）。模块必须已在评测系统创建，传入真实字符串 ID，不使用模块名称。模块 ID 可从评测系统 `GET /api/modules` 获取；来源任务 ID 与案例 UUID 不同。
4. Python 账号只需集合存在检查的 `listCollections`、案例 `find/insert`、模块 `find/update`，不需要建索引、建表或 `collMod`。不存在集合时停止，不隐式创建。应用启动仍只检查集合存在。

MongoDB 仅共享案例库和验证脚本；默认模型配置、历史批次仍在评测系统本地。接入方必须传入明确的 `defaults`。密钥只保存环境变量名称（如 EVAL_API_KEY），并在执行评测的服务上配置其值，不写入日志或 MongoDB。

## 日志平台需要实现什么

选择任务、模型调用轮次、目标案例集以及“导入回放 / 导入 Bad case”按钮。业务轮次若包含多个模型调用，要明确选中哪次响应。

适配器输出示例 JSON 的字段：`history` 是选中响应之前的上下文，`prompt` 是本次实际输入，`badCase.observedOutput` 是该次原始错误响应。严禁把错误响应或之后的消息放回历史中，否则评测输入泄露了答案。普通入口不携带 badCase。

- 纯文本单轮：参考 `single-turn.json`；history 只接受 user/assistant，系统指令显式映射到 systemPrompt，工具关闭且只生成一次响应。
- 带错误输出的单轮：参考 `bad-case.json`。
- 原生工具历史：参考 `function-call-bad-case.json`；使用已有 function-call 模式，将历史放在 functionCall.history，外层 history 为空。仅支持现有六种工具的工具声明；历史工具链完整保留，仅生成下一次模型调用，不执行工具。不能把不支持的角色/任意内部工具静默转换为文本。

传入文本字段保持原文。Python 对未知字段、断裂的工具链、超长内容和错误的配置明确报错。首期 defaults 支持 providerId/modelId/baseUrl/apiKeyEnv/systemPrompt/timeoutMs/headers/headersEnv；其他配置请通过评测系统后续编辑，不能直接向参考入口传入任意对象。

现有执行器要求非空 prompt，并会在历史后追加本轮用户输入。如果选中的调用仅由工具结果触发、没有新的用户文本，平台不能假称可逐字还原原请求：应明确让用户指定续接文案，或拒绝该轮次并提示需要适配；不能自动伪造 prompt。这一限制来自现有单轮执行合同。

## 作为平台后端库调用

```python
import os
from pymongo import MongoClient
from import_cases import import_single_turn_case, import_bad_case

client = MongoClient(os.environ["EVAL_MONGODB_URI"], serverSelectionTimeoutMS=5000,
                     connectTimeoutMS=5000, socketTimeoutMS=15000)
database = os.environ.get("EVAL_MONGODB_DATABASE", "agent_eval")

# payload 为平台按示例合同生成的对象；两个入口任选其一。
result = import_single_turn_case(client, database, payload)
# result = import_bad_case(client, database, bad_payload)
# 自定义集合名：case_collection="...", module_collection="..."
```

`build_document(payload, bad=True/False)` 可不连接数据库，便于接口层先校验；抛出的 ValueError 指明字段/规则，平台应转成用户可读错误，不输出原始日志和凭据。函数写入返回结构化结果：

| status | 平台行为 |
|---|---|
| created | 新案例已提交 |
| unchanged | 同一导入身份的相同案例已存在，返回原 caseId |
| confirmed | 提交响应曾不确定，但已通过多数派读核对到相同案例 |
| conflict | 内容变化、目标已归档或同名冲突；提示用户处理，不覆盖 |
| not-found / invalid-module | 目标集合/模块缺失或模块结构不匹配 |
| unauthorized | 账号授权不足 |
| validation-failed | 集合 validator 拒绝；查看 stage/collection/rules |
| transactions-unsupported | 部署不支持所需事务 |
| database-error / unknown | 未确认成功；保留身份，按 caseId 核对 |

去重 ID 使用固定 UUIDv5 命名空间及 moduleId/platform/taskId/turnId/导入入口生成，两个按钮可分别保存。同一来源字段必须稳定；**重试不能生成新 taskId/turnId，也不能修改命名空间**。已有案例一旦被编辑、归档或传入不同内容，返回 conflict，不自动覆盖。

名称冲突也返回 conflict；如果希望同一轮分别导入普通/Bad case，请使用不同可读名称。所有写入在与模块 writeVersion 协调的事务中完成，不依赖自定义唯一索引；不遵循协议的外部写入仍可能产生名称冲突。事务重试回调不能向外发送通知等副作用。

## 命令行运行

以下是 **Bash 终端**命令，Python 命令不在 mongosh 中运行：

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
export EVAL_MONGODB_URI='mongodb://用户名:URL编码后的密码@地址:27017/?authSource=admin&replicaSet=副本集名'
export EVAL_MONGODB_DATABASE='ma_table'
python import_cases.py single-turn.json --validate-only
python import_cases.py single-turn.json
python import_cases.py bad-case.json --bad-case
python import_cases.py function-call-bad-case.json --bad-case
```

PowerShell 设置环境变量使用 `$env:EVAL_MONGODB_DATABASE='ma_table'` 和 `$env:EVAL_MONGODB_URI='实际连接串'`，运行 `python ...` 命令相同。Windows 可用 `py -m venv .venv`、`.\.venv\Scripts\Activate.ps1` 建立环境。

先替换样例的 moduleId、模型与端点；`ma_table` 是本次用户的实际库示例，仓库默认库仍为 agent_eval，两端配置必须一致。Mongo URI 保存在部署环境，勿放到前端或提交到版本库。

`--validate-only` 只校验参数，不能证明远端 validator 或账号权限允许写入。命令行退出码成功为 0、失败/未知为 1；不输出案例正文、连接串或原始 MongoDB 错误。

## 验证

```bash
python -m unittest discover -s . -p 'test_*.py'
```

仓库 MongoDB 集成测试另外覆盖 Python 写入、应用解析和真实 validator：仅在隔离测试副本集设置 `EVAL_TEST_MONGODB_URI` 与安装了 PyMongo 的 `EVAL_TEST_PYTHON` 后运行 `bun test src/web/python-import.integration.test.ts`。测试会创建并删除随机测试数据库，禁止指向生产环境。

`bun test src/python-conversation.test.ts` 使用 Python 标准库直接对照网页现有转换逻辑，覆盖格式、工具链、思考内容、系统冲突、截取边界与无效输入。无需 MongoDB；无 Python 时会明确跳过，不将其算作通过。

刷新评测系统案例列表即可查看导入内容；Bad case 的原始输出在案例详情中展示，列表仅显示标记，不自动启动评测。

## 可直接交给内网 Agent 的开发任务

请基于本目录实现日志平台的“选中模型调用轮次 → 选择目标案例集 → 导入回放 / 导入 Bad case”：

1. 平台已有完整 messages 时直接放入 conversation；根据选中模型调用定位原始助手消息的 badMessageIndex，将原始错误输出独立放入 badCase。先调用 preview_conversation_case 展示截取边界与转换后的历史；不要猜测业务轮次与消息数组下标的对应关系。
2. 完整对话后台复用 import_case_from_conversation / import_bad_case_from_conversation；只有输入已规范化为 history/prompt 时才使用旧 import_single_turn_case / import_bad_case。使用服务端环境中的 Mongo 连接，不把凭据下发前端；真实 moduleId 和稳定 taskId/turnId 不变，普通入口复用已有模式。
3. 根据结构化 status 展示成功、已存在、冲突、权限不足、校验失败或结果未知；失败时保留导入身份，避免重复新增。
4. 新建/修改集合由 DBA 执行原生命令；运行时不自动建表、建索引或绕过校验。写入后提供案例 ID 及返回评测系统的入口，不自动启动评测。
5. 使用隔离测试库验证重复点击、并发点击、原始输出不泄露到输入、模块归档与校验失败事务回滚，再接入正式环境。
