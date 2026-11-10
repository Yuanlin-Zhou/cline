# Agent Eval 已迁移

正式应用位于 [`apps/agent-eval`](../../agent-eval/README.md)。原目录命令通过兼容包转发，业务实现只保留一份。

原 `.eval-data` 与用户文件不自动迁移。生产部署建议明确配置 `EVAL_DATA_DIR`。

Python 示例请使用 `apps/agent-eval/examples/python-mongodb-import`，接口与文档合同不变。
