#!/usr/bin/env python3
"""Download the public source data into raw/ and record what was downloaded.

Sources (all public):
  * Paper Copilot paper lists (CC BY 4.0): decisions and final scores for ICLR 2024-2026.
  * Paper Copilot iclr-insights (CC BY 4.0): each reviewer's score before and after the
    rebuttal for ICLR 2024 and 2025 (arXiv:2511.15462).
  * ICLR 2027 Rebuttal Radar (dipta007): the 2027 score distributions, first day and now.

Run:  python3 pipeline/fetch.py   (add --force to download again)
"""
import argparse
import hashlib
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"

PC = "https://media.githubusercontent.com/media/papercopilot/paperlists/main/iclr"
INS = "https://raw.githubusercontent.com/papercopilot/iclr-insights/main/dataset"
RADAR = "https://dipta007.github.io/iclr-2027-rebuttal-radar/data"

SOURCES = {
    "iclr2024.json": f"{PC}/iclr2024.json",
    "iclr2025.json": f"{PC}/iclr2025.json",
    "iclr2026.json": f"{PC}/iclr2026.json",
    "iclr2024_threshold6_7407_reviewers.json": f"{INS}/iclr2024_threshold6_7407_reviewers.json",
    "iclr2025_threshold6_11677_reviewers.json": f"{INS}/iclr2025_threshold6_11677_reviewers.json",
    "site.json": f"{RADAR}/site.json",
}
ALWAYS_REFRESH = {"site.json"}  # the 2027 data changes every 12 hours


def download(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": "iclr-ac-simulator/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    if data.startswith(b"version https://git-lfs"):
        raise RuntimeError(f"{url} returned a Git LFS pointer, not the file")
    json.loads(data)  # must be valid JSON
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    RAW.mkdir(exist_ok=True)
    manifest = {"fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "files": {}}
    for name, url in SOURCES.items():
        path = RAW / name
        if args.force or name in ALWAYS_REFRESH or not path.exists():
            print(f"downloading {name}", flush=True)
            data = download(url, path)
        else:
            data = path.read_bytes()
        manifest["files"][name] = {
            "url": url,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    (RAW / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"ok: {len(SOURCES)} files in {RAW}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
