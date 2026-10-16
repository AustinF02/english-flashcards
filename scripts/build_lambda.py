"""Build the Lambda deployment zip: index.py + handler.py + cards.json.

boto3 ships in the Lambda Python runtime, so no third-party packages are bundled.
The zip is deterministic (fixed timestamps, sorted entries) and is named by the
first 16 hex chars of its SHA-256, so the S3 key changes only when content does.

Usage: python3 scripts/build_lambda.py [out_dir]   # default: dist-lambda/
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
import zipfile

ROOT = os.path.join(os.path.dirname(__file__), "..")
BACKEND = os.path.join(ROOT, "backend")
FILES = [("index.py", os.path.join(BACKEND, "index.py")),
         ("handler.py", os.path.join(BACKEND, "handler.py")),
         ("cards.json", os.path.join(ROOT, "cards.json"))]
EPOCH = (1980, 1, 1, 0, 0, 0)   # fixed so identical content gives an identical zip


def build(out_dir: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, "progress.tmp.zip")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for arcname, src in sorted(FILES):
            if not os.path.exists(src):
                sys.exit(f"missing {src} (run: npx vite-node scripts/export_cards.ts)")
            info = zipfile.ZipInfo(arcname, EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(src, "rb") as f:
                z.writestr(info, f.read())
    digest = hashlib.sha256(open(tmp, "rb").read()).hexdigest()
    final = os.path.join(out_dir, f"progress-{digest[:16]}.zip")
    shutil.move(tmp, final)
    return final


if __name__ == "__main__":
    path = build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist-lambda"))
    print(path)
