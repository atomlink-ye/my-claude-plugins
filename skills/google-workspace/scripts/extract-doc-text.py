#!/usr/bin/env python3
"""Extract plain text from a Google Docs API JSON response.

Reads gws output from stdin, skips any preamble lines (e.g. keyring
backend notices), parses the document JSON, and prints the text content.

Usage:
    gws docs documents get --params '{"documentId": "DOC_ID"}' | python3 extract-doc-text.py
"""

import json
import sys


def extract_text(node):
    """Recursively extract text content strings from a Docs JSON structure."""
    texts = []
    if isinstance(node, dict):
        if "content" in node and isinstance(node["content"], str):
            texts.append(node["content"])
        for k, v in node.items():
            if k != "content" or not isinstance(v, str):
                texts.extend(extract_text(v))
    elif isinstance(node, list):
        for item in node:
            texts.extend(extract_text(item))
    return texts


def main():
    raw = sys.stdin.read()
    # Skip non-JSON preamble lines (e.g. "Using keyring backend: ...")
    lines = raw.splitlines(keepends=True)
    json_start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            json_start = i
            break
    json_text = "".join(lines[json_start:])

    try:
        data = json.loads(json_text)
    except json.JSONDecodeError as e:
        print(f"Error: could not parse JSON: {e}", file=sys.stderr)
        sys.exit(1)

    text = "".join(extract_text(data))
    if text:
        print(text, end="")


if __name__ == "__main__":
    main()
