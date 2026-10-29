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

SPEC-030（2026-10-29）：取消自定义索引依赖，保留原生历史与 LLM Judge 的集合校验器。已有集合需要更新字段规则时仍由管理员执行 collMod，本地应用账号不需要此权限。

应用对普通同名操作执行活动名称冲突检查；无数据库 unique 索引后，多实例/外部并发写入不能保证名称唯一，归档名称仍允许重用。事务操作仍要求副本集或支持事务的分片集群；启动只检查集合，不提前验证拓扑。

这些命令仅作为 DBA 执行材料，不会由服务启动自动执行。
