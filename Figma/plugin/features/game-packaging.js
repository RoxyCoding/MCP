function boundedGameJson(data) {
  if (JSON.stringify(data).length > 2 * 1024 * 1024) throw new Error('Game JSON is too large. Choose a smaller subtree.');
  return data;
}

function auditFocusGraph(root, nodes) {
  const focus = gameMetadata(root).focus;
  if (!focus || !focus.links || typeof focus.links !== 'object' || Array.isArray(focus.links)) throw new Error('No valid focus graph on this root.');
  const ids = Object.keys(focus.links);
  if (ids.length > 1000) throw new Error('Focus graph is too large.');
  const known = new Map(nodes.map(node => [node.id, node])), issues = [], directions = { up: 'down', down: 'up', left: 'right', right: 'left' };
  if (!ids.includes(focus.defaultNodeId)) issues.push({ code: 'INVALID_DEFAULT', nodeId: focus.defaultNodeId });
  for (const id of ids) {
    const node = known.get(id), links = focus.links[id];
    if (!node) issues.push({ code: 'MISSING_CONTROL', nodeId: id });
    else if (node.visible === false || node.opacity === 0 || (node.componentProperties && node.componentProperties.State && node.componentProperties.State.value === 'Disabled')) issues.push({ code: 'DISABLED_CONTROL', nodeId: id });
    if (!links || typeof links !== 'object') { issues.push({ code: 'INVALID_LINKS', nodeId: id }); continue; }
    for (const [direction, reverse] of Object.entries(directions)) {
      const target = links[direction];
      if (target === null) continue;
      if (typeof target !== 'string' || !ids.includes(target) || !known.has(target)) issues.push({ code: 'INVALID_EDGE', nodeId: id, direction, target });
      else if (target === id) issues.push({ code: 'SELF_LINK', nodeId: id, direction });
      else if (!focus.links[target] || focus.links[target][reverse] !== id) issues.push({ code: 'ASYMMETRIC_LINK', nodeId: id, direction, target });
    }
  }
  const reached = new Set(), queue = ids.includes(focus.defaultNodeId) ? [focus.defaultNodeId] : [];
  while (queue.length) {
    const id = queue.pop(); if (reached.has(id)) continue; reached.add(id);
    const links = focus.links[id];
    if (links && typeof links === 'object') for (const direction of Object.keys(directions)) if (ids.includes(links[direction]) && !reached.has(links[direction])) queue.push(links[direction]);
  }
  for (const id of ids) if (!reached.has(id)) issues.push({ code: 'UNREACHABLE_CONTROL', nodeId: id });
  return { rootId: root.id, controls: ids.length, reachable: reached.size, issues: issues.slice(0, 200), issueTotal: issues.length };
}

function packGameSprites(sprites, width, padding) {
  let x = padding, y = padding, rowHeight = 0, usedWidth = 0;
  const placed = [];
  for (const sprite of [...sprites].sort((a, b) => b.height - a.height)) {
    if (sprite.width + padding * 2 > width) throw new Error('A sprite exceeds the atlas width.');
    if (x + sprite.width + padding > width) { x = padding; y += rowHeight + padding; rowHeight = 0; }
    placed.push({ ...sprite, x, y }); x += sprite.width + padding; rowHeight = Math.max(rowHeight, sprite.height); usedWidth = Math.max(usedWidth, x);
  }
  return { sprites: placed, width: usedWidth, height: y + rowHeight + padding };
}

async function executeGamePackaging(command, args) {
  if (command === 'audit_game_focus') {
    const root = await getNode(args.rootId); return auditFocusGraph(root, await gameTree(root, args.maxNodes));
  }
  if (command === 'export_ui_spec') {
    const root = await getNode(args.rootId), nodes = await gameTree(root, args.maxNodes);
    return boundedGameJson({ version: 1, rootId: root.id, coordinateSystem: 'parent-relative, logical pixels', engine: 'generic',
      nodes: nodes.map(node => ({ ...snapshot(node, 0, { remaining: 1 }), parentId: node.parent && node.parent.id, visible: node.visible !== false, game: gameMetadata(node) })) });
  }
  if (command === 'export_game_atlas') {
    const sprites = []; let sourceNodes = 0;
    for (const asset of args.assets) {
      const node = requireScene(await getNode(asset.nodeId));
      sourceNodes += (await gameTree(node, 4000 - sourceNodes)).length;
      if (!node.width || !node.height || (node.rotation && node.rotation !== 0)) throw new Error('Atlas sprites must be non-empty and unrotated.');
      const metadata = gameMetadata(node); if (metadata.nineSlice) validSlice(node, metadata.nineSlice.borders);
      sprites.push({ name: asset.name, nodeId: node.id, node, game: metadata, width: Math.ceil(node.width * args.scale), height: Math.ceil(node.height * args.scale) });
    }
    const maxWidth = args.powerOfTwo ? Math.pow(2, Math.floor(Math.log2(args.maxWidth))) : args.maxWidth;
    const packed = packGameSprites(sprites, maxWidth, args.padding);
    const width = args.powerOfTwo ? Math.pow(2, Math.ceil(Math.log2(packed.width))) : packed.width;
    const height = args.powerOfTwo ? Math.pow(2, Math.ceil(Math.log2(packed.height))) : packed.height;
    if (width > args.maxWidth || height > args.maxHeight) throw new Error('Sprites do not fit the atlas limits. Split the batch or increase limits.');
    await figma.currentPage.loadAsync();
    const atlas = figma.createFrame(), clones = [];
    try {
      atlas.name = 'Temporary atlas export'; atlas.resize(width / args.scale, height / args.scale); atlas.x = -100000; atlas.fills = []; atlas.clipsContent = true;
      for (const sprite of packed.sprites) {
        const wrapper = figma.createFrame(); atlas.appendChild(wrapper); wrapper.name = sprite.name; wrapper.fills = []; wrapper.clipsContent = true;
        wrapper.resize(sprite.width / args.scale, sprite.height / args.scale); wrapper.x = sprite.x / args.scale; wrapper.y = sprite.y / args.scale;
        const clone = sprite.node.clone(); clones.push(clone); wrapper.appendChild(clone); clone.x = clone.y = 0;
      }
      const bytes = await atlas.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: args.scale }, useAbsoluteBounds: true, contentsOnly: true, colorProfile: 'SRGB' });
      if (bytes.length > 8 * 1024 * 1024 || bytes.length < 24) throw new Error('Atlas PNG is invalid or exceeds 8 MiB.');
      const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (header.getUint32(16) !== width || header.getUint32(20) !== height) throw new Error('Atlas export bounds differ from packing dimensions. Try an integer scale.');
      const output = packed.sprites.map(({ node, ...sprite }) => {
        if (sprite.game.nineSlice) {
          const borders = {};
          for (const key of ['left', 'right', 'top', 'bottom']) borders[key] = Math.round(sprite.game.nineSlice.borders[key] * args.scale);
          if (borders.left + borders.right >= sprite.width || borders.top + borders.bottom >= sprite.height) throw new Error('Scaled atlas 9-slice leaves no center.');
          sprite.nineSlice = { borders, units: 'pixels', origin: 'top-left' };
        }
        return sprite;
      });
      return { images: [{ filename: args.name + '@' + args.scale + 'x.png', kind: 'atlas', scale: args.scale, pixelWidth: width, pixelHeight: height,
        logicalWidth: width / args.scale, logicalHeight: height / args.scale, sprites: output, padding: args.padding, edgeExtrusion: false, data: figma.base64Encode(bytes) }] };
    } finally {
      atlas.remove(); for (const clone of clones) if (!clone.removed) clone.remove(); figma.commitUndo();
    }
  }
}
