"""Upload six standalone scripts and emit an importable suite bound to actual IDs."""
import argparse
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def prepare(url, template, output):
    root = Path(__file__).resolve().parent
    names = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["tools"]
    ids = {}
    for name in names:
        filename = "verify_" + name + ".py"
        payload = {"filename": filename, "label": name + " 调用格式", "content": (root / filename).read_text(encoding="utf-8")}
        request = Request(url.rstrip("/") + "/api/verifiers", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(request, timeout=30) as response:
                ids["example-fc-" + name] = json.load(response)["id"]
        except HTTPError as error:
            detail = error.read(65536).decode("utf-8", errors="replace")
            error.close()
            try:
                parsed = json.loads(detail)
                detail = parsed.get("error", detail) if isinstance(parsed, dict) else detail
            except ValueError:
                pass
            raise RuntimeError(f"上传 {filename} 失败（HTTP {error.code}）：{str(detail or error.reason)[:4000]}") from error
    suite = json.loads(Path(template).read_text(encoding="utf-8"))
    for case in suite["cases"]:
        for rule in case["grading"]["rules"]:
            rule["verifierId"] = ids[rule["verifierId"]]
    Path(output).write_text(json.dumps(suite, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已上传六个验证器；请导入 " + str(output))
    print("请在运行配置中选择 OpenAI-compatible，并填写模型、baseUrl 和密钥环境变量。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:3130")
    parser.add_argument("--template", default=str(Path(__file__).resolve().parent.parent / "importable/function-call-basic.json"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        prepare(args.url, args.template, args.output)
    except RuntimeError as error:
        parser.exit(1, str(error) + "\n")
