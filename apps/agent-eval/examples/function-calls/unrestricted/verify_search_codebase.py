"""Generated standalone verifier. Refresh with generate-function-call-verifiers.ts.
Validates every native call without count limits; never executes a tool.
Count-related params are ignored. Reports at most 95 detail checks plus a summary.
"""
import json
import math
import sys
TOOL = "search_codebase"
SCHEMA = json.loads("{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"queries\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Array of regex search queries to execute\"}},\"required\":[\"queries\"],\"additionalProperties\":false}")


def strict_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("重复 JSON 字段: " + key)
            result[key] = value
        return result
    def invalid_constant(value):
        raise ValueError("非标准 JSON 数字: " + value)
    def finite_float(text):
        value = float(text)
        if type(value) is float and not math.isfinite(value):
            raise ValueError("非有限 JSON 数字")
        return value
    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant, parse_float=finite_float)


def schema_errors(value, schema, path="$"):
    supported = {"$schema", "title", "description", "default", "type", "properties", "required",
                 "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength",
                 "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "enum", "const",
                 "anyOf", "oneOf", "allOf"}
    if set(schema) - supported:
        raise ValueError("不支持的 Schema 关键字: " + str(sorted(set(schema) - supported)))
    errors = []
    for keyword in ("anyOf", "oneOf", "allOf"):
        if keyword in schema:
            matches = [not schema_errors(value, branch, path) for branch in schema[keyword]]
            if (keyword == "anyOf" and not any(matches) or keyword == "oneOf" and sum(matches) != 1
                    or keyword == "allOf" and not all(matches)):
                errors.append(path + ": 不符合 " + keyword)
    finite = type(value) is int or type(value) is float and math.isfinite(value)
    types = {"object": isinstance(value, dict), "array": isinstance(value, list),
             "string": isinstance(value, str), "boolean": type(value) is bool, "null": value is None,
             "number": finite, "integer": finite and int(value) == value}
    expected = schema.get("type")
    if expected is not None:
        names = expected if isinstance(expected, list) else [expected]
        if not any(types.get(name, False) for name in names):
            return errors + [path + ": 应为 " + "/".join(names)]
    if "enum" in schema and not any(type(value) is type(v) and value == v for v in schema["enum"]):
        errors.append(path + ": 值不在 enum 中")
    if "const" in schema and (type(value) is not type(schema["const"]) or value != schema["const"]):
        errors.append(path + ": 值不符合 const")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(path + "/" + key + ": 缺少必填字段")
        for key, item in value.items():
            item_path = path + "/" + key.replace("~", "~0").replace("/", "~1")
            if key in properties:
                errors.extend(schema_errors(item, properties[key], item_path))
            elif schema.get("additionalProperties") is False:
                errors.append(item_path + ": 未公布的额外字段")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors.extend(schema_errors(item, schema["additionalProperties"], item_path))
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", math.inf):
            errors.append(path + ": 数组长度不符")
        if "items" in schema:
            for index, item in enumerate(value):
                errors.extend(schema_errors(item, schema["items"], path + "/" + str(index)))
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", math.inf):
            errors.append(path + ": 字符串长度不符")
    if type(value) in (int, float):
        if type(value) is float and not math.isfinite(value):
            errors.append(path + ": 必须是有限数字")
        for keyword, invalid in (("minimum", value < schema.get("minimum", -math.inf)),
                                 ("maximum", value > schema.get("maximum", math.inf)),
                                 ("exclusiveMinimum", value <= schema.get("exclusiveMinimum", -math.inf)),
                                 ("exclusiveMaximum", value >= schema.get("exclusiveMaximum", math.inf))):
            if invalid:
                errors.append(path + ": 不符合 " + keyword)
    return errors


def verify(ctx):
    checks = []
    total_checks = 0
    failed_checks = 0
    def preview(value):
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(encoded) > 4000:
            return {"truncated": True, "preview": encoded[:4000],
                    "full_value": "完整值见本轮固定的原始 function call 响应"}
        return value
    def check(identifier, passed, message, expected=None, actual=None):
        nonlocal total_checks, failed_checks
        item = {"id": identifier, "status": "pass" if passed else "fail", "message": message[:2000] + ("…（详情见原始响应）" if len(message) > 2000 else "")}
        if expected is not None:
            item["expected"] = preview(expected)
        if actual is not None:
            item["actual"] = preview(actual)
        total_checks += 1
        failed_checks += not passed
        if len(checks) < 95:
            checks.append(item)
        elif not passed:
            # Keep failures visible, including malformed calls near the end of a long response.
            for index, previous in enumerate(checks):
                if previous["status"] == "pass":
                    checks[index] = item
                    break
    def insufficient(message):
        return {"verdict": "insufficient", "message": message,
                "checks": [{"id": "raw-evidence", "status": "insufficient", "message": message}]}
    trace = ctx.get("diagnostics", {}).get("function_call_response")
    if (ctx.get("case", {}).get("replay_mode") != "function-call" or
            ctx.get("execution", {}).get("status") != "completed" or not isinstance(trace, dict) or
            trace.get("schema_version") != 1 or trace.get("protocol") != "openai-chat-completions" or
            trace.get("completeness") != "complete"):
        return insufficient("缺少本次单轮完整原始响应；解析后的轨迹不能证明原生 function call 格式。")
    if not isinstance(trace.get("raw_response"), str):
        return insufficient("原始响应正文未归档。")
    try:
        response = strict_json(trace["raw_response"])
    except (ValueError, TypeError, RecursionError) as error:
        return {"verdict": "fail", "message": "原始响应不是标准 JSON: " + str(error)}
    choices = response.get("choices") if isinstance(response, dict) else None
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        return {"verdict": "fail", "message": "响应须包含本轮唯一的 choices[0]。"}
    choice = choices[0]
    if choice.get("finish_reason") in ("length", "content_filter"):
        return insufficient("模型响应被截断或过滤，不能证明完整调用格式。")
    check("finish", choice.get("finish_reason") in ("stop", "tool_calls"), "响应须完整结束", ["stop", "tool_calls"], choice.get("finish_reason"))
    message = choice.get("message")
    if not isinstance(message, dict):
        return {"verdict": "fail", "message": "缺少 assistant message。"}
    check("role", message.get("role") == "assistant", "本轮角色须为 assistant", "assistant", message.get("role"))
    calls = message.get("tool_calls")
    if not isinstance(calls, list) or not calls:
        return {"verdict": "fail", "message": "模型未返回原生 tool_calls；文字或 JSON 代码块不算工具调用。"}
    tools = trace.get("request_tools", [])
    if not isinstance(tools, list) or any(not isinstance(item, dict) or
            not isinstance(item.get("function"), dict) or
            not isinstance(item["function"].get("name"), str) or
            not isinstance(item["function"].get("parameters"), dict) for item in tools):
        return insufficient("本轮请求工具定义缺失或不完整。")
    advertised = {item["function"]["name"]: item["function"]["parameters"] for item in tools}
    if TOOL not in advertised or advertised[TOOL] != SCHEMA:
        return insufficient("公布的目标 Schema 与验证器版本不一致，请重新生成/上传验证器。")
    params = ctx.get("params", {})
    if not isinstance(params, dict):
        raise ValueError("脚本参数须为 JSON 对象")
    allowed = params.get("allowed_tools", list(advertised))
    if not isinstance(allowed, list) or any(not isinstance(v, str) for v in allowed):
        raise ValueError("allowed_tools 须为工具名数组")
    ids = set()
    found = 0
    for index, call in enumerate(calls):
        prefix = "call-" + str(index)
        if not isinstance(call, dict):
            check(prefix, False, "tool_calls 项须为对象", "object", call)
            continue
        identifier = call.get("id")
        check(prefix + "-id", isinstance(identifier, str) and bool(identifier.strip()) and identifier not in ids,
              "调用 id 须非空且本轮唯一", "unique nonempty string", identifier)
        if isinstance(identifier, str):
            ids.add(identifier)
        check(prefix + "-type", call.get("type") == "function", "调用 type 须为 function", "function", call.get("type"))
        function = call.get("function")
        if not isinstance(function, dict):
            check(prefix + "-function", False, "缺少 function 对象")
            continue
        name = function.get("name")
        valid_name = isinstance(name, str) and name in advertised and name in allowed
        check(prefix + "-name", valid_name, "工具名称须在公布及允许列表内", allowed, name)
        found += name == TOOL
        arguments = function.get("arguments")
        if not isinstance(arguments, str):
            check(prefix + "-arguments", False, "function.arguments 须为 JSON 字符串", "JSON string", arguments)
            continue
        try:
            value = strict_json(arguments)
        except (ValueError, RecursionError) as error:
            check(prefix + "-arguments", False, "参数 JSON 无效: " + str(error), "strict JSON object", arguments)
            continue
        errors = schema_errors(value, advertised[name]) if valid_name else ["工具名无效"]
        if not isinstance(value, dict):
            errors.insert(0, "$: 参数根须为对象")
        check(prefix + "-schema", not errors, "参数符合公开 Schema" if not errors else "; ".join(errors[:8]), advertised.get(name) if isinstance(name, str) else None, value)
    check("target-present", found > 0, "本轮须实际包含目标工具 " + TOOL, "present", found)
    passed = failed_checks == 0
    checks.insert(0, {
        "id": "validation-summary", "status": "pass" if passed else "fail",
        "message": "已逐项验证全部 %d 条调用，%d 项检查，%d 项失败；不限制调用次数。最多展示95项明细，失败优先。" % (len(calls), total_checks, failed_checks),
        "actual": {"calls": len(calls), "target_calls": found, "checks": total_checks,
                   "failed_checks": failed_checks, "omitted_details": total_checks - len(checks)}
    })
    return {"verdict": "pass" if passed else "fail", "message": TOOL + (" 原生格式及参数结构正确" if passed else " 调用格式或参数结构不符"), "checks": checks}


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(json.dumps(verify(strict_json(handle.read())), ensure_ascii=False, allow_nan=False))
