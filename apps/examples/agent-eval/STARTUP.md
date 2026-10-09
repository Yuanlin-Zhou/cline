# Agent Eval 启动与配置说明

本文适用于当前仓库源码版本，命令以 Bun 1.3.13 为准。除了安装依赖和构建 SDK，其余命令均在 `apps/examples/agent-eval` 目录执行。

已使用 MongoDB 的部署继续设置 `EVAL_CASE_STORAGE=mongodb`。首次启动本地评测器可选择 SQLite；两种模式是服务端配置，前端没有切换按钮。

## 1. 环境与首次准备

需要 Bun **1.3.13**、Node.js **22 或以上**。MongoDB 模式还需要可访问的副本集或分片集群；本地测试可使用 MongoDB 8.0。项目使用 MongoDB 驱动 **6.21.0**，不要未经 Bun 兼容性验证升级到 7.x。

在仓库根目录执行一次：

```sh
bun --version
node --version
bun install --filter '@cline/example-agent-eval' --ignore-scripts
bun run build:sdk
cd apps/examples/agent-eval
```

SDK 包通过编译后的 `dist/` 解析。首次运行必须构建 SDK；以后更新 SDK 源码或依赖时，也要重新构建并重启评测服务。只修改本项目时，无需每次重建 SDK。

## 2. 选择存储模式

| 数据 | `EVAL_CASE_STORAGE=sqlite`（默认） | `EVAL_CASE_STORAGE=mongodb` |
| --- | --- | --- |
| 案例、模块 | 本地 `eval.sqlite` | MongoDB 案例、模块集合 |
| 用户上传的验证脚本库 | 本地 `eval.sqlite` | MongoDB 验证脚本集合 |
| 全局模型设置 | 本地 `eval.sqlite` | 本地 `eval.sqlite` |
| 评测批次、运行快照、结果和历史 | 本地 `eval.sqlite` | 本地 `eval.sqlite` |
| 工作区、证据、验证日志、SDK 会话文件 | 本地运行目录 | 本地运行目录 |

MongoDB 模式仍需配置并保留 `EVAL_DATA_DIR`。改变这个目录会让服务读取另一份本地设置和历史。MongoDB 断连不会自动回退到 SQLite；改变模式也不会自动复制数据。不要用切换模式处理数据库故障。

### 2.1 SQLite：直接启动

Windows PowerShell：

```powershell
$env:EVAL_CASE_STORAGE = 'sqlite'
$env:EVAL_DATA_DIR = 'D:\agent-eval-data'
$env:EVAL_PORT = '3130'
# 如果使用默认 cline Provider，设置其凭据；其他 Provider 见第 5 节。
$env:CLINE_API_KEY = '替换为实际密钥'
bun run web
```

Linux / macOS：

```sh
export EVAL_CASE_STORAGE=sqlite
export EVAL_DATA_DIR="$PWD/.eval-data"
export EVAL_PORT=3130
export CLINE_API_KEY='替换为实际密钥'
bun run web
```

数据目录由程序自动创建，运行账号必须有读写权限。新目录会初始化默认模型设置及四个模块。没有模型凭据也可以打开页面、整理案例；执行真实模型请求前必须配置有效凭据。

### 2.2 MongoDB：配置、准备，再启动

下面假设已有本机副本集 `rs0`。若已有内网 MongoDB，替换 URI、数据库名及集合名，并确保副本集公布的节点地址也能从评测机器访问。

Windows PowerShell：

```powershell
$env:EVAL_CASE_STORAGE = 'mongodb'
$env:EVAL_MONGODB_URI = 'mongodb://127.0.0.1:27017/?replicaSet=rs0'
$env:EVAL_MONGODB_DATABASE = 'agent_eval'
$env:EVAL_MONGODB_CASE_COLLECTION = 'agent_eval_cases'
$env:EVAL_MONGODB_MODULE_COLLECTION = 'agent_eval_modules'
$env:EVAL_MONGODB_VERIFIER_COLLECTION = 'agent_eval_verifiers'
$env:EVAL_DATA_DIR = 'D:\agent-eval-data'
$env:EVAL_PORT = '3130'

# 首次部署或集合合同升级时执行；已有数据不要添加 --seed-modules。
bun run mongo:prepare
bun run web
```

Linux / macOS：

```sh
export EVAL_CASE_STORAGE=mongodb
export EVAL_MONGODB_URI='mongodb://127.0.0.1:27017/?replicaSet=rs0'
export EVAL_MONGODB_DATABASE=agent_eval
export EVAL_MONGODB_CASE_COLLECTION=agent_eval_cases
export EVAL_MONGODB_MODULE_COLLECTION=agent_eval_modules
export EVAL_MONGODB_VERIFIER_COLLECTION=agent_eval_verifiers
export EVAL_DATA_DIR="$PWD/.eval-data"
export EVAL_PORT=3130

bun run mongo:prepare
bun run web
```

`mongo:prepare` 创建或更新集合校验器、索引，不迁移案例、不改写已有文档。首次部署全新的空案例库，想初始化四个默认模块时，使用 `bun run mongo:prepare --seed-modules`；如果准备从 SQLite 迁移，**不要先初始化模块**，以免名称和 UUID 冲突。

准备账号需要建集合、修改校验器和建索引权限；日常应用账号需要案例/模块的读写、事务和合同检查权限，以及验证脚本集合的读写和合同检查权限。可以在准备完成后换成应用账号的 URI 再启动。凭据只在服务端配置，不写入案例或提交到仓库。

以后正常启动只需加载同样的环境配置并执行 `bun run web`。上传验证脚本不需要再次准备数据库、管理员注册或重启服务。

### 2.3 没有 MongoDB 时的本地测试副本集

以下 Docker 命令仅用于本机开发测试；没有启用数据库认证，端口只映射到本机。已有 MongoDB 的部署跳过本节。Docker 数据卷保留数据库内容。

```sh
docker volume create agent-eval-mongo-data
docker run -d --name agent-eval-mongo -p 127.0.0.1:27017:27017 --mount type=volume,src=agent-eval-mongo-data,dst=/data/db mongo:8.0 --replSet rs0 --bind_ip_all
docker exec agent-eval-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
docker exec agent-eval-mongo mongosh --quiet --eval 'db.hello().isWritablePrimary'
```

最后一条命令应返回 `true`；若仍在选举，稍后重试检查。之后按第 2.2 节准备集合并启动。已有容器再次启动使用 `docker start agent-eval-mongo`，不要重复创建或重新初始化副本集。

## 3. 访问、停止与再次启动

默认浏览器地址：**http://127.0.0.1:3130**。修改 `EVAL_PORT` 后使用相应端口。

当前服务固定监听 `127.0.0.1`，只接受本机访问，并检查同源请求。没有 `EVAL_HOST` 配置；把端口改为其他值不会开放内网访问。本文不提供尚未实现的远程托管配置。

在启动终端按 `Ctrl+C` 停止。正常停止会取消排队/运行中的批次并关闭数据库连接。异常退出后，再次启动会把遗留运行标记为中断；不会自动续跑，可从历史快照创建重跑批次。

新终端需要重新设置环境变量，或通过自己的启动脚本、服务配置加载。更改端口、存储模式、MongoDB 连接、本地数据目录或服务进程中的模型凭据后，需要重启服务才能应用新的进程配置。页面中的模型设置保存后用于后续操作；已保存案例和已提交的运行快照不会被追溯修改。

## 4. 服务端环境变量速查

| 变量 | 默认值 / 必需条件 | 用途 |
| --- | --- | --- |
| `EVAL_CASE_STORAGE` | `sqlite` | `sqlite` 或 `mongodb`；控制案例、模块及上传脚本库后端 |
| `EVAL_DATA_DIR` | 源码 Web 默认是仓库的 `apps/examples/.eval-data` | 本地 SQLite 与运行文件目录；建议显式设置绝对路径 |
| `EVAL_PORT` | `3130` | Web 本机监听端口 |
| `EVAL_MONGODB_URI` | MongoDB 模式必填 | MongoDB 连接字符串，含认证、副本集等连接选项 |
| `EVAL_MONGODB_DATABASE` | `agent_eval` | MongoDB 数据库名 |
| `EVAL_MONGODB_CASE_COLLECTION` | `agent_eval_cases` | 案例集合 |
| `EVAL_MONGODB_MODULE_COLLECTION` | `agent_eval_modules` | 模块集合 |
| `EVAL_MONGODB_VERIFIER_COLLECTION` | `agent_eval_verifiers` | 上传脚本集合；三个集合名称必须不同 |
| `EVAL_VERIFIERS_FILE` | 未设置时无配置注册的验证器 | 可选验证器 JSON 注册文件；与用户上传的脚本合并使用 |
| `CLINE_API_KEY` 或自定义密钥变量 | 使用相关模型时需要 | 实际模型凭据；自定义名称需在 `apiKeyEnv` 中引用 |
| `EVAL_AUTHORIZATION` 等自定义变量 | 被 `headersEnv` 引用时需要 | 网关请求头完整值，例如 `Bearer ...`；名称可自行选择 |

源码 Web 的默认数据目录由 `src/web/server.ts` 的相对位置计算，并不是当前终端目录。CLI 启用任务判分时默认使用案例集 JSON 所在目录下的 `.eval-data`；显式设置 `EVAL_DATA_DIR` 可以让 CLI 与 Web 使用同一目录。

以下是测试配置，不是日常启动必填项：`EVAL_TEST_MONGODB_URI` 用于独立测试副本集；`EVAL_PROCESS_TREE_TEST=1` 用于 Windows 进程树专项测试。`EVAL_CONTEXT` 由评测器生成并传给验证脚本，用户无需配置。

## 5. 模型、网关与凭据

模型配置在 Web 全局配置、案例配置或 CLI 案例集 `defaults` 中填写；数据库连接环境变量不会替你选择模型。

| 字段 | 含义 | 默认值 / 示例 |
| --- | --- | --- |
| `providerId` | 模型供应商 | 默认 `cline`；兼容网关用 `openai-compatible` |
| `modelId` | 供应商支持的模型 ID | 默认 `anthropic/claude-sonnet-4.6`；网关填写其真实模型 ID |
| `apiKeyEnv` | 凭据环境变量名称，不是密钥本身 | 例如 `MODEL_API_KEY` |
| `baseUrl` | 兼容网关地址 | 例如 `https://gateway.example.com/v1`，替换为实际地址 |
| `headers` | 非敏感固定请求头 | 例如 `x-session-id: {{sessionId}}` |
| `headersEnv` | 请求头值的环境变量引用 | 例如 `Authorization: EVAL_AUTHORIZATION` |
| `tools` | 工具范围 | 默认 `read-only`；可选 `none` / `read-only` / `full` |
| `maxIterations` | 迭代上限 | 默认 `10` |
| `timeoutMs` | 单次任务超时，毫秒 | 默认 `300000`（5 分钟） |
| `cwd` | 完整任务的初始 fixture 路径 | Web 填服务端绝对路径；不填时使用空工作区 |

以 OpenAI 兼容网关为例，启动服务前设置：

```powershell
$env:MODEL_API_KEY = '替换为实际密钥'
# 如果网关另需自定义 Authorization，请设置完整头值。
$env:EVAL_AUTHORIZATION = 'Bearer 替换为实际令牌'
bun run web
```

Linux / macOS 对应使用 `export MODEL_API_KEY='...'`、`export EVAL_AUTHORIZATION='Bearer ...'`。随后在全局配置中填写 `providerId=openai-compatible`、实际 `modelId`、实际 `baseUrl`、`apiKeyEnv=MODEL_API_KEY`；如果需要显式覆盖认证头，再设置 `headersEnv.Authorization=EVAL_AUTHORIZATION`。

不要把实际密钥填到 `apiKeyEnv` 或 `headersEnv` 字段，这些字段只存变量名称。`headers.Authorization` 等凭据固定值会被拒绝，必须使用 `headersEnv`。OpenAI 兼容网关支持自定义 `Authorization` 覆盖 API Key 认证头，其他 Provider 遵循各自 SDK 的认证行为。

全局设置不会自动覆盖旧案例。需要在案例配置中更新，或在新建评测的运行配置中覆盖，并检查运行确认页的最终生效配置。单轮回放固定禁用工具、最多一次响应；文件产物验收和验证脚本使用完整任务模式。

## 6. 验证脚本配置

日常用户入口：**案例详情 → 判定规则 → 启用验收 → 使用验证脚本 → 上传验证脚本**。

支持 UTF-8 `.js`、`.mjs`、`.ts` 单文件，最大 1 MiB。上传后自动选中，保存案例即可运行；不需要填写服务端执行命令、不需要管理员修改注册表。上传只保存代码，在任务结束后的验证阶段才执行。运行提交时固定源码及摘要；同名再次上传创建新 ID，不替换旧案例引用。

前端提供结果字段指南及两份模板下载。详细说明见 [docs/uploaded-verifiers.md](docs/uploaded-verifiers.md)。脚本默认超时 60 秒，案例验证总超时 180 秒。脚本会在评测器所在机器执行，独立工作区副本不是 OS 沙箱。

需要保留原有管理员预置命令/脚本时，可选设置：

```powershell
$env:EVAL_VERIFIERS_FILE = (Resolve-Path examples/grading/verifiers.json).Path
bun run web
```

Linux / macOS：`export EVAL_VERIFIERS_FILE="$PWD/examples/grading/verifiers.json"`。后续更新注册文件时，Web 列表和新执行会重新读取，无需重启。保持注册文件及其依赖位于 Agent fixture 之外。

## 7. CLI 执行

CLI 读取 JSON 案例集，不会因为设置 MongoDB 模式就自动运行库中所有案例。源码入口：

```sh
bun run eval --help
bun run eval examples/basic.json --output results/basic.json
bun run eval examples/custom-headers.json --output results/gateway.json
```

先根据实际服务填写案例集的 Provider、模型和网关配置，并设置所需凭据。`--provider`、`--model`、`--api-key-env`、`--cwd`、`--tools` 可覆盖配置；`--stream` 将实时文字写入 stderr。JSON 报告写到 stdout，指定 `--output` 时另外保存一份文件。

案例 JSON 的相对 `cwd` 从案例文件目录解析；CLI `--cwd` 从终端当前目录解析。完整任务初始目录和运行数据目录不能互相包含，建议使用独立 fixture。Web 同样要求这两个目录分开。

CLI 引用 Web 上传的 `uploaded-...` 验证器 ID 时，需要使用同样的存储模式、MongoDB 配置，或 SQLite 的同一 `EVAL_DATA_DIR`。普通 JSON 案例或配置注册的验证器无需 MongoDB。`tools=full` 可自动执行命令及修改文件，应使用可信的测试工作区。

## 8. 从已有 SQLite 案例迁到 MongoDB

这是显式迁移操作，不属于普通启动。先停止评测服务和其他案例写入者，备份一致的 SQLite 数据库及运行目录；准备空 MongoDB 案例库，勿使用 `--seed-modules`。

在第 2.2 节的 MongoDB 环境配置下：

```sh
bun run mongo:prepare
bun run mongo:migrate --sqlite /absolute/path/eval.sqlite
# 检查预览无冲突后才执行下面的应用步骤。
bun run mongo:migrate --sqlite /absolute/path/eval.sqlite --apply
bun run web
```

替换 SQLite 文件路径；Windows 可用 `D:\agent-eval-data\eval.sqlite`。迁移保留案例/模块 UUID 和版本，不覆盖冲突记录；**仅迁移案例与模块**，不迁移设置、批次、运行结果或用户上传的验证脚本库。已有上传脚本的案例还需单独处理脚本和引用，不能假定迁移完成后原 `uploaded-...` ID 在新库中可用。

启动时保留原来的 `EVAL_DATA_DIR`，才能继续访问旧设置和历史。详细文档见 [docs/mongodb.md](docs/mongodb.md)。

## 9. 检查与故障排查

| 现象 | 检查方式 |
| --- | --- |
| 找不到 `@cline/*` 或 SDK `dist` | 回仓库根目录安装依赖并执行 `bun run build:sdk` |
| `EVAL_CASE_STORAGE` 无效 | 只能设置为 `sqlite` 或 `mongodb` |
| MongoDB 模式缺少 URI | 给启动服务的进程设置 `EVAL_MONGODB_URI` |
| 独立 `mongod` 无法启动应用 | 使用副本集或分片集群，等待主节点可写 |
| 集合/索引/校验器未准备或不符 | 使用准备账号执行 `bun run mongo:prepare`；脚本集合也必须准备 |
| MongoDB 不可用 / 503 | 检查连接、节点公布的地址和权限；不切换到旧 SQLite 数据规避错误 |
| 页面无原有案例 | 核对模式、数据库及集合名；模式变化不会迁移数据 |
| 设置、历史突然变空 | 核对 `EVAL_DATA_DIR` 是否指向原目录 |
| 模型文本预览长时间不变 | 查看执行阶段、最近活动和页面同步状态；没有新文本不代表执行停止 |
| 页面提示同步失败 | 检查服务是否可达；页面会保留已有内容并自动重试 |
| 会话记录缺失或正在写入 | 在详情“会话记录”中重试；记录位于本次运行目录 `session/sessions/<sessionId>/<sessionId>.messages.json`，SDK 保存上下文后才可见 |
| 缺少密钥变量 / 认证失败 | 核对 `apiKeyEnv`、`headersEnv` 和服务进程环境，而不是浏览器本机环境 |
| 端口占用 | 停止占用进程，或设置其他 `EVAL_PORT` 后重启 |
| 其他机器打不开页面 | 当前版本仅监听本机，改变端口不会开放远程访问 |
| 产物验收提示模式不符 | 切换案例为完整任务模式，填写正确的 fixture 和验收规则 |
| 验证脚本错误 | 检查 stdout 单个 JSON 协议、异常日志及超时；退出 0 不等于验收通过 |

开发验证：

```sh
bun run typecheck
bun test
bun run smoke:web
```

MongoDB 集成测试需单独设置 `EVAL_TEST_MONGODB_URI` 并执行 `bun run test:mongo`。测试会创建和删除随机数据库，并使用测试 failpoint；仅指向专用测试副本集，不用生产库。未配置时相关测试跳过。Web smoke 使用本机模拟模型，无需真实模型凭据。

## 10. 源码启动与发布包的区别

本说明的 Web/MongoDB 准备流程针对仓库源码。`bun run package` 生成的现有发布包主要提供 CLI，**不是完整 Web 服务或 Windows 单文件 EXE**；不能把源码中的 `bun run web`、`mongo:prepare` 命令直接套到该包。发布包安装和运行见 [README.release.md](README.release.md)。

更多案例与配置示例见 [examples/README.md](examples/README.md)；上传脚本协议见 [docs/uploaded-verifiers.md](docs/uploaded-verifiers.md)；MongoDB 文档合同与迁移细节见 [docs/mongodb.md](docs/mongodb.md)。
