# 日志平台一键导入接入（Python 3.10+）

本目录交给内网 Agent 即可作为后端接入参考。`import_cases.py` 提供可调用函数和命令行入口，依赖 PyMongo。普通入口直接使用现有单轮案例，不新增类型；Bad case 仅增加 `definition.badCase`，不会自动判失败或成为 Judge 参考答案。

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
python -m unittest discover -s . -p 'test_import_cases.py'
```

仓库 MongoDB 集成测试另外覆盖 Python 写入、应用解析和真实 validator：仅在隔离测试副本集设置 `EVAL_TEST_MONGODB_URI` 与安装了 PyMongo 的 `EVAL_TEST_PYTHON` 后运行 `bun test src/web/python-import.integration.test.ts`。测试会创建并删除随机测试数据库，禁止指向生产环境。

刷新评测系统案例列表即可查看导入内容；Bad case 的原始输出在案例详情中展示，列表仅显示标记，不自动启动评测。

## 可直接交给内网 Agent 的开发任务

请基于本目录实现日志平台的“选中模型调用轮次 → 选择目标案例集 → 导入回放 / 导入 Bad case”：

1. 将平台日志适配到样例合同，保留选中响应之前的上下文与本次输入；错误输出独立放入 badCase，禁止进入模型输入。不要猜测业务轮次与模型调用的对应关系。
2. 后台复用 import_single_turn_case / import_bad_case，使用服务端环境中的 Mongo 连接，不把凭据下发前端。用真实 moduleId 和稳定 taskId/turnId，普通入口复用已有模式。
3. 根据结构化 status 展示成功、已存在、冲突、权限不足、校验失败或结果未知；失败时保留导入身份，避免重复新增。
4. 新建/修改集合由 DBA 执行原生命令；运行时不自动建表、建索引或绕过校验。写入后提供案例 ID 及返回评测系统的入口，不自动启动评测。
5. 使用隔离测试库验证重复点击、并发点击、原始输出不泄露到输入、模块归档与校验失败事务回滚，再接入正式环境。
