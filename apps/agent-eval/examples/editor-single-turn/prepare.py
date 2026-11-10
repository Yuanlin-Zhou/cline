"""Upload the editor scenario verifier and generate bound, importable history cases."""
import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen


def prepare(url, output):
    root = Path(__file__).resolve().parent
    payload = {"filename": "verify_editor_scenarios.py", "label": "editor 历史上下文与本轮参数验收",
               "content": (root / "verify_editor_scenarios.py").read_text(encoding="utf-8")}
    request = Request(url.rstrip("/") + "/api/verifiers", data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=30) as response:
        verifier_id = json.load(response)["id"]
    suite = json.loads((root / "cases.json").read_text(encoding="utf-8"))
    for case in suite["cases"]:
        case["grading"]["rules"][0]["verifierId"] = verifier_id
    Path(output).write_text(json.dumps(suite, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已上传 editor 场景验证器，请导入 " + str(output))
    print("运行前配置 OpenAI-compatible 模型 ID、baseUrl 和密钥环境变量。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:3130")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    prepare(args.url, args.output)
