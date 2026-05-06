from __future__ import annotations

import json
import re
import subprocess
import sys


def extract_doc_id(value: str) -> str:
    match = re.search(r"/d/([a-zA-Z0-9_-]+)", value)
    return match.group(1) if match else value


def get_doc(document_id: str) -> dict:
    proc = subprocess.run(
        ["gws", "docs", "documents", "get", "--params", json.dumps({"documentId": document_id})],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or proc.stdout.strip() or "gws get failed")
    return json.loads(proc.stdout)


def walk_paragraphs(content: list[dict]):
    for item in content:
        if "paragraph" in item:
            yield item["paragraph"]
        if "table" in item:
            for row in item["table"].get("tableRows", []):
                for cell in row.get("tableCells", []):
                    yield from walk_paragraphs(cell.get("content", []))


def main() -> int:
    document_id = extract_doc_id(sys.argv[1])
    doc = get_doc(document_id)
    content = doc["body"]["content"]
    has_heading_1 = any(p.get("paragraphStyle", {}).get("namedStyleType") == "HEADING_1" for p in walk_paragraphs(content))
    has_bullets = any("bullet" in p for p in walk_paragraphs(content))
    has_table = any(len(item.get("table", {}).get("tableRows", [])) >= 2 for item in content if "table" in item)
    has_image = len(doc.get("inlineObjects", {})) >= 1
    if all([has_heading_1, has_bullets, has_table, has_image]):
        print("PASS")
        return 0
    print(
        "FAIL",
        json.dumps(
            {
                "has_heading_1": has_heading_1,
                "has_bullets": has_bullets,
                "has_table": has_table,
                "has_image": has_image,
            },
            indent=2,
        ),
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
