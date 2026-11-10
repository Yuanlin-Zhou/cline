"""Compatibility loader; canonical source moved to apps/agent-eval."""
from pathlib import Path
import runpy
import sys
_source = Path(__file__).resolve().parents[4] / "agent-eval" / "examples" / "python-mongodb-import"
if str(_source) not in sys.path:
    sys.path.insert(0, str(_source))
if __name__ == "__main__":
    runpy.run_path(str(_source / "import_cases.py"), run_name="__main__")
else:
    globals().update({k: v for k, v in runpy.run_path(str(_source / "import_cases.py")).items() if not k.startswith("__")})
