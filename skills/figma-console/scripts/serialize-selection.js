// Pass this source as figma_execute's `code` to save the currently selected
// frame. It intentionally serializes only portable visual/prototype fields.
return (() => {
  const mixed = figma.mixed;
  const seen = new Set();
  const safe = (value) => {
    if (value === mixed || value === undefined || typeof value === "function") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(safe);
    if (typeof value === "object") {
      if (seen.has(value)) return null;
      seen.add(value);
      const out = {};
      for (const key of Object.keys(value)) {
        const result = safe(value[key]);
        if (result !== null || value[key] === null) out[key] = result;
      }
      seen.delete(value);
      return out;
    }
    return null;
  };
  const style = (node) => {
    const out = {};
    const fontName = node.fontName;
    if (fontName !== mixed && fontName && fontName.family) {
      out.fontFamily = safe(fontName.family);
      out.fontStyle = safe(fontName.style);
    }
    const keys = ["fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlignHorizontal", "textAlignVertical"];
    for (const key of keys) if (node[key] !== undefined && node[key] !== mixed) out[key] = safe(node[key]);
    return out;
  };
  const serialize = (node) => {
    const out = {
      id: node.id, name: node.name, type: node.type,
      absoluteBoundingBox: safe(node.absoluteBoundingBox), fills: safe(node.fills),
      strokes: safe(node.strokes), effects: safe(node.effects),
      strokeWeight: safe(node.strokeWeight),
      cornerRadius: safe(node.cornerRadius), opacity: safe(node.opacity),
      visible: safe(node.visible), clipsContent: safe(node.clipsContent),
      reactions: safe(node.reactions), children: [],
    };
    if (node.type === "TEXT") {
      out.characters = safe(node.characters);
      out.style = style(node);
    }
    if (Array.isArray(node.children)) out.children = node.children.map(serialize);
    return out;
  };
  const selected = figma.currentPage.selection[0];
  return selected ? serialize(selected) : null;
})()
