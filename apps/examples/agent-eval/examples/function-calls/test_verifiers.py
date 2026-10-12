import copy
import json
from pathlib import Path
import runpy
import unittest
ROOT = Path(__file__).resolve().parent
NAMES = json.loads((ROOT / "manifest.json").read_text())["tools"]


class VerifierTests(unittest.TestCase):
    def setup_for(self, name):
        self.verify = runpy.run_path(str(ROOT / ("verify_" + name + ".py")))["verify"]
        self.ctx = json.loads((ROOT / "fixtures" / (name + "-pass.json")).read_text())

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
                bad = json.loads((ROOT / "fixtures" / (name + "-fail.json")).read_text())
                self.assertEqual(self.verify(bad)["verdict"], "fail")
                self.assertEqual(self.verify(json.loads((ROOT / "fixtures/missing.json").read_text()))["verdict"], "insufficient")

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


if __name__ == "__main__":
    unittest.main()
