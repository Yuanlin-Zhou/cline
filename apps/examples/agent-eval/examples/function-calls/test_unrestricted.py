"""Count-unrestricted scripts still validate every call and fit the platform report contract."""
import copy
import json
from pathlib import Path
import runpy
import unittest
ROOT = Path(__file__).resolve().parent
NAMES = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["tools"]


class UnrestrictedTests(unittest.TestCase):
    def context(self, name, count):
        ctx = json.loads((ROOT / "fixtures" / (name + "-pass.json")).read_text(encoding="utf-8"))
        trace = ctx["diagnostics"]["function_call_response"]
        body = json.loads(trace["raw_response"])
        first = body["choices"][0]["message"]["tool_calls"][0]
        calls = [dict(copy.deepcopy(first), id="call_" + str(i)) for i in range(count)]
        body["choices"][0]["message"]["tool_calls"] = calls
        return ctx, trace, body, calls

    def test_all_six_accept_many_calls_and_ignore_old_count_settings(self):
        for name in NAMES:
            verify = runpy.run_path(str(ROOT / "unrestricted" / ("verify_" + name + ".py")))["verify"]
            for count in (1, 2, 16, 100):
                with self.subTest(name=name, count=count):
                    ctx, trace, body, calls = self.context(name, count)
                    ctx["params"] = {"expected_count": 1, "expected_total_calls": 1,
                                     "min_count": 999, "max_count": 0, "allowed_tools": [name]}
                    trace["raw_response"] = json.dumps(body)
                    result = verify(ctx)
                    self.assertEqual(result["verdict"], "pass")
                    self.assertLessEqual(len(result["checks"]), 96)
                    self.assertEqual(result["checks"][0]["actual"]["calls"], count)
                    self.assertEqual(result["checks"][0]["actual"]["failed_checks"], 0)

    def test_last_call_is_checked_even_after_report_is_full(self):
        for name in NAMES:
            verify = runpy.run_path(str(ROOT / "unrestricted" / ("verify_" + name + ".py")))["verify"]
            for fault in ("arguments", "duplicate", "name"):
                with self.subTest(name=name, fault=fault):
                    ctx, trace, body, calls = self.context(name, 100)
                    if fault == "arguments":
                        calls[-1]["function"]["arguments"] = "{}"
                    elif fault == "duplicate":
                        calls[-1]["id"] = calls[0]["id"]
                    else:
                        calls[-1]["function"]["name"] = "unknown"
                    trace["raw_response"] = json.dumps(body)
                    result = verify(ctx)
                    self.assertEqual(result["verdict"], "fail")
                    self.assertGreater(result["checks"][0]["actual"]["failed_checks"], 0)
                    self.assertTrue(any(c["id"].startswith("call-99-") and c["status"] == "fail" for c in result["checks"]))
                    self.assertLessEqual(len(result["checks"]), 96)

    def test_no_call_and_missing_target_are_failures(self):
        for name in NAMES:
            verify = runpy.run_path(str(ROOT / "unrestricted" / ("verify_" + name + ".py")))["verify"]
            ctx, trace, body, calls = self.context(name, 0)
            trace["raw_response"] = json.dumps(body)
            self.assertEqual(verify(ctx)["verdict"], "fail")
            ctx, trace, body, calls = self.context(name, 1)
            calls[0]["function"]["name"] = "unknown"
            trace["raw_response"] = json.dumps(body)
            self.assertEqual(verify(ctx)["verdict"], "fail")


if __name__ == "__main__":
    unittest.main()
