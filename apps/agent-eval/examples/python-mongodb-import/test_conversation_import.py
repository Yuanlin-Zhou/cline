import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from conversation_history import convert_conversation, history_source, native_history, strict_json
from import_cases import build_conversation_document, build_document, preview_conversation_case

ROOT = Path(__file__).parent


class ConversationTests(unittest.TestCase):
    def payload(self, name="conversation-bad-case.json"):
        return json.loads((ROOT / name).read_text(encoding="utf-8"))

    def test_full_bad_record_selects_prefix_without_error_or_future_in_model_input(self):
        p = self.payload()
        preview = preview_conversation_case(p, bad=True)
        definition = preview["definition"]
        self.assertEqual(definition["replayMode"], "function-call")
        self.assertEqual(definition["history"], [])
        self.assertEqual(definition["prompt"], "安装依赖应该执行什么命令？")
        self.assertEqual(definition["functionCall"]["history"], [{"role": "system", "content": "项目使用 Bun，请用中文回答。"}])
        self.assertEqual(definition["badCase"]["observedOutput"], "请执行 npm install。")
        request_input = json.dumps([definition["functionCall"]["history"], definition["prompt"]], ensure_ascii=False)
        self.assertNotIn("npm install", request_input)
        self.assertNotIn("后续消息", request_input)
        self.assertEqual(preview["boundary"], {"originalCount": 4, "selectedCount": 2, "excludedCount": 2, "appended": False, "badMessageIndex": 2})

    def test_cline_and_type_data_and_standard_become_existing_function_call_cases(self):
        for name in ("conversation-normal.json", "conversation-cline.json", "conversation-type-data.json"):
            with self.subTest(name=name):
                doc = build_conversation_document(self.payload(name))
                self.assertEqual(doc["definition"]["replayMode"], "function-call")
                self.assertNotIn("badCase", doc["definition"])
                fn = doc["definition"]["functionCall"]
                self.assertEqual(fn["history"][0]["role"], "system")
                self.assertEqual(len(fn["history"]), len(fn["historySource"]["messages"]))

    def test_cline_full_record_excludes_selected_reply_and_keeps_call_aliases(self):
        p = self.payload("conversation-cline-bad-case.json")
        doc = build_conversation_document(p, bad=True)
        history = doc["definition"]["functionCall"]["history"]
        self.assertEqual(history[2]["tool_calls"][0]["id"], "call_1")
        self.assertEqual(history[3]["tool_call_id"], "call_1")
        self.assertNotIn("FUTURE_INPUT_NOT_REPLAYED", json.dumps(history))
        self.assertNotIn("没有生成 editor 调用", json.dumps(history, ensure_ascii=False))

    def test_tool_tail_preserves_complete_history_and_appends_continuation(self):
        p = self.payload("conversation-cline.json")
        p["conversation"]["messages"].pop()
        p["options"]["continuation"] = "继续下一步"
        preview = preview_conversation_case(p)
        self.assertTrue(preview["boundary"]["appended"])
        self.assertEqual(preview["definition"]["prompt"], "继续下一步")
        self.assertEqual(preview["definition"]["functionCall"]["history"][-1]["role"], "tool")

    def test_standard_tool_messages_need_no_manual_normalization(self):
        p = self.payload("conversation-openai-tools-bad-case.json")
        doc = build_conversation_document(p, bad=True)
        definition = doc["definition"]
        self.assertEqual([m["role"] for m in definition["functionCall"]["history"]], ["system", "user", "assistant", "tool"])
        self.assertEqual(definition["functionCall"]["history"][2]["tool_calls"][0]["id"], definition["functionCall"]["history"][3]["tool_call_id"])
        self.assertEqual(definition["prompt"], "把 hello 改成 world，请调用 editor。")
        self.assertNotIn("没有生成 editor", json.dumps(definition["functionCall"]["history"], ensure_ascii=False))

    def test_bad_input_prefix_requires_explicit_separate_output_and_records_notice(self):
        p = self.payload()
        p["conversation"]["messages"] = p["conversation"]["messages"][:2]
        del p["badMessageIndex"]
        preview = preview_conversation_case(p, bad=True)
        self.assertTrue(any("按已截取输入历史处理" in n for n in preview["notices"]))
        del p["badCase"]
        with self.assertRaises(ValueError):
            build_conversation_document(p, bad=True)

    def test_invalid_boundaries_and_mixed_old_parameters_reject_before_any_db_call(self):
        for value in (True, False, None, "2", 2.5, -1, 0, 1, 4):
            with self.subTest(index=value):
                p = self.payload()
                p["badMessageIndex"] = value
                with self.assertRaises(ValueError):
                    build_conversation_document(p, bad=True)
        for key in ("history", "prompt", "functionCall", "replayMode"):
            p = self.payload()
            p[key] = "mixed"
            with self.assertRaisesRegex(ValueError, key):
                build_conversation_document(p, bad=True)
        with self.assertRaises(ValueError):
            build_conversation_document(self.payload())

    def test_normalized_new_and_existing_entries_share_stable_identity(self):
        p = self.payload()
        a = build_conversation_document(p, bad=True)
        definition = a["definition"]
        old = {k: p[k] for k in ("moduleId", "source", "name", "defaults", "badCase")}
        old.update(replayMode="function-call", history=[], prompt=definition["prompt"], functionCall=definition["functionCall"])
        b = build_document(old, bad=True)
        self.assertEqual(a["_id"], b["_id"])
        self.assertEqual(a["definition"], b["definition"])
        self.assertEqual(build_conversation_document(p, bad=True)["_id"], a["_id"])

    def test_unknown_options_malformed_source_and_wrong_provider_are_rejected(self):
        for options in ({"ignoreThinking": "true"}, {"systemSource": "unknown"}, {"continuation": ""}, {"tools": []}, {"tools": ["not-a-tool"]}, {"toolChoice": "not-selected"}, {"extra": True}):
            p = self.payload()
            p["options"] = options
            with self.assertRaises(ValueError):
                build_conversation_document(p, bad=True)
        p = self.payload()
        p["defaults"]["providerId"] = "cline"
        with self.assertRaisesRegex(ValueError, "openai-compatible"):
            build_conversation_document(p, bad=True)

    def test_raw_json_duplicate_keys_bom_alias_and_invalid_arguments(self):
        p = self.payload("conversation-normal.json")
        p["conversation"] = '\ufeff{"messgaes":[{"role":"user","content":"question"}]}'
        self.assertEqual(build_conversation_document(p)["definition"]["prompt"], "question")
        p["conversation"] = '{"messages":[{"role":"user","role":"assistant","content":"x"}]}'
        with self.assertRaises(ValueError):
            build_conversation_document(p)
        with self.assertRaises(ValueError):
            native_history([{"role": "assistant", "tool_calls": [{"id": "a", "type": "function", "function": {"name": "editor", "arguments": '{"x":1,"x":2}'}}]}])
        with self.assertRaises(ValueError):
            strict_json('{"x":1e999}')
        with self.assertRaises(ValueError):
            strict_json('{"x":' + '9' * 400 + '}')

    def test_history_source_must_cover_exactly_the_history(self):
        result = convert_conversation({"messages": [{"role": "system", "content": "system"}, {"role": "user", "content": "input"}]})
        source = copy.deepcopy(result["source"])
        source["messages"][0]["index"] = 1
        with self.assertRaises(ValueError):
            history_source(source, result["history"])

    def test_cli_validates_conversation_without_uri_and_keeps_old_input_supported(self):
        for filename, flags in (("conversation-bad-case.json", ["--conversation", "--bad-case"]), ("conversation-cline.json", ["--conversation"]), ("bad-case.json", ["--bad-case"])):
            result = subprocess.run([sys.executable, str(ROOT / "import_cases.py"), str(ROOT / filename), *flags, "--validate-only"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(data["status"], "validated")
            if "--conversation" in flags:
                self.assertIn("boundary", data)
                self.assertIn("notices", data)

    def test_cli_invalid_boundary_does_not_echo_raw_conversation(self):
        p = self.payload()
        p["conversation"]["messages"][0]["content"] = "PRIVATE_CONVERSATION_TEXT"
        p["badMessageIndex"] = 999
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "invalid.json"
            source.write_text(json.dumps(p), encoding="utf-8")
            result = subprocess.run([sys.executable, str(ROOT / "import_cases.py"), str(source), "--conversation", "--bad-case", "--validate-only"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["status"], "invalid-input")
            self.assertNotIn("PRIVATE_CONVERSATION_TEXT", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
