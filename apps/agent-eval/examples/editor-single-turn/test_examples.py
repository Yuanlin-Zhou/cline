import copy
import json
from pathlib import Path
import runpy
import unittest
ROOT = Path(__file__).resolve().parent
MODULE = runpy.run_path(str(ROOT / "verify_editor_scenarios.py"))
VERIFY = MODULE["verify"]
CASES = json.loads((ROOT / "cases.json").read_text(encoding="utf-8"))["cases"]


def context(case, arguments=None):
    params = copy.deepcopy(case["grading"]["rules"][0]["params"])
    values = arguments if arguments is not None else params["expected_calls"]
    calls = [{"id": "call_" + str(index), "type": "function", "function": {"name": "editor", "arguments": json.dumps(value, ensure_ascii=False)}} for index, value in enumerate(values)]
    return {"case": {"replay_mode": "function-call", "history": case["history"], "prompt": case["prompt"]},
            "execution": {"status": "completed"}, "params": params,
            "diagnostics": {"function_call_response": {"schema_version": 1, "protocol": "openai-chat-completions", "completeness": "complete",
                "request_tools": [{"type": "function", "function": {"name": "editor", "parameters": MODULE["SCHEMA"]}}],
                "raw_response": json.dumps({"choices": [{"finish_reason": "tool_calls", "message": {"role": "assistant", "tool_calls": calls}}]}, ensure_ascii=False)}}}


class ExamplesTests(unittest.TestCase):
    def test_six_examples_have_history_current_input_and_match_expected_calls(self):
        self.assertEqual(len(CASES), 6)
        self.assertEqual(len({c["id"] for c in CASES}), 6)
        baseline = runpy.run_path(str(ROOT.parent / "function-calls/verify_editor.py"))
        self.assertEqual(MODULE["SCHEMA"], baseline["SCHEMA"])
        for case in CASES:
            with self.subTest(case=case["id"]):
                self.assertEqual([h["role"] for h in case["history"]], ["user", "assistant", "user", "assistant"])
                self.assertTrue(case["prompt"].strip())
                self.assertEqual(VERIFY(context(case))["verdict"], "pass")
                values = copy.deepcopy(case["grading"]["rules"][0]["params"]["expected_calls"])
                for value in values:
                    self.assertTrue(value["new_text"].endswith("\n"))
                    self.assertNotIn("\\n", value["new_text"])
                    for field in ("old_text", "insert_line"):
                        if value[field] is None:
                            del value[field]
                self.assertEqual(VERIFY(context(case, values))["verdict"], "pass")

    def test_wrong_arguments_do_not_pass_even_when_the_format_is_valid(self):
        for case in CASES:
            for field in ("path", "new_text", "old_text", "insert_line"):
                with self.subTest(case=case["id"], field=field):
                    values = copy.deepcopy(case["grading"]["rules"][0]["params"]["expected_calls"])
                    expected = values[0][field]
                    values[0][field] = (99 if expected != 99 else 100) if field == "insert_line" else "wrong-value"
                    result = VERIFY(context(case, values))
                    self.assertEqual(result["verdict"], "fail")
                    self.assertTrue(any(c["id"].endswith("-" + field) and c["status"] == "fail" for c in result["checks"]))

    def test_newline_latest_override_call_order_count_and_missing_evidence(self):
        for case in CASES:
            values = copy.deepcopy(case["grading"]["rules"][0]["params"]["expected_calls"])
            values[0]["new_text"] = values[0]["new_text"].rstrip("\n")
            self.assertEqual(VERIFY(context(case, values))["verdict"], "fail")
        latest = next(c for c in CASES if c["id"] == "editor-history-latest-request")
        self.assertEqual(VERIFY(context(latest, [{"path": "/project/docs/old.txt", "new_text": "OLD\n"}]))["verdict"], "fail")
        multi = next(c for c in CASES if c["id"] == "editor-history-two-files")
        expected = multi["grading"]["rules"][0]["params"]["expected_calls"]
        self.assertEqual(VERIFY(context(multi, list(reversed(expected))))["verdict"], "fail")
        self.assertEqual(VERIFY(context(multi, expected[:1]))["verdict"], "fail")
        self.assertEqual(VERIFY(context(multi, expected + expected[:1]))["verdict"], "fail")
        ctx = context(latest)
        del ctx["diagnostics"]["function_call_response"]
        self.assertEqual(VERIFY(ctx)["verdict"], "insufficient")


if __name__ == "__main__":
    unittest.main()
