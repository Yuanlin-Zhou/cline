import copy
import json
import unittest
from pathlib import Path
from import_cases import build_document, validation_rules


class BuildTests(unittest.TestCase):
    def payload(self, name="bad-case.json"):
        return json.loads(Path(__file__).with_name(name).read_text(encoding="utf-8"))

    def test_old_case_and_bad_case_are_separate_stable_imports(self):
        bad = self.payload()
        normal = copy.deepcopy(bad)
        del normal["badCase"]
        a, b = build_document(normal), build_document(bad, bad=True)
        self.assertNotEqual(a["_id"], b["_id"])
        self.assertEqual(build_document(bad, bad=True)["_id"], b["_id"])
        self.assertNotIn("badCase", a["definition"])
        self.assertNotIn("caseKind", b["definition"])
        self.assertNotIn(b["definition"]["badCase"]["observedOutput"], b["definition"]["prompt"])
        self.assertIsNotNone(b["createdAt"].tzinfo)

    def test_tool_chain_preserved_and_incomplete_chain_rejected(self):
        payload = self.payload("function-call-bad-case.json")
        document = build_document(payload, bad=True)
        self.assertEqual(payload["functionCall"]["history"], document["definition"]["functionCall"]["history"])
        payload["functionCall"]["history"].pop()
        with self.assertRaisesRegex(ValueError, "缺少工具结果"):
            build_document(payload, bad=True)

    def test_bad_output_and_source_are_validated(self):
        for field, value in [("observedOutput", ""), ("observedOutput", "汉" * 400000), ("outputFormat", "html")]:
            with self.subTest(field=field):
                p = self.payload()
                p["badCase"][field] = value
                with self.assertRaises(ValueError):
                    build_document(p, bad=True)
        p = self.payload()
        p["badCase"].update(outputFormat="json", observedOutput="not json")
        with self.assertRaises(ValueError):
            build_document(p, bad=True)
        p = self.payload()
        p["source"]["url"] = "javascript:alert(1)"
        with self.assertRaises(ValueError):
            build_document(p, bad=True)

    def test_wrong_entry_and_unsupported_role_never_silently_drop(self):
        with self.assertRaises(ValueError):
            build_document(self.payload())
        p = self.payload("single-turn.json")
        p["history"] = [{"role": "tool", "content": "result"}]
        with self.assertRaises(ValueError):
            build_document(p)
        p = self.payload("single-turn.json")
        p["defaults"]["headers"] = {"Authorization": "secret"}
        with self.assertRaises(ValueError):
            build_document(p)

    def test_diagnostics_do_not_include_document_values(self):
        details = {"operatorName": "$jsonSchema", "schemaRulesNotSatisfied": [{"operatorName": "properties", "propertiesNotSatisfied": [{"propertyName": "definition", "details": [{"operatorName": "required", "consideredValue": "SECRET"}]}]}]}
        result = validation_rules(details)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertIn({"path": "definition", "rule": "required"}, result)


if __name__ == "__main__":
    unittest.main()
