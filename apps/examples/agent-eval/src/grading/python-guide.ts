export const pythonFields = [
	["execution", "status/text/finish_reason/error/duration_ms/iterations/usage：本次模型执行结果，不含验证结论。"],
	["conversation", "status/completeness/issues/messages：主会话上下文。messages 包含 role 和 blocks；工具参数 input、结果 output 保留JSON类型。"],
	["artifacts / baseline", "status/files：归档文件清单；path/size/sha256，产物含 change；单轮回放为 not_applicable。"],
	["paths", "artifacts/baseline/scratch/context/diagnostics：验证副本和临时目录，用 pathlib 读取文件。"],
	["diagnostics", "tool_calls/capabilities/events_ref：工具诊断，事件JSONL副本见 paths.diagnostics；不证明实际工具执行或审批。"],
	["case / run / params", "固定的任务和历史输入、会话与重复轮次标识，以及当前规则填写的JSON参数。"],
] as const;
export const pythonReplyTemplate = `def verify(ctx):
    keyword = ctx["params"].get("contains", "已完成")
    text = ctx["execution"]["text"]
    passed = ctx["execution"]["status"] == "completed" and keyword in text
    print("最终回复字符数:", len(text))
    return {
        "verdict": "pass" if passed else "fail",
        "message": "最终回复满足要求" if passed else "执行未完成或回复内容不符",
        "checks": [{"id": "reply", "status": "pass" if passed else "fail",
                    "message": "最终回复包含指定内容", "expected": keyword, "actual": text}]
    }
`;
export const pythonArtifactTemplate = `from pathlib import Path

def verify(ctx):
    if ctx["artifacts"]["status"] != "ready":
        return {"verdict": "insufficient", "message": "产物缺失或归档不完整，请用完整任务模式"}
    root = Path(ctx["paths"]["artifacts"])
    keyword = ctx["params"].get("contains", "hello world")
    files = [f["path"] for f in ctx["artifacts"]["files"] if f["path"].lower().endswith(".txt")]
    checks = [{"id": "files", "status": "pass" if files else "fail",
               "message": "至少有一个txt文件", "actual": files}]
    for index, name in enumerate(files):
        text = (root / name).read_text(encoding="utf-8")
        passed = keyword in text
        checks.append({"id": "txt_" + str(index), "status": "pass" if passed else "fail",
                       "message": name + " 包含指定内容", "expected": keyword,
                       "actual": text, "files": [name]})
    passed = all(c["status"] == "pass" for c in checks)
    print("检查了", len(files), "个txt文件")
    return {"verdict": "pass" if passed else "fail", "message": "文件检查完成", "checks": checks}
`;
export const pythonConversationTemplate = `def verify(ctx):
    conversation = ctx["conversation"]
    if conversation["status"] != "ready":
        return {"verdict": "insufficient", "message": "缺少会话记录"}
    keyword = ctx["params"].get("contains", "已完成")
    texts = [b.get("text", "") for m in conversation["messages"] if m["role"] == "assistant"
             for b in m["blocks"] if b["type"] == "text"]
    passed = any(keyword in text for text in texts)
    return {"verdict": "pass" if passed else "fail", "message": "检查已保存的模型回复",
            "checks": [{"id": "conversation", "status": "pass" if passed else "fail",
                        "message": "会话中的模型文本包含指定内容", "expected": keyword, "actual": texts}]}
`;
