#!/usr/bin/env python3
"""Export a Figma frame JSON read-back to deterministic nested HTML/CSS."""

from __future__ import annotations

import argparse
import html
import json
import math
import sys
from pathlib import Path
from typing import Any


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


class Exporter:
    """Best-effort exporter. Unsupported values warn and never abort a frame."""

    _KNOWN = {
        "id", "name", "type", "visible", "opacity", "absoluteBoundingBox", "box", "width", "height",
        "fills", "strokes", "strokeWeight", "cornerRadius", "effects", "children", "characters", "style", "reactions",
        "document", "nodes", "clipsContent", "blendMode", "layoutMode", "relativeTransform", "size",
        "absoluteRenderBounds", "componentPropertyReferences",
    }

    def __init__(self, payload: Any) -> None:
        self.warnings: list[str] = []
        self.synthetic = False
        self.root, top_nodes = self._normalize(payload)
        self.root_origin = self._origin(self.root, top_nodes)
        self.records: list[dict[str, Any]] = []
        self._walk(self.root, None, 0.0, 0.0)

    def _note(self, message: str) -> None:
        self.warnings.append(message)
        warn(message)

    @staticmethod
    def _number(value: Any, default: float = 0.0) -> float:
        try:
            result = float(value)
            return result if math.isfinite(result) else default
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _entry_node(entry: Any) -> dict[str, Any] | None:
        if not isinstance(entry, dict):
            return None
        document = entry.get("document")
        if isinstance(document, dict):
            return document
        return entry

    def _normalize(self, payload: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if isinstance(payload, dict) and isinstance(payload.get("result"), (dict, list)):
            payload = payload["result"]
        if isinstance(payload, dict) and isinstance(payload.get("document"), dict):
            payload = payload["document"]
        if isinstance(payload, dict) and "type" in payload:
            return payload, [payload]
        if isinstance(payload, dict) and "nodes" in payload:
            raw = payload["nodes"]
            entries = list(raw.values()) if isinstance(raw, dict) else raw if isinstance(raw, list) else []
            if not isinstance(raw, (dict, list)):
                self._note("nodes wrapper is neither a list nor an ID mapping")
            top_nodes = []
            for entry in entries:
                node = self._entry_node(entry)
                if node:
                    top_nodes.append(node)
                else:
                    self._note("ignored non-object nodes wrapper entry")
            self.synthetic = True
            return {"id": "root", "name": "Frame", "type": "FRAME", "children": top_nodes}, top_nodes
        self._note("input root is not an object with a supported type; exporting an empty frame")
        self.synthetic = True
        return {"id": "root", "name": "Frame", "type": "FRAME", "children": []}, []

    def _absolute_box(self, node: dict[str, Any]) -> dict[str, Any] | None:
        box = node.get("absoluteBoundingBox")
        return box if isinstance(box, dict) and "x" in box and "y" in box else None

    def _origin(self, root: dict[str, Any], top_nodes: list[dict[str, Any]]) -> tuple[float, float]:
        if not self.synthetic:
            box = self._absolute_box(root)
            if box:
                return self._number(box["x"]), self._number(box["y"])
        boxes = [self._absolute_box(node) for node in top_nodes]
        boxes = [box for box in boxes if box is not None]
        if boxes:
            return min(self._number(box["x"]) for box in boxes), min(self._number(box["y"]) for box in boxes)
        return 0.0, 0.0

    def _local_geometry(self, node: dict[str, Any], parent_global: tuple[float, float], is_root: bool) -> tuple[float, float, float, float, float, float]:
        absolute = self._absolute_box(node)
        if absolute:
            gx, gy = self._number(absolute["x"]) - self.root_origin[0], self._number(absolute["y"]) - self.root_origin[1]
            width, height = max(0.0, self._number(absolute.get("width"))), max(0.0, self._number(absolute.get("height")))
            return (0.0 if is_root else gx - parent_global[0], 0.0 if is_root else gy - parent_global[1], width, height, gx, gy)
        box = node.get("box")
        if isinstance(box, dict):
            left = self._number(box.get("x", box.get("left", 0)))
            top = self._number(box.get("y", box.get("top", 0)))
            width, height = max(0.0, self._number(box.get("width"))), max(0.0, self._number(box.get("height")))
            return left, top, width, height, parent_global[0] + left, parent_global[1] + top
        if not (is_root and self.synthetic):
            self._note(f"node {node.get('id', '<unknown>')} has no supported geometry")
        return 0.0, 0.0, max(0.0, self._number(node.get("width"))), max(0.0, self._number(node.get("height"))), parent_global[0], parent_global[1]

    def _walk(self, node: dict[str, Any], parent: dict[str, Any] | None, parent_global_x: float, parent_global_y: float) -> dict[str, Any]:
        for key in sorted(set(node) - self._KNOWN):
            self._note(f"unsupported node field {key!r} on {node.get('id', '<unknown>')}")
        left, top, width, height, gx, gy = self._local_geometry(node, (parent_global_x, parent_global_y), parent is None)
        record = {"node": node, "left": left, "top": top, "gx": gx, "gy": gy, "width": width, "height": height, "children": [], "number": len(self.records) + 1}
        self.records.append(record)
        children = node.get("children", [])
        if children is not None and not isinstance(children, list):
            self._note(f"node {node.get('id', '<unknown>')} children is not a list")
            children = []
        for child in children:
            if isinstance(child, dict):
                record["children"].append(self._walk(child, node, gx, gy))
            else:
                self._note("ignored non-object child")
        return record

    @staticmethod
    def _fmt(value: float) -> str:
        if abs(value - round(value)) < 1e-9:
            return str(int(round(value)))
        return f"{value:.3f}".rstrip("0").rstrip(".")

    @staticmethod
    def _color(value: Any, alpha: float = 1.0) -> str | None:
        if not isinstance(value, dict):
            return None
        try:
            rgb = [max(0, min(255, round(float(value.get(channel, 0)) * 255))) for channel in ("r", "g", "b")]
            opacity = max(0.0, min(1.0, float(value.get("a", alpha))))
        except (TypeError, ValueError):
            return None
        if opacity == 1:
            return "#%02x%02x%02x" % tuple(rgb)
        return f"rgba({rgb[0]}, {rgb[1]}, {rgb[2]}, {opacity:.3f})"

    def _paint(self, paints: Any, label: str) -> str | None:
        if not isinstance(paints, list):
            return None
        for paint in paints:
            if not isinstance(paint, dict) or paint.get("visible", True) is False:
                continue
            if paint.get("type") != "SOLID":
                self._note(f"unsupported {label} paint type: {paint.get('type', '<unknown>')}")
                continue
            paint_opacity = max(0.0, min(1.0, self._number(paint.get("opacity", 1), 1)))
            raw_color = paint.get("color")
            color_value = dict(raw_color) if isinstance(raw_color, dict) else raw_color
            if isinstance(color_value, dict):
                color_value["a"] = self._number(color_value.get("a", 1), 1) * paint_opacity
            color = self._color(color_value)
            if color:
                return color
        return None

    def _shadows(self, effects: Any) -> list[str]:
        output = []
        if not isinstance(effects, list):
            return output
        for effect in effects:
            if not isinstance(effect, dict) or effect.get("visible", True) is False:
                continue
            kind = effect.get("type")
            if kind not in {"DROP_SHADOW", "INNER_SHADOW"}:
                self._note(f"unsupported effect type: {kind or '<unknown>'}")
                continue
            offset = effect.get("offset") if isinstance(effect.get("offset"), dict) else {}
            color = self._color(effect.get("color")) or "rgba(0, 0, 0, 0.25)"
            prefix = "inset " if kind == "INNER_SHADOW" else ""
            output.append(f"{prefix}{self._fmt(self._number(offset.get('x')))}px {self._fmt(self._number(offset.get('y')))}px {self._fmt(self._number(effect.get('radius')))}px {self._fmt(self._number(effect.get('spread')))}px {color}")
        return output

    def _safe_font(self, value: Any) -> str | None:
        if not isinstance(value, str) or any(ord(char) < 32 for char in value):
            self._note("ignored unsafe fontFamily")
            return None
        return json.dumps(value, ensure_ascii=True)

    def _styles(self, record: dict[str, Any], root: bool = False) -> list[str]:
        node = record["node"]
        styles = ["box-sizing:border-box"] if root else ["position:absolute", "box-sizing:border-box", f"left:{self._fmt(record['left'])}px", f"top:{self._fmt(record['top'])}px"]
        styles.extend([f"width:{self._fmt(record['width'])}px", f"height:{self._fmt(record['height'])}px"])
        if node.get("visible", True) is False:
            styles.append("display:none")
        if "opacity" in node:
            styles.append(f"opacity:{self._fmt(max(0.0, min(1.0, self._number(node['opacity'], 1))))}")
        if node.get("clipsContent") is True:
            styles.append("overflow:hidden")
        fill = self._paint(node.get("fills"), "fill")
        if fill:
            styles.append(("color:" if node.get("type") == "TEXT" else "background-color:") + fill)
        stroke = self._paint(node.get("strokes"), "stroke")
        if stroke:
            styles.extend([f"border:1px solid {stroke}", f"border-color:{stroke}"])
        if "strokeWeight" in node:
            styles.append(f"border-width:{self._fmt(self._number(node['strokeWeight']))}px")
        if "cornerRadius" in node:
            styles.append(f"border-radius:{self._fmt(max(0.0, self._number(node['cornerRadius'])))}px")
        shadows = self._shadows(node.get("effects"))
        if shadows:
            styles.append("box-shadow:" + ", ".join(shadows))
        if node.get("type") == "TEXT":
            style = node.get("style") if isinstance(node.get("style"), dict) else {}
            family = self._safe_font(style.get("fontFamily"))
            if family:
                styles.append(f"font-family:{family}")
            font_style = style.get("fontStyle")
            font_style_name = font_style.lower() if isinstance(font_style, str) else ""
            if "italic" in font_style_name:
                styles.append("font-style:italic")
            elif "oblique" in font_style_name:
                styles.append("font-style:oblique")
            weight = style.get("fontWeight")
            if weight is None and font_style_name:
                named_weights = (
                    ("thin", 100), ("extra light", 200), ("ultra light", 200),
                    ("light", 300), ("medium", 500), ("semi bold", 600),
                    ("demi bold", 600), ("extra bold", 800), ("ultra bold", 800),
                    ("black", 900), ("heavy", 900), ("bold", 700), ("regular", 400),
                )
                weight = next((value for name, value in named_weights if name in font_style_name), None)
            if isinstance(weight, (int, float)) and not isinstance(weight, bool):
                styles.append(f"font-weight:{max(100, min(900, int(weight)))}")
            elif isinstance(weight, str) and weight.lower() in {"normal", "bold", "bolder", "lighter", "inherit", "initial"}:
                styles.append(f"font-weight:{weight.lower()}")
            elif weight is not None:
                self._note("ignored unsafe fontWeight")
            if "fontSize" in style:
                styles.append(f"font-size:{self._fmt(self._number(style['fontSize']))}px")
            if "letterSpacing" in style:
                spacing = style["letterSpacing"]
                if isinstance(spacing, dict):
                    unit = str(spacing.get("unit", "PIXELS")).upper()
                    value = self._number(spacing.get("value", 0))
                    suffix = "%" if "%" in unit or "PERCENT" in unit else "px"
                    styles.append(f"letter-spacing:{self._fmt(value)}{suffix}")
                elif isinstance(spacing, (int, float)) and not isinstance(spacing, bool):
                    styles.append(f"letter-spacing:{self._fmt(self._number(spacing))}px")
            if "lineHeightPx" in style:
                styles.append(f"line-height:{self._fmt(self._number(style['lineHeightPx']))}px")
            elif "lineHeightPercent" in style:
                styles.append(f"line-height:{self._fmt(self._number(style['lineHeightPercent']))}%")
            elif "lineHeight" in style:
                line_height = style["lineHeight"]
                if isinstance(line_height, dict):
                    unit = str(line_height.get("unit", "PIXELS")).upper()
                    value = self._number(line_height.get("value", 0))
                    if unit in {"AUTO", "INTRINSIC_%"}:
                        styles.append("line-height:normal")
                    else:
                        styles.append(f"line-height:{self._fmt(value)}{'%' if '%' in unit or 'PERCENT' in unit else 'px'}")
                elif isinstance(line_height, (int, float)):
                    styles.append(f"line-height:{self._fmt(self._number(line_height))}px")
            align = str(style.get("textAlignHorizontal", style.get("textAlign", ""))).lower()
            if align in {"left", "right", "center", "justify", "start", "end"}:
                styles.append(f"text-align:{align}")
            elif align:
                self._note("ignored unsafe text alignment")
            styles.append("white-space:pre-wrap")
        return styles

    def _render_node(self, record: dict[str, Any], root: bool = False) -> str:
        node = record["node"]
        ident = f"figma-e-{record['number']:04d}"
        attrs = (
            f'id="{ident}" class="figma-element" '
            f'data-figma-id="{html.escape(str(node.get("id", "")), quote=True)}" '
            f'data-figma-name="{html.escape(str(node.get("name", "")), quote=True)}" '
            f'data-figma-type="{html.escape(str(node.get("type", "UNKNOWN")), quote=True)}"'
        )
        text = node.get("characters", "") if node.get("type") == "TEXT" else ""
        children = "".join(self._render_node(child) for child in record["children"])
        return f"<div {attrs}>{html.escape(str(text))}{children}</div>"

    def render(self, html_name: str, css_name: str) -> tuple[str, str]:
        root = self.records[0]
        if self.synthetic and len(self.records) > 1:
            content = self.records[1:]
            min_x = min(record["gx"] for record in content)
            min_y = min(record["gy"] for record in content)
            max_x = max(record["gx"] + record["width"] for record in content)
            max_y = max(record["gy"] + record["height"] for record in content)
            for child in root["children"]:
                child["left"] -= min_x
                child["top"] -= min_y
            width = max(0.0, max_x - min_x)
            height = max(0.0, max_y - min_y)
        else:
            width = root["width"]
            height = root["height"]
        root["width"], root["height"] = width, height
        root_rules = ["position:relative"] + self._styles(root, root=True)
        css = ["/* generated by figma-console export.py; deterministic */", "*, *::before, *::after { box-sizing:border-box; }", f".figma-root {{ {'; '.join(root_rules)}; }}"]
        for index, record in enumerate(self.records):
            declarations = "; ".join(self._styles(record, root=record is root))
            css.append(f"#figma-e-{index + 1:04d} {{ {declarations}; }}")
        root_node = root["node"]
        root_attrs = f'data-figma-id="{html.escape(str(root_node.get("id", "")), quote=True)}" data-figma-name="{html.escape(str(root_node.get("name", "")), quote=True)}" data-figma-type="{html.escape(str(root_node.get("type", "FRAME")), quote=True)}"'
        document = "<!doctype html>\n<html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"" + html.escape(css_name, quote=True) + "\"></head><body><div id=\"figma-root\" class=\"figma-root\" " + root_attrs + ">" + "".join(self._render_node(child) for child in root["children"]) + "</div></body></html>\n"
        return document, "\n".join(css) + "\n"


def valid_basename(value: str) -> bool:
    return bool(value) and value not in {".", ".."} and not Path(value).is_absolute() and "/" not in value and "\\" not in value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("frame_json", type=Path)
    parser.add_argument("--out-dir", type=Path, default=Path("."))
    parser.add_argument("--html", default="frame.html")
    parser.add_argument("--css", default="frame.css")
    args = parser.parse_args()
    if not valid_basename(args.html) or not valid_basename(args.css) or args.html == args.css:
        print("error: --html and --css must be distinct single basenames", file=sys.stderr)
        return 2
    try:
        payload = json.loads(args.frame_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read frame JSON: {exc}", file=sys.stderr)
        return 2
    if isinstance(payload, dict):
        wrapper = any(key in payload for key in ("_mcp", "success", "resultAnalysis")) or (
            "result" in payload and "type" not in payload
        )
        if wrapper and payload.get("success") is False:
            print("error: MCP response reports success=false", file=sys.stderr)
            return 2
        if wrapper and payload.get("error"):
            print(f"error: MCP response contains an error: {payload['error']}", file=sys.stderr)
            return 2
        analysis = payload.get("resultAnalysis")
        if isinstance(analysis, dict) and analysis.get("warning"):
            print(f"error: resultAnalysis.warning is non-empty; read-back cannot be accepted: {analysis['warning']}", file=sys.stderr)
            return 2
        if wrapper and ("result" not in payload or not isinstance(payload.get("result"), (dict, list))):
            print("error: MCP response has no exportable object/list result", file=sys.stderr)
            return 2
    exporter = Exporter(payload)
    document, css = exporter.render(args.html, args.css)
    try:
        args.out_dir.mkdir(parents=True, exist_ok=True)
        (args.out_dir / args.html).write_text(document, encoding="utf-8")
        (args.out_dir / args.css).write_text(css, encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot write export: {exc}", file=sys.stderr)
        return 2
    print(f"exported {len(exporter.records)} elements to {args.out_dir / args.html} and {args.out_dir / args.css}; warnings={len(exporter.warnings)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
