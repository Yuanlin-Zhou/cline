# MongoDB 原生命令

- 新库：[create-collections.txt](create-collections.txt)。
- 集合已存在：[update-collections.txt](update-collections.txt)。
- **清空后重建**：[rebuild-collections.txt](rebuild-collections.txt)。此命令永久删除三个集合的所有数据和索引，请先停写并备份；不删除整个数据库。

文件是可直接粘贴到 MongoDB Shell（mongosh）控制台执行的完整命令，不含变量、函数、循环或外部脚本依赖。新建/更新各包含 `use agent_eval` 加三条 `db.runCommand(...)`；清空重建在创建前增加三条 `drop()`，集合不存在时返回 false，可继续创建。删除集合会同时删除已有索引；重建命令不创建任何自定义索引。请按顺序执行，每条确认成功后再继续。

默认数据库 `agent_eval`，集合 `agent_eval_cases`、`agent_eval_modules`、`agent_eval_verifiers`。若内网要求改名，同步修改命令和本地应用环境配置。

命令只创建/修改三个集合及完整字段校验器，不含任何 createIndexes 或 dropIndexes 操作。普通集合的 `_id_` 索引由 MongoDB 自动创建，不需要单独申请建索引权限。应用启动只检查三个集合存在，不检查索引或校验器；也可使用 DBA 已创建且没有校验器的普通集合，应用自身仍校验业务数据。

需要副本集或支持事务的分片集群。首次使用新建命令；已有集合使用更新命令，不同时执行两份。新旧集合混合时，针对每个集合选择对应 create/collMod 命令，不执行任何自定义索引命令。

更新命令不删除集合、索引或业务数据；已有自定义索引保持原样，系统不创建、不检查，也不自动删除；管理员执行命令出错时请先处理错误再继续。命令不初始化默认模块或改账号权限。

本地运行账号需要三个集合的业务 CRUD 和启动检查所需 listCollections 权限；管理员完成准备后，本地直接启动 Web，不再运行 mongo:prepare。

## 修改命令的权限与导入排查

`update-collections.txt` 的三条命令均仅设置 `collMod`、`validator`、`validationLevel: "strict"` 和 `validationAction: "error"`，所需的 MongoDB 权限类型完全相同：目标集合上的 `collMod` action。校验器中字段多少、正则表达式或数值规则不会增加权限要求；三条命令均不需要建索引、删除集合或绕过文档校验的权限。

授权资源分别为 `{ db: "agent_eval", collection: "agent_eval_cases" }`、`{ db: "agent_eval", collection: "agent_eval_modules" }` 和 `{ db: "agent_eval", collection: "agent_eval_verifiers" }`。若数据库或集合改名，应使用实际名称。仅有 cases 的集合级授权不代表可以修改另两个集合；内网审批平台也可能单独限制目标集合。请由 DBA 将 modules 和 verifiers 的 `collMod` 授权范围或审批范围与 cases 对齐，而不是给本地应用增加 DDL 权限。

MongoDB `code: 13 / Unauthorized` 是权限拒绝；`code: 121 / DocumentValidationFailure` 是写入文档未通过已有集合校验，属于不同问题。请保留命令返回的完整错误以区分；内网平台提示不一定等同于原生 MongoDB 错误。

案例导入在事务内先更新目标模块的 `writeVersion`，再写入案例，因此 cases 的规则已更新并不能排除 modules 的旧规则导致导入失败。普通案例导入不写入 verifiers。当前应用将校验失败统一显示为“MongoDB 文档校验失败”，仅凭这一提示不能确认失败集合或字段。不要删除模块的协调写入，也不要使用 `bypassDocumentValidation` 绕过校验来规避问题。

可由具备 `listCollections` 权限的账号在 mongosh 查看实际安装的规则（不读取案例正文，不修改数据）：

```javascript
use agent_eval
db.runCommand({
  listCollections: 1,
  filter: { name: { $in: ["agent_eval_cases", "agent_eval_modules", "agent_eval_verifiers"] } },
  nameOnly: false
});
```

检查返回结果中每个集合的 `options.validator`、`options.validationLevel` 和 `options.validationAction`。若返回游标未包含全部集合，应继续读取游标。modules 的当前 `writeVersion` 规则允许 `int`、`long`、`double`，同时要求为大于等于 1 的整数；若旧规则不同，应由 DBA 执行对应的完整更新命令。规则不匹配只是待核实的原因，不能代替失败写入的校验详情。

SPEC-030（2026-10-29）：取消自定义索引依赖，保留原生历史与 LLM Judge 的集合校验器。已有集合需要更新字段规则时仍由管理员执行 collMod，本地应用账号不需要此权限。

应用对普通同名操作执行活动名称冲突检查；无数据库 unique 索引后，多实例/外部并发写入不能保证名称唯一，归档名称仍允许重用。事务操作仍要求副本集或支持事务的分片集群；启动只检查集合，不提前验证拓扑。

这些命令仅作为 DBA 执行材料，不会由服务启动自动执行。

SPEC-031：cases 校验器增加可选 `definition.badCase`（原始错误输出/格式/原因）和 `definition.importSource`（平台/任务/轮次/来源链接），旧记录无需回填。modules/verifiers 校验规则不变；已有库只需执行 update 文件中 cases 的对应命令，无需删除重建。先升级应用再接入 [Python 导入示例](../../examples/python-mongodb-import/README.md)，旧版本编辑可能丢失新字段。MongoDB JSON Schema 的 maxLength 按字符计数，应用与 Python 对错误输出额外执行 UTF-8 字节上限和 JSON 格式校验，外部写入端必须遵守接入合同。
