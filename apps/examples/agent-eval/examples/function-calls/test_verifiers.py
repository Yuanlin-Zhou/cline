import copy
import json
from pathlib import Path
import runpy
import unittest
ROOT = Path(__file__).resolve().parent
NAMES = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["tools"]


class VerifierTests(unittest.TestCase):
    def setup_for(self, name):
        self.verify = runpy.run_path(str(ROOT / ("verify_" + name + ".py")))["verify"]
        self.ctx = json.loads((ROOT / "fixtures" / (name + "-pass.json")).read_text(encoding="utf-8"))

    def mutate(self, change):
        ctx = copy.deepcopy(self.ctx)
        trace = ctx["diagnostics"]["function_call_response"]
        response = json.loads(trace["raw_response"])
        change(response)
        trace["raw_response"] = json.dumps(response)
        return self.verify(ctx)

    def test_all_six_positive_and_missing_required_fields(self):
        for name in NAMES:
            with self.subTest(name=name):
                self.setup_for(name)
                self.assertEqual(self.verify(self.ctx)["verdict"], "pass")
                bad = json.loads((ROOT / "fixtures" / (name + "-fail.json")).read_text(encoding="utf-8"))
                self.assertEqual(self.verify(bad)["verdict"], "fail")
                self.assertEqual(self.verify(json.loads((ROOT / "fixtures/missing.json").read_text(encoding="utf-8")))["verdict"], "insufficient")

    def test_envelope_and_json_errors(self):
        self.setup_for("read_files")
        def call(body):
            return body["choices"][0]["message"]["tool_calls"][0]
        for change in [lambda b:call(b).update(id=""), lambda b:call(b).update(type="custom"),
                       lambda b:call(b)["function"].update(name="unknown"),
                       lambda b:call(b)["function"].update(name={"malformed":True}),
                       lambda b:call(b)["function"].update(arguments={}),
                       lambda b:call(b)["function"].update(arguments='{"files":[],"files":[]}'),
                       lambda b:call(b)["function"].update(arguments='{"files":NaN}'),
                       lambda b:call(b)["function"].update(arguments='{"files":1e309}'),
                       lambda b:call(b)["function"].update(arguments='[]'),
                       lambda b:b["choices"][0]["message"].update(role="user"),
                       lambda b:b["choices"][0]["message"].update(tool_calls=[]),
                       lambda b:b["choices"][0]["message"].update(tool_calls=[copy.deepcopy(call(b)),copy.deepcopy(call(b))])]:
            with self.subTest(change=change):
                self.assertEqual(self.mutate(change)["verdict"], "fail")

    def test_canonical_parameters_do_not_use_sdk_coercion(self):
        cases = {"read_files":[{"files":[{"path":"/a","start_line":"1"}]},{"files":[{"file_path":"/a"}]},{"files":[{"path":"/a","start_line":True}]},{"files":[{"path":"/a","start_line":0}]}],
                 "run_commands":[{"commands":[{"command":"echo","args":["x"]}]},{"cmd":"echo x"}],
                 "search_codebase":[{"queries":"TODO"},{"queries":[1]}],
                 "fetch_web_content":[{"requests":[{"url":"https://a","prompt":"x"}]}],
                 "editor":[{"path":"/a","new_text":1},{"path":"","new_text":"ok"}],
                 "skills":[{"skill":""},{"skill":"review","args":{}}]}
        for name, invalids in cases.items():
            self.setup_for(name)
            for value in invalids:
                with self.subTest(name=name,value=value):
                    self.assertEqual(self.mutate(lambda b:b["choices"][0]["message"]["tool_calls"][0]["function"].update(arguments=json.dumps(value)))["verdict"], "fail")
        self.setup_for("read_files")
        self.assertEqual(self.mutate(lambda b:b["choices"][0]["message"]["tool_calls"][0]["function"].update(arguments='{"files":[{"path":"/a","start_line":null}]}'))["verdict"], "pass")

    def test_incomplete_unknown_source_schema_and_history(self):
        self.setup_for("read_files")
        self.assertEqual(self.mutate(lambda b:b["choices"][0].update(finish_reason="length"))["verdict"], "insufficient")
        for change in [lambda c:c["execution"].update(status="error"), lambda c:c["case"].update(replay_mode="single-turn"),
                       lambda c:c["diagnostics"]["function_call_response"].update(completeness="partial"),
                       lambda c:c["diagnostics"]["function_call_response"]["request_tools"][0]["function"].update(parameters={})]:
            ctx=copy.deepcopy(self.ctx);change(ctx);self.assertEqual(self.verify(ctx)["verdict"], "insufficient")
        self.ctx["case"]["history"]=[{"role":"assistant","content":"read_files already called"}]
        self.assertEqual(self.mutate(lambda b:b["choices"][0]["message"].update(tool_calls=[]))["verdict"], "fail")

    def test_multi_call_count_and_all_observed_arguments(self):
        self.setup_for("read_files")
        self.ctx["params"]={"expected_count":2,"expected_total_calls":2}
        def duplicate(body):
            calls=body["choices"][0]["message"]["tool_calls"]
            other=copy.deepcopy(calls[0]);other["id"]="call_2";calls.append(other)
        self.assertEqual(self.mutate(duplicate)["verdict"], "pass")
        self.assertEqual(self.verify(self.ctx)["verdict"], "fail")

    def repeated(self, count, change=None):
        def build(body):
            first = body["choices"][0]["message"]["tool_calls"][0]
            calls = [copy.deepcopy(first) for _ in range(count)]
            for index, call in enumerate(calls):
                call["id"] = "call_" + str(index)
            body["choices"][0]["message"]["tool_calls"] = calls
            if change:
                change(calls)
        return self.mutate(build)

    def test_variable_counts_for_all_six_and_legacy_default(self):
        for name in NAMES:
            with self.subTest(name=name):
                self.setup_for(name)
                self.ctx["params"] = {"min_count": 1, "allowed_tools": [name]}
                for count in (1, 2, 5, 15):
                    result = self.repeated(count)
                    self.assertEqual(result["verdict"], "pass")
                    check = next(c for c in result["checks"] if c["id"] == "target-count")
                    self.assertEqual(check["actual"], count)
                    self.assertIn("实际 %d 次" % count, check["message"])
                self.assertEqual(self.repeated(0)["verdict"], "fail")
                self.assertEqual(self.repeated(16)["verdict"], "insufficient")
                self.ctx["params"] = {}
                self.assertEqual(self.repeated(1)["verdict"], "pass")
                self.assertEqual(self.repeated(2)["verdict"], "fail")
                self.ctx["params"] = {"expected_count": 2}
                self.assertEqual(self.repeated(2)["verdict"], "pass")
                self.assertEqual(self.repeated(3)["verdict"], "fail")

    def test_range_bounds_and_total_count(self):
        self.setup_for("editor")
        self.ctx["params"] = {"min_count": 2, "max_count": 4}
        for count, verdict in ((1, "fail"), (2, "pass"), (4, "pass"), (5, "fail")):
            self.assertEqual(self.repeated(count)["verdict"], verdict)
        self.ctx["params"] = {"max_count": 3}
        self.assertEqual(self.repeated(1)["verdict"], "pass")
        self.assertEqual(self.repeated(4)["verdict"], "fail")
        self.ctx["params"] = {"min_count": 1, "expected_total_calls": 2}
        self.assertEqual(self.repeated(2)["verdict"], "pass")
        self.assertEqual(self.repeated(1)["verdict"], "fail")

    def test_variable_count_still_checks_every_call(self):
        for name in NAMES:
            with self.subTest(name=name):
                self.setup_for(name)
                self.ctx["params"] = {"min_count": 1, "allowed_tools": [name]}
                for change in (
                    lambda calls: calls[1]["function"].update(arguments="{}"),
                    lambda calls: calls[1].update(id=calls[0]["id"]),
                    lambda calls: calls[1]["function"].update(name="unknown"),
                    lambda calls: calls[1]["function"].update(arguments="not JSON"),
                    lambda calls: calls[1]["function"].pop("arguments"),
                ):
                    self.assertEqual(self.repeated(2, change)["verdict"], "fail")
        # An advertised but disallowed second tool must not sneak past the target count.
        self.setup_for("editor")
        other = json.loads((ROOT / "fixtures/read_files-pass.json").read_text(encoding="utf-8"))
        self.ctx["diagnostics"]["function_call_response"]["request_tools"] += other["diagnostics"]["function_call_response"]["request_tools"]
        self.ctx["params"] = {"min_count": 1, "allowed_tools": ["editor"]}
        self.assertEqual(self.repeated(2, lambda calls: calls[1]["function"].update(name="read_files"))["verdict"], "fail")

    def test_invalid_count_policies(self):
        self.setup_for("editor")
        invalids = [
            {"expected_count": 1, "min_count": 1}, {"expected_count": 1, "max_count": 3},
            {"min_count": 0}, {"min_count": -1}, {"min_count": True}, {"min_count": "1"},
            {"min_count": None}, {"min_count": 1.5}, {"max_count": None},
            {"max_count": False}, {"max_count": "2"}, {"max_count": 0},
            {"min_count": 3, "max_count": 2}, {"min_count": 2, "expected_total_calls": 1},
            {"min_count": 1, "expected_total_calls": True},
            {"min_count": 1, "expected_total_calls": None},
            {"min_count": 1, "max_count": 2, "allowed_tools": ["editor"], "expected_total_calls": 3},
            {"expected_count": 2, "expected_total_calls": 1},
        ]
        for params in invalids:
            with self.subTest(params=params):
                self.ctx["params"] = params
                with self.assertRaises(ValueError):
                    self.verify(self.ctx)


if __name__ == "__main__":
    unittest.main()
