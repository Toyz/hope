// sanitizeSvgInner — allowlist filter for plugin-supplied SVG icon markup. Plugin
// icons are UNTRUSTED (they come from a discovered container's manifest), so their
// inner SVG is an XSS vector: <script>, <foreignObject>, external <use>/<image>,
// and on* handlers must never reach the DOM. We parse the fragment in an inert
// document and rebuild it from an element + attribute allowlist, dropping anything
// unrecognized. The result is safe to assign to an <svg>'s innerHTML.
//
// The allowlist is intentionally small — the shape-drawing subset of SVG that a
// 24x24 stroke icon needs. No raster, no text, no references, no scripting.

const ALLOWED_ELEMENTS = new Set([
  "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g",
]);

// Presentation + geometry attributes only. No href/xlink:href (blocks <use>/<image>
// external refs), no event handlers, no style (blocks url()/expression tricks).
const ALLOWED_ATTRS = new Set([
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
  "width", "height", "points", "transform", "fill-rule", "clip-rule",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-dashoffset", "fill", "opacity",
  "fill-opacity", "stroke-opacity", "vector-effect",
]);

// Reject attribute VALUES that could still smuggle a fetch/script even on an allowed
// attribute (e.g. fill="url(http://evil)") — no remote references at all.
function safeValue(v: string): boolean {
  const s = v.toLowerCase();
  return !s.includes("url(") && !s.includes("javascript:") && !s.includes("data:") && !s.includes("expression");
}

function cleanElement(el: Element, out: Document): Element | null {
  const tag = el.tagName.toLowerCase();
  if (!ALLOWED_ELEMENTS.has(tag)) return null;
  const clone = out.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) continue; // event handlers
    if (!ALLOWED_ATTRS.has(name)) continue;
    if (!safeValue(attr.value)) continue;
    clone.setAttribute(name, attr.value);
  }
  for (const child of Array.from(el.children)) {
    const cc = cleanElement(child, out);
    if (cc) clone.appendChild(cc);
  }
  return clone;
}

/** Returns a sanitized SVG inner-markup string, or "" if nothing survived. */
export function sanitizeSvgInner(markup: string): string {
  if (!markup || typeof markup !== "string") return "";
  // Parse as a full SVG so the browser builds a real (inert) DOM we can walk.
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() === "parsererror" || root.querySelector("parsererror")) return "";
  const holder = doc.implementation.createDocument("http://www.w3.org/2000/svg", "svg", null);
  const parts: string[] = [];
  for (const child of Array.from(root.children)) {
    const cc = cleanElement(child, holder);
    if (cc) parts.push(new XMLSerializer().serializeToString(cc));
  }
  return parts.join("");
}
