// ------------------------------------------------------------ DOM helpers

export function el(tag, props, kids) {
  const node = document.createElement(tag);
  for (const key in props || {}) {
    if (key === "class") node.className = props[key];
    else if (key === "text") node.textContent = props[key];
    else node.setAttribute(key, props[key]);
  }
  (kids || []).forEach(function (kid) {
    node.appendChild(kid);
  });
  return node;
}

// `width` is the line's, for the few glyphs that are not drawn at 1.75.
export function icon(d, width) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const path = document.createElementNS(NS, "path");
  const attrs = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" };
  for (const key in attrs) svg.setAttribute(key, attrs[key]);
  const stroke = { d: d, stroke: "currentColor", "stroke-width": width || 1.75, "stroke-linecap": "round", "stroke-linejoin": "round" };
  for (const key in stroke) path.setAttribute(key, stroke[key]);
  svg.appendChild(path);
  return svg;
}

export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// Make `parent` hold exactly `wanted`, in order, touching only the nodes
// that are out of place.
export function sync(parent, wanted) {
  wanted.forEach(function (node, i) {
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null);
  });
  while (parent.children.length > wanted.length) parent.removeChild(parent.lastChild);
}

export function contains(parent, node) {
  for (let n = node; n; n = n.parentNode) if (n === parent) return true;
  return false;
}

