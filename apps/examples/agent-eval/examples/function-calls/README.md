# 六工具 Python 原生 function call 验证器

覆盖 `read_files`、`search_codebase`、`run_commands`、`fetch_web_content`、`editor`、`skills`。每个 `verify_<工具名>.py` 是一个独立的标准库脚本，入口为 `verify(ctx)`，可直接上传，无需安装 Python 第三方包或管理员注册。

使用 **单轮函数调用**：发送一次带所选工具 Schema 的 OpenAI-compatible Chat Completions 请求，保存原始响应，随后执行验证器。不会读取任务文件、执行命令、访问目标网页、调用技能或启动 Agent 工具执行。`toolChoice=auto` 检查自动选择；`required` 或指定工具名只适合强制调用格式测试。

## 不限制工具调用次数的六个新脚本

[unrestricted/](unrestricted/README.md) 提供另外六份独立验证器：不限制精确次数、范围、总次数，也移除了 15 条处理上限。参数可用 `{}`；仍要求出现目标工具并逐条校验全部调用，报告采用汇总与失败优先明细。旧案例中的次数参数在该版本忽略，原脚本行为不变。

## 快速使用

1. 启动 agent-eval Web 服务；在“运行配置”中选择 **OpenAI-compatible**，填写模型 ID、`baseUrl`（如 `https://兼容服务/v1`）和密钥环境变量。支持该协议的 DeepSeek 等服务可用此入口。先在服务器设置密钥环境变量。
2. 从 agent-eval 根目录执行下方命令，把脚本上传至正在运行的服务并生成已绑定真实 ID 的案例集：

```bash
python3 examples/function-calls/prepare.py \
  --url http://127.0.0.1:3130 \
  --output /tmp/function-call-basic-bound.json
```

3. 进入 **案例集 → 导入案例**，选择目标模块，将生成文件粘贴为 JSON 导入。运行六个案例，在“结果与断言”先查看“本轮模型响应”的回复文字、工具名称与原始 arguments，再查看调用封装和参数检查。可展开完整原始响应、复制或下载；验证失败、非 JSON 响应和服务错误正文也会保留展示。
4. 多调用和历史上下文示例使用另一模板：

```bash
python3 examples/function-calls/prepare.py \
  --url http://127.0.0.1:3130 \
  --template examples/importable/function-call-multi.json \
  --output /tmp/function-call-multi-bound.json
```

服务地址请替换为实际端口。Windows 的 `--output` 可使用 `function-call-basic-bound.json`，解释器命令可使用 `python`。准备脚本不会自动导入或执行案例；每次执行会上传新的脚本版本和 ID，生成文件对应本次 ID。模板中的 `example-fc-*` 是待绑定占位，不能直接运行。

也可手动在 **案例详情 → 判定规则 → Python 脚本 → 上传 .py** 上传对应文件，并在单轮函数调用模式的输入页选择公布工具。无需更改管理员验证器配置或重启。原文字“单轮回放”仍然不公布工具，不能用于此验证。

## 校验内容

| 验证器 | 参数的标准结构 |
| --- | --- |
| `verify_read_files.py` | `files` 数组；每项含 `path`，可选正整数或 null 的 `start_line` / `end_line` |
| `verify_search_codebase.py` | `queries` 字符串数组 |
| `verify_run_commands.py` | `commands` 字符串数组；宽容运行时接受的对象命令、`cmd` 别名不属于公开结构 |
| `verify_fetch_web_content.py` | `requests` 数组；每项含字符串 `url` 和至少 2 字符的 `prompt` |
| `verify_editor.py` | 非空 `path`、字符串 `new_text`；可选字符串/null `old_text`、正整数/null `insert_line` |
| `verify_skills.py` | 非空 `skill`，可选字符串/null `args` |

所有观察到的调用都检查：assistant 角色、非空且本轮唯一的 id、`type=function`、公布和允许范围内的工具名、JSON **字符串** arguments、参数对象与 Schema。严格 JSON 不接受重复键、NaN/Infinity 或非有限数；不把字符串数字转成数字，不把 bool 当整数。按照 Schema 的 `additionalProperties` 处理额外字段，不自行增加路径存在、URL 可访问、正则可执行或非空数组等业务条件。

Schema 来自 SDK 公布的输入结构，区别于 SDK 执行时的宽容解析；例如 `read_files` 的 `file_path` 别名、字符串行号，会被判为不符合公开格式。它们可能被 SDK 实际执行，但本评测关注模型是否遵循公布的标准。

只验证格式和结构，不验证模型选择是否符合业务意图、路径/命令/技能是否正确或工具真实执行成功。单工具示例限制目标名称和调用数；需要内容级断言时可在脚本中另加业务逻辑。

## 参数和输入

规则 `params` 可填写：

```json
{"expected_count":1,"expected_total_calls":1,"allowed_tools":["read_files"]}
```

允许目标工具调用一次或多次时，使用新版脚本并填写：

```json
{"min_count":1,"allowed_tools":["editor"]}
```

| 参数 | 含义 |
| --- | --- |
| `expected_count` | 精确目标调用数；未设置范围参数时默认 1，兼容旧案例 |
| `min_count` | 至少调用多少次；设置范围参数后默认 1 |
| `max_count` | 可选目标次数上限，不填则不额外限制次数 |
| `expected_total_calls` | 可选的本轮全部调用精确数量；允许不确定次数时不要填写 |
| `allowed_tools` | 允许返回的工具名称，默认本轮公布的工具；只允许 editor 时填 `["editor"]` |

`expected_count` 不能与 `min_count`/`max_count` 同时设置；次数须为正整数，不能填 bool、字符串或 null，上限不得小于下限，总数不能小于目标下限。仅允许目标工具时，总数也不能超过目标上限。参数冲突显示为验证配置错误，不自动忽略。

例如 `{"min_count":1,"max_count":5,"allowed_tools":["editor"]}` 接受 1–5 次 editor。每条调用都须格式有效，第一条正确但后续参数错误仍失败。检查明细的大值会标注截断，完整值保留在固定原始输入中。验证器最多处理 15 项调用，超过上限报告证据不足；不填写 max_count 不代表无限处理。

## 指定一个工具，允许调用多次

在“输入 → 本轮公布哪些工具”仅勾选 editor，将调用选择方式设为“必须调用任意所选工具”（required）。也可选择“强制调用 editor”，对应标准的指定函数 tool_choice；网关需支持，具体函数强制模式能否返回多个调用取决于模型服务。提示词写清任务，例如“用 editor 修改 a.txt 和 b.txt，允许在本次响应中返回多条 editor 调用”。希望评测模型是否遵从提示词选工具时，可用 auto，由脚本检查实际名称。

单轮表示只请求模型一次；一次响应的 tool_calls 数组可以有多项。不执行工具，不将结果发回模型继续下一轮。Python 检查本轮响应，不会把历史工具调用计入次数。

两个可导入案例（无历史＋有历史）使用新模板：

```bash
python3 examples/function-calls/prepare.py \
  --url http://127.0.0.1:3130 \
  --template examples/importable/function-call-editor-flexible.json \
  --output function-call-editor-flexible-bound.json
```

Windows 可以使用 `python`，从 agent-eval 根目录执行。导入生成的 bound.json 后配置模型再运行，原模板中的脚本 ID 是占位。

**已上传的旧脚本不会自动更新。** 请重新上传仓库新版 verify_editor.py（其他工具同理），并在案例选择新脚本后填写 min_count；也可重新运行 prepare.py 生成绑定新 ID 的案例文件。已提交运行仍使用原源码快照，不会追溯改变结论。

原始证据在 `ctx["diagnostics"]["function_call_response"]`：版本 `schema_version=1`、协议、完整性、`request_tools`、`tool_choice`、`raw_response`、HTTP 状态。它固定在本轮执行的证据与 Python 输入里，历史试验证读取相同快照，不再次请求模型或改变原结论。推荐 `required_inputs=["execution","diagnostics"]`，不要要求工作区产物。

- **pass**：完整原始调用封装和参数全部正确，目标数量满足要求。
- **fail**：正常完整响应无目标调用、工具名/ID/类型/参数错误、非法 JSON。
- **insufficient**：无原始响应、原回放模式、输入不完整、模型截断/过滤、Schema 版本不一致。
- 验证器本身异常或参数配置错误，由平台显示为验证错误；HTTP、超时、取消和超限为执行错误，不能通过。

原始响应上限 512 KiB。只支持非流式 OpenAI-compatible Chat Completions；其他 providerId 会提前提示配置方式。原始响应中的敏感值仍遵循现有证据处理规则。

## 本地自测及维护

```bash
python3 examples/function-calls/verify_read_files.py \
  examples/function-calls/fixtures/read_files-pass.json
python3 examples/function-calls/verify_read_files.py \
  examples/function-calls/fixtures/read_files-fail.json
python3 examples/function-calls/test_verifiers.py
bun run scripts/generate-function-call-verifiers.ts --check
```

其他五个工具均有 `*-pass.json` / `*-fail.json`；`fixtures/missing.json` 展示证据不足。直接运行脚本输出判定 JSON，上传执行时平台调用 `verify(ctx)`。

SDK Schema 变更后，从源码仓库运行 `bun run scripts/generate-function-call-verifiers.ts` 刷新六个独立脚本和快照，再运行测试、重新上传并绑定。`manifest.json` 记录来源及 SHA-256；脚本内嵌 Schema，运行时不依赖相邻文件。生成器仅用于开发维护，读取 SDK 源码，发行包用户直接使用生成的 `.py` 文件。

已有 MongoDB 部署升级后，运行 `bun run mongo:prepare` 更新案例校验器以接受新增模式；SQLite 不需要结构迁移。验证脚本库仍沿用部署选择的存储方式。


## Windows：GBK 解码错误或上传返回 HTTP 400

文件均为 UTF-8。Windows Python 3.12 可能默认按 GBK 打开文本，旧版 test_verifiers.py 的 read_text() 会失败；修复版明确传入 encoding="utf-8"。旧版可从 agent-eval 根目录临时执行：

```powershell
python -X utf8 .\examples\function-calls\test_verifiers.py
```

上传 400 需看服务端响应内容，不能仅凭 HTTPError 堆栈断定原因。已知旧版服务端 validatePythonSource 使用 sys.stdin.read()，也可能按 GBK 解码 Bun 发来的 UTF-8 源码，导致语法检查拒绝上传；修复版从 sys.stdin.buffer 读取并使用 utf-8-sig 明确解码。更新服务端代码后需要重启 Web 服务，若运行编译产物还需先重新构建。

注意：服务端以 Python -I 隔离模式启动语法检查，单独设置 PYTHONUTF8 环境变量不能代替服务端修复。客户端使用 python -X utf8 也不会改变另一进程内的服务端检查行为。

修复后的 prepare.py 会显示失败文件名、HTTP 状态码及服务端错误正文；失败时不覆盖旧的绑定案例输出。重启服务后，从 agent-eval 根目录重试：

```powershell
python -X utf8 .\examples\function-calls\prepare.py --url http://127.0.0.1:3130 --output .\function-call-basic-bound.json
```

若仍报错，按新输出的具体 error 定位：Python 语法/入口错误检查脚本及服务端解释器；集合文档校验错误检查 MongoDB 合同是否已准备；HTML 正文或代理错误检查 URL 是否为 agent-eval Web 地址而非模型服务。更改端口时同步 --url。
