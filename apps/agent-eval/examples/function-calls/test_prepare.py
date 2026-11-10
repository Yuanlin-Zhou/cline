"""Preparation must expose upload errors without replacing an existing bound suite."""
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from uuid import uuid4

from prepare import prepare

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT.parent / "importable" / "function-call-basic.json"


@contextlib.contextmanager
def upload_server(status=201, error_body=None):
    uploads = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            uploads.append(payload)
            body = error_body
            if body is None:
                body = json.dumps({"id": "uploaded-" + str(uuid4())}).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_port), uploads
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


class PrepareTests(unittest.TestCase):
    def test_json_and_plain_http_errors_preserve_previous_output(self):
        for body, expected in [
            (json.dumps({"error": "Python 脚本语法或入口无效：gbk 解码失败"}, ensure_ascii=False).encode("utf-8"), "gbk 解码失败"),
            (b"<html>proxy rejected request</html>", "proxy rejected request"),
        ]:
            with self.subTest(body=body), TemporaryDirectory() as folder:
                output = Path(folder) / "bound.json"
                output.write_text("previous suite", encoding="utf-8")
                with upload_server(400, body) as (url, uploads):
                    with self.assertRaises(RuntimeError) as raised:
                        prepare(url, TEMPLATE, output)
                    self.assertIn("verify_read_files.py", str(raised.exception))
                    self.assertIn("HTTP 400", str(raised.exception))
                    self.assertIn(expected, str(raised.exception))
                    self.assertEqual(len(uploads), 1)
                self.assertEqual(output.read_text(encoding="utf-8"), "previous suite")

    def test_success_uploads_all_six_utf8_sources_and_binds_actual_ids(self):
        with TemporaryDirectory() as folder, upload_server() as (url, uploads):
            output = Path(folder) / "bound.json"
            prepare(url, TEMPLATE, output)
            suite = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(len(uploads), 6)
            self.assertTrue(all("调用格式" in upload["label"] for upload in uploads))
            self.assertTrue(all("def verify(ctx)" in upload["content"] for upload in uploads))
            for case in suite["cases"]:
                for rule in case["grading"]["rules"]:
                    self.assertTrue(rule["verifierId"].startswith("uploaded-"))


if __name__ == "__main__":
    unittest.main()
