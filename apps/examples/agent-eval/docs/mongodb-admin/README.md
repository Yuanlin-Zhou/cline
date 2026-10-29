# MongoDB 原生命令

- 新库：[create-collections.txt](create-collections.txt)。
- 集合已存在：[update-collections.txt](update-collections.txt)。

文件是可直接粘贴到 MongoDB 控制台执行的完整命令：`use agent_eval` 加五条 `db.runCommand(...)`，不含变量、函数、循环或外部脚本依赖。请按顺序执行，每条确认成功后再继续。

默认数据库 `agent_eval`，集合 `agent_eval_cases`、`agent_eval_modules`、`agent_eval_verifiers`。若内网要求改名，同步修改命令和本地应用环境配置。

命令包含三个完整集合校验器与四个自定义索引；每集合的 `_id_` 索引由 MongoDB 自动创建。不能只创建索引而省略校验器，否则当前应用启动检查不会通过。

需要副本集或支持事务的分片集群。首次使用新建命令；已有集合使用更新命令，不同时执行两份。新旧集合混合时，针对每个集合选择对应 create/collMod 命令，再执行末尾两条 createIndexes。

更新命令不删除集合、索引或业务数据；已有同名异定义索引、活动名称重复等错误需 DBA 处理，不能当作成功忽略。命令不初始化默认模块或改账号权限。

本地运行账号需要三个集合的业务 CRUD 和启动检查所需 listCollections/listIndexes 权限；管理员完成准备后，本地直接启动 Web，不再运行 mongo:prepare。

合同基线：04f1343（2026-10-27），包括原生历史与 LLM Judge。已离线核对命令与当前源码校验器/索引一致；未在内网数据库执行。
