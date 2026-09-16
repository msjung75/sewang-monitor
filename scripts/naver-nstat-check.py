#!/usr/bin/env python3
"""Compatibility entry point for the shared v18 evidence checker.

Existing scheduled workflow and credentials are retained. Node 18+ required.
No matching decisions are made in this wrapper.
"""
import pathlib
import subprocess
import sys

if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parents[1]
    sys.exit(subprocess.call(["node", str(root / "scripts/naver-evidence-check.cjs")], cwd=root))
