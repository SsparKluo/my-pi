#!/usr/bin/env python3
"""Convert the bash-classify command database (166 YAML files) into src/grade/commands.json.

Source: https://github.com/fprochazka/bash-classify (MIT) — clone it and run:
    python3 scripts/convert-bash-classify-db.py /path/to/bash-classify
"""
import glob
import json
import sys
from pathlib import Path

import yaml  # dev-time only

def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/bash-classify-src")
    out = Path(__file__).resolve().parent.parent / "src" / "grade" / "commands.json"
    defs = {}
    for path in sorted(glob.glob(str(src / "src/bash_classify/commands/*.yaml"))):
        with open(path) as f:
            d = yaml.safe_load(f)
        defs[d["command"]] = d
    out.write_text(json.dumps(defs, separators=(",", ":")))
    print(f"wrote {len(defs)} commands to {out}")

if __name__ == "__main__":
    main()
