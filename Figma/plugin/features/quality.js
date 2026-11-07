function luminance(color) {
  const channel = value => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function solidColor(node) {
  if (node.opacity !== undefined && node.opacity !== 1) return null;
  if (node.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) return null;
  const paints = Array.isArray(node.fills) ? node.fills.filter(paint => paint.visible !== false) : [];
  if (paints.length !== 1 || paints[0].type !== 'SOLID' || (paints[0].opacity !== undefined && paints[0].opacity !== 1)) return null;
  if (paints[0].blendMode && paints[0].blendMode !== 'NORMAL') return null;
  return paints[0].color;
}

function textBackground(node) {
  let background;
  for (let parent = node.parent; parent && parent.type !== 'DOCUMENT'; parent = parent.parent) {
    if (parent.opacity !== undefined && parent.opacity !== 1) return null;
    if (parent.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(parent.blendMode)) return null;
    if (parent.effects && parent.effects.some(effect => effect.visible !== false)) return null;
    const fills = Array.isArray(parent.fills) ? parent.fills.filter(paint => paint.visible !== false) : [];
    if (!background && fills.length) { background = solidColor(parent); if (!background) return null; }
  }
  return background;
}

async function auditDesign(args) {
  const root = args.rootId ? await getNode(args.rootId) : figma.currentPage;
  if (root.type === 'DOCUMENT') throw new Error('Audit one page or subtree at a time.');
  if (root.type === 'PAGE') await root.loadAsync();
  const stack = [root], issues = [];
  let scanned = 0, skippedContrast = 0, checkedContrast = 0, issueTotal = 0;
  function issue(node, code, detail) {
    issueTotal++;
    if (issues.length < 200) issues.push({ nodeId: node.id, name: node.name, code, detail });
  }
  while (stack.length && scanned < args.maxNodes) {
    const node = stack.pop(); scanned++;
    if (node.visible === false) continue;
    if ('children' in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    for (const key of ['itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
      const value = node[key];
      if (typeof value === 'number' && Math.abs(value / args.spacingStep - Math.round(value / args.spacingStep)) > 0.001) issue(node, 'SPACING_GRID', { property: key, value, spacingStep: args.spacingStep });
    }
    if (node.type !== 'TEXT') continue;
    if (typeof node.fontSize === 'number' && node.fontSize < 12) issue(node, 'SMALL_TEXT', { fontSize: node.fontSize, note: 'Readability heuristic, not a WCAG minimum-size rule.' });
    const parent = node.parent;
    if (parent && parent.clipsContent && (!node.rotation || node.rotation === 0) &&
      (node.x < 0 || node.y < 0 || node.x + node.width > parent.width || node.y + node.height > parent.height)) {
      issue(node, 'TEXT_CLIPPED_BOUNDS', { parentId: parent.id, note: 'Text node bounds exceed a clipping parent; glyph overflow inside the text box is not measured.' });
    }
    const foreground = solidColor(node), background = textBackground(node);
    if (!foreground || !background || typeof node.fontSize !== 'number' || !node.fontName || typeof node.fontName !== 'object' || (node.effects && node.effects.some(effect => effect.visible !== false))) { skippedContrast++; continue; }
    checkedContrast++;
    const a = luminance(foreground), b = luminance(background), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const bold = typeof node.fontWeight === 'number' ? node.fontWeight >= 700
      : (node.fontName.variationSettings && node.fontName.variationSettings.wght >= 700) || /bold|black|heavy/i.test(node.fontName.style);
    const minimum = node.fontSize >= 24 || (node.fontSize >= 18.6667 && bold) ? 3 : 4.5;
    if (ratio < minimum) issue(node, 'LOW_CONTRAST', { ratio: Math.round(ratio * 100) / 100, minimum });
  }
  return { scanned, truncated: stack.length > 0, issues, issueTotal, checkedContrast, skippedContrast,
    limitations: ['Heuristic audit, not complete visual or accessibility certification.', 'Contrast excludes complex paints, opacity, effects, blend modes and mixed fonts; overlapping siblings are not evaluated.', 'Spacing-grid findings require design judgment.', 'Checks text node bounds, not rendered glyph overflow inside text boxes.'] };
}
