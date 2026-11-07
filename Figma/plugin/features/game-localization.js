async function gameTree(root, maxNodes) {
  if (root.type === 'DOCUMENT') throw new Error('Use a page or subtree, not the document root.');
  if (root.type === 'PAGE') await root.loadAsync();
  const nodes = [], stack = [root];
  while (stack.length) {
    if (nodes.length >= maxNodes) throw new Error('Subtree exceeds maxNodes. Choose a smaller root.');
    const node = stack.pop(); nodes.push(node);
    if ('children' in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return nodes;
}

function cloneGameTree(source, parent) {
  const copy = source.clone();
  try {
    parent.appendChild(copy);
    const pairs = [], stack = [[source, copy]], idMap = new Map();
    while (stack.length) {
      const [original, clone] = stack.pop(); pairs.push([original, clone]); idMap.set(original.id, clone.id);
      if ('children' in original) {
        if (!('children' in clone) || original.children.length !== clone.children.length) throw new Error('Clone structure changed.');
        for (let i = 0; i < original.children.length; i++) stack.push([original.children[i], clone.children[i]]);
      }
    }
    function remap(value) {
      if (typeof value === 'string') return idMap.get(value) || value;
      if (Array.isArray(value)) return value.map(remap);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [idMap.get(key) || key, remap(item)]));
      return value;
    }
    for (const [original, clone] of pairs) {
      const raw = original.getPluginData(gameKey);
      if (raw) clone.setPluginData(gameKey, JSON.stringify(remap(gameMetadata(original))));
    }
    return copy;
  } catch (error) { copy.remove(); throw error; }
}

async function localizedText(root, args) {
  const nodes = await gameTree(root, args.maxNodes), plans = [], missing = [];
  for (const node of nodes) {
    if (node.type !== 'TEXT') continue;
    const key = gameMetadata(node).localizationKey;
    if (!key) continue;
    if (!Object.prototype.hasOwnProperty.call(args.translations, key)) { missing.push({ nodeId: node.id, key }); continue; }
    plans.push({ node, key, text: args.translations[key] });
  }
  if (plans.length > 200) throw new Error('Localize at most 200 text nodes per call.');
  const font = args.fontFamily ? { family: args.fontFamily, style: args.fontStyle } : null;
  if (font) await figma.loadFontAsync(font);
  else for (const plan of plans) await loadNodeFonts(plan.node);
  const updated = [], overflow = [], failed = [];
  for (const { node, key, text } of plans) {
    try {
      const fixed = node.textAutoResize === 'NONE', oldHeight = node.height, oldWidth = node.width;
      if (font) node.fontName = font;
      node.characters = text;
      if (fixed && oldWidth > 0) {
        const probe = node.clone();
        try {
          probe.x = -100000; probe.textAutoResize = 'HEIGHT'; probe.resize(oldWidth, Math.max(1, oldHeight));
          if (probe.height > oldHeight + 1) overflow.push({ nodeId: node.id, key, requiredHeight: probe.height, availableHeight: oldHeight });
        } finally { probe.remove(); }
      }
      storeGameMetadata(node, { locale: args.locale }); updated.push(node.id);
    } catch (error) { failed.push({ nodeId: node.id, key, error: error.message }); }
  }
  return { locale: args.locale, updated, missing, overflow, failed, partial: failed.length > 0 };
}

async function executeGameLocalization(command, args) {
  if (command === 'set_localization_key') {
    const node = await getNode(args.nodeId);
    if (node.type !== 'TEXT') throw new Error('Localization keys require a TEXT node.');
    storeGameMetadata(node, { localizationKey: args.key }); figma.commitUndo(); return { nodeId: node.id, key: args.key };
  }
  if (command === 'export_localization') {
    const root = await getNode(args.rootId), nodes = await gameTree(root, args.maxNodes), strings = Object.create(null), conflicts = [], bindings = [];
    for (const node of nodes) {
      if (node.type !== 'TEXT') continue;
      const key = gameMetadata(node).localizationKey;
      if (!key) continue;
      if (Object.prototype.hasOwnProperty.call(strings, key) && strings[key] !== node.characters) conflicts.push({ key, nodeId: node.id, text: node.characters });
      else strings[key] = node.characters;
      bindings.push({ nodeId: node.id, key });
    }
    return boundedGameJson({ version: 1, rootId: root.id, strings, bindings, conflicts });
  }
  if (command === 'apply_localization') {
    const root = await getNode(args.rootId);
    try { return await localizedText(root, args); } finally { figma.commitUndo(); }
  }
  if (command === 'preview_localization') {
    const source = await getNode(args.rootId);
    if (source.type !== 'FRAME') throw new Error('Localization previews require a screen FRAME.');
    await gameTree(source, args.maxNodes);
    const parent = await getParent(source.parent.id), copy = cloneGameTree(source, parent);
    try {
      copy.name = source.name + ' [' + args.locale + ']'; copy.x = source.x + source.width + 64; copy.y = source.y;
      const result = await localizedText(copy, args);
      figma.commitUndo(); return { previewId: copy.id, sourceId: source.id, ...result };
    } catch (error) { copy.remove(); throw error; }
  }
}
