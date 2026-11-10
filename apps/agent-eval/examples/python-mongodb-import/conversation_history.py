"""Pure Python counterpart of function-call-history.ts; no database or Node dependency."""
from __future__ import annotations

import copy
import json
import math
from decimal import Decimal

HISTORY_BYTES = 1048576
HISTORY_MESSAGES = 500

def obj(value, path, allowed=None):
    if not isinstance(value, dict):
        raise ValueError(f"{path} 必须为对象")
    if allowed is not None and set(value) - set(allowed):
        key = next(k for k in value if k not in allowed)
        raise ValueError(f"{path}.{key} 是不支持的字段")
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
        if depth > 64:
            raise ValueError("JSON 嵌套过深或包含非有限数字")
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            try:
                is_finite = math.isfinite(v)
            except OverflowError:
                is_finite = False
            if not is_finite:
                raise ValueError("JSON 包含非有限数字")
        if isinstance(v, dict):
            for x in v.values():
                finite(x, depth + 1)
        elif isinstance(v, list):
            for x in v:
                finite(x, depth + 1)
    finite(result)
    return result


def native_history(messages):
    if not isinstance(messages, list) or len(messages) > 500:
        raise ValueError("functionCall.history 必须为不超过 500 条的数组")
    if len(js_json(messages).encode("utf-8")) > HISTORY_BYTES:
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


def js_json(value):
    """Compact JSON, JS property ordering and number notation for tool payloads."""
    def encode(v, depth=0):
        if depth > 64:
            raise ValueError("JSON 嵌套过深")
        if v is None:
            return "null"
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, str):
            result = json.dumps(v, ensure_ascii=False)
            return "".join(f"\\u{ord(c):04x}" if 0xD800 <= ord(c) <= 0xDFFF else c for c in result)
        if isinstance(v, (int, float)):
            try:
                number = float(v)
            except OverflowError as error:
                raise ValueError("JSON 包含非有限数字") from error
            if not math.isfinite(number):
                raise ValueError("JSON 包含非有限数字")
            if number == 0:
                return "0"
            decimal = Decimal(repr(number))
            if 1e-6 <= abs(number) < 1e21:
                result = format(decimal, "f")
                return result.rstrip("0").rstrip(".") if "." in result else result
            coefficient, exponent = format(decimal.normalize(), "e").split("e")
            exponent = int(exponent)
            return coefficient + "e" + ("+" if exponent >= 0 else "") + str(exponent)
        if isinstance(v, list):
            return "[" + ",".join(encode(x, depth + 1) for x in v) + "]"
        if isinstance(v, dict):
            if any(not isinstance(key, str) for key in v):
                raise ValueError("JSON 对象键必须为字符串")
            indices = sorted((k for k in v if len(k) <= 10 and k.isascii() and k.isdigit() and str(int(k)) == k and int(k) < 4294967295), key=int)
            index_set = set(indices)
            keys = indices + [k for k in v if k not in index_set]
            return "{" + ",".join(encode(k) + ":" + encode(v[k], depth + 1) for k in keys) + "}"
        raise ValueError("仅支持 JSON 数据类型")
    return encode(value)


def size(value, path):
    if len(js_json(value).encode("utf-8")) > HISTORY_BYTES:
        raise ValueError(f"{path} 超过 1 MiB 限制")


def unpack(raw, path):
    message = obj(raw, path)
    if "type" in message or "data" in message:
        obj(message, path, ["type", "data"])
        data = obj(message.get("data"), f"{path}.data")
        if "role" in data and data["role"] != message.get("type"):
            raise ValueError(f"{path}.type 与 data.role 不一致")
        return {**data, "role": text(message.get("type"), f"{path}.type")}
    return copy.deepcopy(message)


def plain_user(message):
    if message.get("role") != "user":
        return None
    content = message.get("content")
    if isinstance(content, str):
        return content if content.strip() else None
    if isinstance(content, list) and content and all(isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str) for b in content):
        return "\n".join(b["text"] for b in content) or None
    return None


def read_conversation(value):
    if isinstance(value, str):
        value = value.removeprefix("\ufeff")
        if len(value.encode("utf-8")) > HISTORY_BYTES:
            raise ValueError("conversation 超过 1 MiB 限制")
        raw = strict_json(value)
    else:
        size(value, "conversation")
        raw = strict_json(js_json(value))
    envelope = None if isinstance(raw, list) else obj(raw, "conversation")
    notices = []
    if envelope is not None and "messages" in envelope and "messgaes" in envelope:
        raise ValueError("messages 与 messgaes 不能同时存在")
    messages = raw if envelope is None else envelope.get("messages", envelope.get("messgaes"))
    if envelope is not None and "messgaes" in envelope:
        notices.append("已将 messgaes 规范为 messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= HISTORY_MESSAGES:
        raise ValueError("messages 须为 1 至 500 条消息数组")
    unpacked = [unpack(m, f"messages[{i}]") for i, m in enumerate(messages)]
    cline = any(isinstance(m.get("content"), list) or any(k in m for k in ("id", "ts", "metadata", "modelInfo", "metrics", "sessionId")) for m in unpacked)
    cline = cline or envelope is not None and ("system_prompt" in envelope or type(envelope.get("version")) in (int, float) and envelope["version"] == 1 and "agent" in envelope)
    result = {"format": "cline" if cline else "type-data" if any("data" in m for m in messages) else "openai", "messages": unpacked, "notices": notices, "raw": raw}
    if envelope is not None and "system_prompt" in envelope:
        result["systemPrompt"] = text(envelope["system_prompt"], "system_prompt", empty=True)
    if envelope is not None and "sessionId" in envelope:
        result["sessionId"] = text(envelope["sessionId"], "sessionId")
    return result


def history_source(value, history):
    v = obj(value, "functionCall.historySource", ["format", "sessionId", "notices", "messages"])
    if v.get("format") not in ("cline", "openai", "type-data") or not isinstance(v.get("notices"), list) or any(not isinstance(n, str) for n in v["notices"]) or not isinstance(v.get("messages"), list) or len(v["messages"]) > HISTORY_MESSAGES:
        raise ValueError("functionCall.historySource 格式无效")
    size(v, "functionCall.historySource")
    for m in v["messages"]:
        obj(m, "historySource.messages", ["index", "sourceIndex", "blockIndex", "id"])
        for key in ("index", "sourceIndex", "blockIndex"):
            if key in m and (type(m[key]) is not int or not 0 <= m[key] <= 9007199254740991):
                raise ValueError(f"historySource.{key} 必须为安全非负整数")
        if "index" not in m or "sourceIndex" not in m:
            raise ValueError("historySource 消息索引缺失")
        if "id" in m:
            text(m["id"], "historySource.id", empty=True)
    if "sessionId" in v:
        text(v["sessionId"], "historySource.sessionId")
    if len(history) != len(v["messages"]) or any(m["index"] != i for i, m in enumerate(v["messages"])):
        raise ValueError("functionCall.historySource 必须对应完整原生历史")
    return copy.deepcopy(v)


def convert_document(doc, *, current_index=None, ignore_thinking=False, system_source=None):
    """Port of convertHistoryDocument: preserve messages, calls, IDs and notices."""
    messages, notices = doc["messages"], doc["notices"][:]
    history, refs, aliases = [], [], {}
    prompt = None
    metadata = ["id", "ts", "agent", "sessionId", "metadata", "modelInfo", "metrics"]
    if current_index is not None:
        current = messages[current_index]
        prompt = plain_user(current)
        if prompt is None:
            raise ValueError("本轮输入必须选择纯文本用户消息，不能选择工具结果")
        p = f"messages[{current_index}]"
        obj(current, p, ["role", "content", "name"] + (metadata if doc["format"] == "cline" else []))
        if "name" in current:
            text(current["name"], f"{p}.name")
            notices.append(f"{p}.name 不随本轮文本问题发送")
        if isinstance(current.get("content"), list):
            for n, b in enumerate(current["content"]):
                obj(b, f"{p}.content[{n}]", ["type", "text", "signature"])
        notices.append(f"第 {current_index + 1} 条作为本轮输入，后续 {len(messages) - current_index - 1} 条不导入")
    selected = messages[:current_index] if current_index is not None else messages
    sessions = [m["sessionId"] for m in messages[:current_index + 1] if "sessionId" in m] if current_index is not None else [m["sessionId"] for m in messages if "sessionId" in m]
    if any(s != sessions[0] for s in sessions) or doc.get("sessionId") and any(s != doc["sessionId"] for s in sessions):
        raise ValueError("记录混杂不同 sessionId，请分别导入单个会话")
    system_prompt = doc.get("systemPrompt", "")
    if system_prompt.strip() and any(m.get("role") in ("system", "developer") for m in selected) and system_source is None:
        raise ValueError("顶层 system_prompt 与消息中的系统指令同时存在，请选择指令来源")

    def add(message, index, block_index=None):
        ref = {"index": len(history), "sourceIndex": index}
        if block_index is not None:
            ref["blockIndex"] = block_index
        if isinstance(messages[index].get("id"), str):
            ref["id"] = messages[index]["id"]
        refs.append(ref)
        history.append(message)

    if system_prompt.strip() and system_source != "messages":
        refs.append({"index": len(history), "sourceIndex": 0})
        history.append({"role": "system", "content": system_prompt})

    def block_text(raw, p):
        b = obj(raw, p)
        if b.get("type") == "text":
            obj(b, p, ["type", "text", "signature"])
            if "signature" in b:
                text(b["signature"], f"{p}.signature", empty=True)
                notices.append(f"{p}.signature 不随跨模型文本回放发送")
            return text(b.get("text"), f"{p}.text", empty=True)
        if b.get("type") == "file":
            obj(b, p, ["type", "path", "content", "source"])
            notices.append(f"{p} 文件块已转为内联文本，未读取路径")
            return f"[文件 {text(b.get('path'), p + '.path', empty=True)}]\n{text(b.get('content'), p + '.content', empty=True)}"
        raise ValueError(f"{p}.type 暂不支持；图片/媒体不能静默省略")

    def reject_media(v, p, depth=0):
        if depth > 64:
            raise ValueError(f"{p} 嵌套过深")
        if isinstance(v, dict):
            if v.get("type") in ("image", "media", "audio", "video"):
                raise ValueError(f"{p} 包含不支持的图片或媒体")
            for k, x in v.items():
                reject_media(x, f"{p}.{k}", depth + 1)
        elif isinstance(v, list):
            for k, x in enumerate(v):
                reject_media(x, f"{p}.{k}", depth + 1)

    dropped = 0
    for i, m in enumerate(selected):
        p = f"messages[{i}]"
        if m.get("role") in ("system", "developer") and system_source == "file":
            continue
        if "reasoning_content" in m:
            thought = m["reasoning_content"]
            if m.get("role") != "assistant":
                raise ValueError(f"{p}.reasoning_content 只能用于 assistant")
            if thought is not None and not isinstance(thought, str):
                raise ValueError(f"{p}.reasoning_content 必须为字符串或 null")
            if isinstance(thought, str) and thought.strip():
                if not ignore_thinking:
                    raise ValueError(f"{p}.reasoning_content 含思考内容，请明确选择“不发送思考块”后继续")
                dropped += 1
            else:
                notices.append(f"{p}.reasoning_content 为空，未导入")
        if doc["format"] != "cline" or not isinstance(m.get("content"), list):
            fields = ["role", "content", "name", "tool_calls", "tool_call_id", "reasoning_content"]
            obj(m, p, fields + (metadata if doc["format"] == "cline" else []))
            add({k: v for k, v in m.items() if k in fields and k != "reasoning_content"}, i)
            continue
        obj(m, p, ["role", "content", "reasoning_content"] + metadata)
        if m.get("role") not in ("user", "assistant"):
            raise ValueError(f"{p}.role 原生内容块仅支持 user/assistant")
        texts, calls = [], []
        for j, raw in enumerate(m["content"]):
            bp = f"{p}.content[{j}]"
            b = obj(raw, bp)
            if b.get("type") in ("thinking", "redacted_thinking"):
                if m["role"] != "assistant":
                    raise ValueError(f"{bp} 思考块只能用于 assistant")
                if not ignore_thinking:
                    raise ValueError(f"{bp} 含思考块，请明确选择“不发送思考块”后继续")
                dropped += 1
            elif b.get("type") == "tool_use":
                if m["role"] != "assistant":
                    raise ValueError(f"{bp} tool_use 只能用于 assistant")
                obj(b, bp, ["type", "id", "call_id", "name", "input", "signature"])
                internal = text(b.get("id"), f"{bp}.id")
                call_id = text(b["call_id"], f"{bp}.call_id") if "call_id" in b else internal
                if "signature" in b:
                    text(b["signature"], f"{bp}.signature", empty=True)
                    notices.append(f"{bp}.signature 不随兼容工具轨迹发送")
                for alias in dict.fromkeys([internal, call_id]):
                    if alias in aliases:
                        raise ValueError(f"{bp} 调用 ID/别名重复或有歧义")
                    aliases[alias] = call_id
                calls.append({"id": call_id, "type": "function", "function": {"name": text(b.get("name"), f"{bp}.name"), "arguments": js_json(obj(b.get("input"), f"{bp}.input"))}})
            elif b.get("type") == "tool_result":
                if m["role"] != "user":
                    raise ValueError(f"{bp} tool_result 只能用于 user")
                obj(b, bp, ["type", "tool_use_id", "name", "content", "is_error"])
                text(b.get("name"), f"{bp}.name")
                if "is_error" in b and not isinstance(b["is_error"], bool):
                    raise ValueError(f"{bp}.is_error 必须为布尔值")
                if texts:
                    add({"role": m["role"], "content": "\n".join(texts)}, i)
                    texts = []
                original = text(b.get("tool_use_id"), f"{bp}.tool_use_id")
                if original not in aliases:
                    raise ValueError(f"{bp}.tool_use_id 缺少前文调用，记录可能已压缩")
                content = b.get("content")
                if isinstance(content, str):
                    pass
                elif isinstance(content, list) and all(isinstance(x, dict) and x.get("type") in ("text", "file") for x in content):
                    content = "\n".join(block_text(x, f"{bp}.content[{n}]") for n, x in enumerate(content))
                else:
                    if "content" not in b:
                        raise ValueError(f"{bp}.content 缺失")
                    reject_media(content, f"{bp}.content")
                    content = js_json(content)
                    notices.append(f"{bp} 结构化工具结果已编码为完整 JSON 文本")
                if b.get("is_error"):
                    notices.append(f"{bp} 原工具结果标记为错误（is_error=true）")
                add({"role": "tool", "tool_call_id": aliases[original], "content": content}, i, j)
            else:
                texts.append(block_text(b, bp))
        if calls:
            add({"role": "assistant", "content": "\n".join(texts) if texts else None, "tool_calls": calls}, i)
        elif texts:
            add({"role": m["role"], "content": "\n".join(texts)}, i)
    if dropped:
        notices.append(f"按用户选择省略 {dropped} 段思考内容，不发送思考及签名")
    if doc["format"] == "cline":
        notices.append("Cline 消息元数据不发送给模型；这是上下文转换，不是原 SDK 请求逐字节重放")
    if any(m.get("role") == "developer" for m in history):
        notices.append("包含 developer 指令，目标模型服务须支持该角色")
    if history and history[-1]["role"] == "assistant":
        notices.append("历史结尾包含助手回复，请确认它属于历史而非待验证答案")
    source = {"format": doc["format"], "notices": list(dict.fromkeys(notices)), "messages": refs}
    if "sessionId" in doc:
        source["sessionId"] = doc["sessionId"]
    return {"history": native_history(history), "source": source, "prompt": prompt, "originalCount": len(messages)}


def convert_conversation(value, options=None, *, bad_message_index=None):
    """Same final-message/continuation boundary as the Web batch importer."""
    opts = obj({} if options is None else options, "options", ["tools", "toolChoice", "continuation", "ignoreThinking", "systemSource"])
    if "ignoreThinking" in opts and not isinstance(opts["ignoreThinking"], bool):
        raise ValueError("options.ignoreThinking 须为布尔值")
    if "systemSource" in opts and opts["systemSource"] not in ("file", "messages"):
        raise ValueError("options.systemSource 必须为 file/messages")
    continuation = text(opts.get("continuation", "继续"), "options.continuation")
    doc = read_conversation(value)
    original_count = len(doc["messages"])
    if bad_message_index is not None:
        if type(bad_message_index) is not int or not 0 <= bad_message_index < original_count:
            raise ValueError("badMessageIndex 超出原始消息数组范围或不是整数")
        if doc["messages"][bad_message_index].get("role") != "assistant":
            raise ValueError("badMessageIndex 必须选择助手回复")
        if bad_message_index == 0:
            raise ValueError("截取后没有输入消息，无法生成回放案例")
        raw = doc["raw"]
        prefix = raw[:bad_message_index] if isinstance(raw, list) else {**raw, "messgaes" if "messgaes" in raw else "messages": (raw["messgaes"] if "messgaes" in raw else raw["messages"])[:bad_message_index]}
        doc = read_conversation(prefix)
    last = len(doc["messages"]) - 1
    appended = plain_user(doc["messages"][-1]) is None
    result = convert_document(doc, current_index=None if appended else last, ignore_thinking=opts.get("ignoreThinking", False), system_source=opts.get("systemSource"))
    if appended:
        result["prompt"] = continuation
        result["source"]["notices"].append("完整保留历史，自动追加用户消息作为本轮输入")
    else:
        result["source"]["notices"] = [n for n in result["source"]["notices"] if not n.startswith(f"第 {last + 1} 条作为本轮输入")]
        result["source"]["notices"].append("实际末条用户消息作为本轮输入；原对话顺序完整保留，未追加续接消息")
    result["boundary"] = {"originalCount": original_count, "selectedCount": len(doc["messages"]), "excludedCount": original_count - len(doc["messages"]), "appended": appended}
    if bad_message_index is not None:
        result["boundary"]["badMessageIndex"] = bad_message_index
        result["source"]["notices"].append(f"按 badMessageIndex={bad_message_index} 截取：原始第 {bad_message_index + 1} 条错误回复及后续 {original_count - bad_message_index - 1} 条消息不进入回放输入")
    result["source"] = history_source(result["source"], result["history"])
    return result
