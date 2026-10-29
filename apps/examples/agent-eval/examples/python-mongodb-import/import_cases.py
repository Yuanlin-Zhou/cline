"""Agent 日志平台接入：只写现有案例/模块，不执行 DDL 或评测。Python >=3.10。"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

from bson import BSON
from pymongo import MongoClient, ReadPreference
from pymongo.errors import PyMongoError
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

NAMESPACE = uuid.UUID("5542c067-e6a7-52a3-af06-cc65f944e6e4")
TOOLS = {"read_files", "search_codebase", "run_commands", "fetch_web_content", "editor", "skills"}


class ImportFailure(Exception):
    def __init__(self, status, message, **details):
        super().__init__(message)
        self.result = {"status": status, "message": message, **details}


def obj(value, path, allowed=None):
    if not isinstance(value, dict):
        raise ValueError(f"{path} 必须为对象")
    if allowed is not None and set(value) - set(allowed):
        raise ValueError(f"{path} 包含不支持的字段")
    return value


def text(value, path, limit=None, *, byte_limit=False, empty=False):
    if not isinstance(value, str) or (not empty and not value.strip()):
        raise ValueError(f"{path} 必须为{'文本' if empty else '非空文本'}")
    if limit is not None and (len(value.encode("utf-8")) if byte_limit else len(value)) > limit:
        raise ValueError(f"{path} 超过长度限制 {limit}")
    return value


def strict_json(value):
    def pairs(items):
        result = {}
        for key, entry in items:
            if key in result:
                raise ValueError("JSON 存在重复键")
            result[key] = entry
        return result
    def invalid(_):
        raise ValueError("JSON 不允许 NaN/Infinity")
    result = json.loads(value, object_pairs_hook=pairs, parse_constant=invalid)
    def finite(v, depth=0):
        if depth > 64 or isinstance(v, float) and not math.isfinite(v):
            raise ValueError("JSON 嵌套过深或包含非有限数字")
        if isinstance(v, dict):
            for x in v.values():
                finite(x, depth + 1)
        elif isinstance(v, list):
            for x in v:
                finite(x, depth + 1)
    finite(result)
    return result


def source_config(value):
    v = obj(value, "source", ["platform", "taskId", "turnId", "url"])
    result = {key: text(v.get(key), f"source.{key}", 256) for key in ("platform", "taskId", "turnId")}
    if "url" in v:
        url = text(v["url"], "source.url", 2048)
        parsed = urlparse(url)
        if not re.match(r"^https?://", url, re.I) or parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("source.url 必须为 http/https 地址")
        result["url"] = url
    return result


def bad_config(value):
    v = obj(value, "badCase", ["observedOutput", "outputFormat", "reason"])
    result = {"observedOutput": text(v.get("observedOutput"), "badCase.observedOutput", 1048576, byte_limit=True), "outputFormat": v.get("outputFormat", "text")}
    if result["outputFormat"] not in ("text", "json"):
        raise ValueError("badCase.outputFormat 必须为 text/json")
    if result["outputFormat"] == "json":
        strict_json(result["observedOutput"])
    if "reason" in v:
        result["reason"] = text(v["reason"], "badCase.reason", 16384, byte_limit=True)
    return result


def defaults_config(value):
    # 单轮接入只开放这些配置；不接受工作区/多轮参数或任意未知字段。
    v = obj(value, "defaults", ["providerId", "modelId", "baseUrl", "apiKeyEnv", "systemPrompt", "timeoutMs", "headers", "headersEnv"])
    result = {k: text(v.get(k), f"defaults.{k}") for k in ("providerId", "modelId")}
    for k in ("baseUrl", "apiKeyEnv", "systemPrompt"):
        if k in v:
            result[k] = text(v[k], f"defaults.{k}")
    timeout = v.get("timeoutMs", 300000)
    if type(timeout) is not int or not 0 < timeout <= 9007199254740991:
        raise ValueError("defaults.timeoutMs 必须为安全正整数")
    result.update(timeoutMs=timeout, maxIterations=10, tools="read-only")
    seen = set()
    managed = {"host", "content-length", "connection", "transfer-encoding", "content-type", "trailer", "upgrade", "keep-alive", "te"}
    for field in ("headers", "headersEnv"):
        if field not in v:
            continue
        result[field] = {}
        for name, entry in obj(v[field], f"defaults.{field}").items():
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or name.lower() in managed or name.lower() in seen:
                raise ValueError("请求头名称非法、重复或由系统管理")
            name = name.lower()
            seen.add(name)
            text(entry, "header", empty=True)
            if field == "headersEnv":
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", entry):
                    raise ValueError("headersEnv 必须保存环境变量名")
            else:
                if name in {"authorization", "proxy-authorization", "x-api-key", "api-key"}:
                    raise ValueError("凭据请求头必须通过 headersEnv 引用")
                remaining = re.sub(r"\{\{(sessionId|caseId|evaluationId|requestId)\}\}", "", entry)
                if any(c in entry for c in "\r\n\0") or "{{" in remaining or "}}" in remaining:
                    raise ValueError("请求头值或模板非法")
                entry.encode("latin-1")  # 与 Web Headers 可接受的字节文本保持一致。
            result[field][name] = entry
    return result


def native_history(messages):
    if not isinstance(messages, list) or len(messages) > 500:
        raise ValueError("functionCall.history 必须为不超过 500 条的数组")
    if len(json.dumps(messages, ensure_ascii=False).encode()) > 1048576:
        raise ValueError("functionCall.history 超过 1 MiB")
    pending, used = set(), set()
    instructions = True
    for index, raw in enumerate(messages):
        p = f"functionCall.history[{index}]"
        m = obj(raw, p, ["role", "content", "name", "tool_calls", "tool_call_id"])
        role = m.get("role")
        if role not in ("system", "developer", "user", "assistant", "tool"):
            raise ValueError(f"{p}.role 不支持")
        if role in ("system", "developer") and not instructions:
            raise ValueError(f"{p} 系统消息必须在历史前部")
        if role not in ("system", "developer"):
            instructions = False
        if pending and role != "tool":
            raise ValueError(f"{p} 缺少工具结果")
        if "name" in m:
            text(m["name"], f"{p}.name")
        if "content" in m and not (role == "assistant" and m["content"] is None):
            text(m["content"], f"{p}.content", empty=True)
        if role == "tool":
            text(m.get("content"), f"{p}.content", empty=True)
            call_id = text(m.get("tool_call_id"), f"{p}.tool_call_id")
            if "tool_calls" in m or call_id not in pending:
                raise ValueError(f"{p} 工具结果无对应调用或重复")
            pending.remove(call_id)
            continue
        if "tool_call_id" in m:
            raise ValueError(f"{p}.tool_call_id 仅允许工具结果使用")
        if "tool_calls" in m:
            calls = m["tool_calls"]
            if role != "assistant" or not isinstance(calls, list) or not calls:
                raise ValueError(f"{p}.tool_calls 必须为 assistant 的非空数组")
            for call in calls:
                obj(call, "tool_call", ["id", "type", "function"])
                call_id = text(call.get("id"), "tool_call.id")
                if call_id in used or call.get("type") != "function":
                    raise ValueError("工具调用 ID 重复或 type 非 function")
                used.add(call_id)
                pending.add(call_id)
                fn = obj(call.get("function"), "tool_call.function", ["name", "arguments"])
                text(fn.get("name"), "tool_call.function.name")
                obj(strict_json(text(fn.get("arguments"), "tool_call.function.arguments", empty=True)), "tool arguments")
        else:
            text(m.get("content"), f"{p}.content")
    if pending:
        raise ValueError("历史结尾缺少工具结果")
    return copy.deepcopy(messages)


def build_document(payload, *, bad=False):
    """仅构造，不连接数据库。history/prompt 必须由日志平台在选中响应之前截取。"""
    v = obj(payload, "payload", ["moduleId", "source", "name", "replayMode", "history", "prompt", "systemPrompt", "functionCall", "badCase", "defaults", "description", "tags"])
    module_id = text(v.get("moduleId"), "moduleId")
    source = source_config(v.get("source"))
    mode = v.get("replayMode", "single-turn")
    if mode not in ("single-turn", "function-call"):
        raise ValueError("只支持已有 single-turn/function-call 模式")
    definition = {"id": text(v.get("name"), "name"), "replayMode": mode, "prompt": text(v.get("prompt"), "prompt"), "history": [], "importSource": source}
    if bad:
        definition["badCase"] = bad_config(v.get("badCase"))
    elif "badCase" in v:
        raise ValueError("普通入口不接受 badCase；请使用 import_bad_case")
    for key in ("systemPrompt", "description"):
        if key in v:
            definition[key] = text(v[key], key)
    if "tags" in v:
        if not isinstance(v["tags"], list):
            raise ValueError("tags 必须为数组")
        definition["tags"] = [text(t, "tags[]") for t in v["tags"]]
    if mode == "single-turn":
        if "functionCall" in v:
            raise ValueError("包含工具历史请显式使用 function-call 模式")
        history = v.get("history", [])
        if not isinstance(history, list):
            raise ValueError("history 必须为数组")
        for m in history:
            obj(m, "history[]", ["role", "content"])
            if m.get("role") not in ("user", "assistant"):
                raise ValueError("single-turn 历史只支持 user/assistant；请显式适配系统指令或使用 function-call")
            text(m.get("content"), "history[].content")
        definition["history"] = copy.deepcopy(history)
    else:
        if v.get("history", []) != []:
            raise ValueError("function-call 使用 functionCall.history，外层 history 必须为空")
        f = obj(v.get("functionCall"), "functionCall", ["tools", "toolChoice", "history"])
        tools = f.get("tools")
        if not isinstance(tools, list) or not tools or any(not isinstance(t, str) or t not in TOOLS for t in tools) or len(set(tools)) != len(tools):
            raise ValueError("functionCall.tools 必须为现有六种工具的不重复子集")
        choice = f.get("toolChoice", "auto")
        if choice not in ["auto", "required", *tools]:
            raise ValueError("toolChoice 必须为 auto/required 或所选工具")
        definition["functionCall"] = {"tools": tools[:], "toolChoice": choice, "history": native_history(f.get("history", []))}
    defaults = defaults_config(v.get("defaults"))
    if mode == "function-call" and defaults["providerId"] != "openai-compatible":
        raise ValueError("function-call 需要 openai-compatible")
    identity = json.dumps([module_id, source["platform"], source["taskId"], source["turnId"], "bad-case" if bad else "existing-case"], ensure_ascii=False, separators=(",", ":"))
    now = datetime.now(timezone.utc)
    doc = {"_id": str(uuid.uuid5(NAMESPACE, identity)), "schemaVersion": 1, "moduleId": module_id, "revision": 1, "archived": False, "createdAt": now, "updatedAt": now, "definition": definition, "defaults": defaults}
    if len(BSON.encode(doc)) > 15 * 1024 * 1024:
        raise ValueError("案例文档超过 15 MiB，请减少上下文")
    return doc


def same_content(existing, document):
    return not existing.get("archived", True) and all(existing.get(k) == document[k] for k in ("moduleId", "schemaVersion", "definition", "defaults"))


def validation_rules(details):
    """仅提取字段名与规则名；禁止传播 consideredValue/整条失败文档。"""
    found = []
    def visit(v, path="", depth=0):
        if depth > 24 or len(found) >= 20:
            return
        if isinstance(v, list):
            for x in v:
                visit(x, path, depth + 1)
        elif isinstance(v, dict):
            name = v.get("propertyName")
            if isinstance(name, str):
                path = f"{path}.{name}".strip(".")
            op = v.get("operatorName")
            if isinstance(op, str):
                found.append({"path": path, "rule": op})
            for key in ("details", "schemaRulesNotSatisfied", "propertiesNotSatisfied", "itemsNotSatisfied", "schemasNotSatisfied"):
                if key in v:
                    visit(v[key], path, depth + 1)
    visit(details)
    return found


def insert_document(client, database, document, *, case_collection="agent_eval_cases", module_collection="agent_eval_modules"):
    if case_collection == module_collection:
        raise ValueError("案例与模块集合不能同名")
    db = client[database]
    cases, modules = db[case_collection], db[module_collection]
    stage, target = "check-collections", ""
    result_base = {"caseId": document["_id"], "moduleId": document["moduleId"]}
    def transaction(session):
        nonlocal stage, target
        stage, target = "read-module", module_collection
        module = modules.find_one({"_id": document["moduleId"]}, session=session)
        if module is None:
            raise ImportFailure("not-found", "目标模块不存在", **result_base)
        version = module.get("writeVersion")
        # BSON Int64 是 int 子类；整数值仍须满足 JS 的安全整数边界。
        valid_version = isinstance(version, (int, float)) and not isinstance(version, bool) and 1 <= version < 9007199254740991 and math.isfinite(version) and int(version) == version
        if not valid_version or not isinstance(module.get("archived"), bool) or not isinstance(module.get("createdAt"), datetime) or not isinstance(module.get("name"), str) or not module["name"].strip() or len(module["name"]) > 80 or module.get("nameKey") != module["name"].strip().lower():
            raise ImportFailure("invalid-module", "模块结构不符合当前合同，请由管理员核对", **result_base)
        tags = module.get("tags", [])
        if not isinstance(tags, list) or len(tags) > 20 or any(not isinstance(tag, str) or not tag.strip() for tag in tags):
            raise ImportFailure("invalid-module", "模块标签不符合当前合同", **result_base)
        if module["archived"]:
            raise ImportFailure("conflict", "目标模块已归档", **result_base)
        stage = "touch-module"
        modules.update_one({"_id": module["_id"]}, {"$inc": {"writeVersion": 1}}, session=session)
        stage, target = "read-case", case_collection
        existing = cases.find_one({"_id": document["_id"]}, session=session)
        if existing is not None:
            if same_content(existing, document):
                return {"status": "unchanged", **result_base}
            raise ImportFailure("conflict", "同一轮次案例已存在但内容变化或已归档，不覆盖", **result_base)
        duplicate = cases.find_one({"moduleId": document["moduleId"], "archived": False, "definition.id": document["definition"]["id"]}, {"_id": 1}, session=session, collation={"locale": "simple"})
        if duplicate:
            raise ImportFailure("conflict", "目标模块内已有同名案例", conflictingCaseId=duplicate["_id"], **result_base)
        stage = "insert-case"
        cases.insert_one(copy.deepcopy(document), session=session)
        return {"status": "created", **result_base}
    try:
        # 防止 MongoDB 在首写时隐式建集合；没有 DDL 权限也能运行。
        for name in (case_collection, module_collection):
            target = name
            if not list(db.list_collections(filter={"name": name, "type": "collection"}, nameOnly=True)):
                raise ImportFailure("not-found", "目标集合未创建，请由管理员准备", collection=name, **result_base)
        with client.start_session() as session:
            return session.with_transaction(transaction, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"), read_preference=ReadPreference.PRIMARY, max_commit_time_ms=5000)
    except ImportFailure as error:
        return error.result
    except PyMongoError as error:
        code = getattr(error, "code", None)
        if error.has_error_label("UnknownTransactionCommitResult"):
            try:
                existing = cases.with_options(read_concern=ReadConcern("majority"), read_preference=ReadPreference.PRIMARY).find_one({"_id": document["_id"]})
                if existing and same_content(existing, document):
                    return {"status": "confirmed", **result_base}
            except PyMongoError:
                pass
            return {"status": "unknown", "message": "提交结果未知，请按 caseId 核对，勿更换导入身份", **result_base}
        status = {13: "unauthorized", 121: "validation-failed", 11000: "conflict", 20: "transactions-unsupported", 303: "transactions-unsupported"}.get(code, "database-error")
        details = getattr(error, "details", None) or {}
        return {"status": status, "code": code, "stage": stage, "collection": target, "rules": validation_rules(details.get("errInfo", {}).get("details", {})), "message": "MongoDB 操作失败；请根据状态、集合和规则排查，未报告导入成功", **result_base}


def import_single_turn_case(client, database, payload, **collections):
    """普通入口：复用已有 single-turn/function-call，不添加案例类型。"""
    return insert_document(client, database, build_document(payload), **collections)


def import_bad_case(client, database, payload, **collections):
    """Bad case 入口：独立保存原始错误输出，不加入 history/prompt。"""
    return insert_document(client, database, build_document(payload, bad=True), **collections)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="规范化输入 JSON 文件")
    parser.add_argument("--bad-case", action="store_true")
    parser.add_argument("--validate-only", action="store_true", help="仅本地校验；不代表数据库写入一定成功")
    args = parser.parse_args()
    try:
        with open(args.input, encoding="utf-8-sig") as stream:
            document = build_document(strict_json(stream.read()), bad=args.bad_case)
        if args.validate_only:
            result = {"status": "validated", "caseId": document["_id"]}
        else:
            uri = os.environ.get("EVAL_MONGODB_URI")
            if not uri:
                raise ValueError("请设置 EVAL_MONGODB_URI")
            with MongoClient(uri, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000, socketTimeoutMS=15000) as client:
                result = insert_document(client, os.environ.get("EVAL_MONGODB_DATABASE", "agent_eval"), document, case_collection=os.environ.get("EVAL_MONGODB_CASE_COLLECTION", "agent_eval_cases"), module_collection=os.environ.get("EVAL_MONGODB_MODULE_COLLECTION", "agent_eval_modules"))
    except PyMongoError:
        result = {"status": "database-error", "stage": "connect", "message": "MongoDB 客户端配置或连接失败，请核对环境配置；未报告导入成功"}
    except (ValueError, TypeError, OverflowError, RecursionError, OSError):
        # 不直接回显异常，连接串、原始日志或文件内容可能出现在异常文本中。
        result = {"status": "invalid-input", "message": "参数、文件或环境配置无效；请调用 build_document 定位字段校验问题，勿记录原始日志/凭据"}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] in ("created", "unchanged", "confirmed", "validated") else 1


if __name__ == "__main__":
    sys.exit(main())
