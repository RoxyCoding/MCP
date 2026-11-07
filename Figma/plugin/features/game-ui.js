const gameKey = 'game-ui';

function gameMetadata(node) {
  const raw = node.getPluginData(gameKey);
  if (!raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { throw new Error('Game metadata is invalid.'); }
}

function storeGameMetadata(node, update) {
  const metadata = Object.assign(gameMetadata(node), update);
  node.setPluginData(gameKey, JSON.stringify(metadata));
  return metadata;
}

function validSlice(node, borders) {
  if (!node.width || !node.height || (node.rotation && node.rotation !== 0)) throw new Error('9-slice requires an unrotated, non-empty asset.');
  if (!borders || ['left', 'right', 'top', 'bottom'].some(key => !Number.isInteger(borders[key]) || borders[key] < 0)) throw new Error('Invalid 9-slice borders.');
  if (borders.left + borders.right >= node.width || borders.top + borders.bottom >= node.height) throw new Error('9-slice borders leave no stretchable center.');
}

function updateBarGeometry(frame, track, fill, value, direction) {
  track.resize(frame.width, frame.height);
  fill.visible = value > 0;
  if (direction === 'HORIZONTAL') { fill.resize(Math.max(0.01, frame.width * value), frame.height); fill.x = 0; fill.y = 0; }
  else { fill.resize(frame.width, Math.max(0.01, frame.height * value)); fill.x = 0; fill.y = frame.height * (1 - value); }
}

async function executeGame(command, args) {
  const budget = { remaining: 1000 };
  if (command === 'create_game_screen') {
    const inset = args.insets;
    if (inset.left + inset.right >= args.width || inset.top + inset.bottom >= args.height) throw new Error('Safe-area insets leave no usable area.');
    const parent = await getParent(args.parentId), frame = figma.createFrame();
    try {
      parent.appendChild(frame); frame.name = args.name; frame.resize(args.width, args.height); frame.x = args.x; frame.y = args.y;
      frame.fills = [{ type: 'SOLID', color: rgb(args.background) }]; frame.clipsContent = true;
      const safe = figma.createFrame(); frame.appendChild(safe); safe.name = 'Safe Area'; safe.fills = []; safe.strokes = []; safe.clipsContent = false;
      safe.resize(args.width - inset.left - inset.right, args.height - inset.top - inset.bottom); safe.x = inset.left; safe.y = inset.top;
      safe.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
      storeGameMetadata(frame, { screen: { referenceWidth: args.width, referenceHeight: args.height, insets: inset, safeAreaId: safe.id } });
      figma.commitUndo(); return { screen: snapshot(frame, 0, budget), safeArea: snapshot(safe, 0, budget) };
    } catch (error) { frame.remove(); throw error; }
  }
  if (command === 'set_game_anchor') {
    const node = requireScene(await getNode(args.nodeId)), parent = node.parent;
    if (!parent || !['FRAME', 'COMPONENT', 'INSTANCE'].includes(parent.type) || (parent.layoutMode && parent.layoutMode !== 'NONE')) throw new Error('Game anchors require a frame parent without auto-layout.');
    if (node.rotation && node.rotation !== 0) throw new Error('Game anchors require an unrotated node.');
    const horizontal = args.anchor.includes('LEFT') ? 'MIN' : args.anchor.includes('RIGHT') ? 'MAX' : 'CENTER';
    const vertical = args.anchor.includes('TOP') ? 'MIN' : args.anchor.includes('BOTTOM') ? 'MAX' : 'CENTER';
    let x, y, width = node.width, height = node.height;
    if (args.anchor === 'STRETCH') { width = parent.width - 2 * args.marginX; height = parent.height - 2 * args.marginY; x = args.marginX; y = args.marginY; }
    else { x = horizontal === 'MIN' ? args.marginX : horizontal === 'MAX' ? parent.width - node.width - args.marginX : (parent.width - node.width) / 2;
      y = vertical === 'MIN' ? args.marginY : vertical === 'MAX' ? parent.height - node.height - args.marginY : (parent.height - node.height) / 2; }
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > parent.width || y + height > parent.height) throw new Error('Node and margins do not fit inside the parent.');
    const metadata = gameMetadata(node);
    try {
      node.resize(width, height); node.x = x; node.y = y;
      node.constraints = args.anchor === 'STRETCH' ? { horizontal: 'STRETCH', vertical: 'STRETCH' } : { horizontal, vertical };
      metadata.anchor = { preset: args.anchor, parentId: parent.id, marginX: args.marginX, marginY: args.marginY };
      node.setPluginData(gameKey, JSON.stringify(metadata));
    } finally { figma.commitUndo(); }
    return snapshot(node, 0, budget);
  }
  if (command === 'build_game_focus') {
    const nodes = await siblings(args.nodeIds), parent = nodes[0].parent;
    if (!['FRAME', 'COMPONENT'].includes(parent.type)) throw new Error('Focus controls must be siblings inside a frame or component.');
    if (nodes.some(node => node.visible === false || node.opacity === 0 || (node.rotation && node.rotation !== 0) ||
      (node.componentProperties && node.componentProperties.State && node.componentProperties.State.value === 'Disabled'))) throw new Error('Focus controls must be visible, enabled and unrotated.');
    const defaultNodeId = args.defaultNodeId || nodes[0].id;
    if (!nodes.some(node => node.id === defaultNodeId)) throw new Error('Default focus must be one of the controls.');
    const links = {};
    for (const node of nodes) {
      const cx = node.x + node.width / 2, cy = node.y + node.height / 2;
      links[node.id] = {};
      for (const direction of ['up', 'down', 'left', 'right']) {
        let best = null, score = Infinity;
        for (const other of nodes) {
          if (other === node) continue;
          const dx = other.x + other.width / 2 - cx, dy = other.y + other.height / 2 - cy;
          const primary = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy;
          const cross = direction === 'right' || direction === 'left' ? Math.abs(dy) : Math.abs(dx);
          if (primary > 0 && primary + 3 * cross < score) { best = other.id; score = primary + 3 * cross; }
        }
        links[node.id][direction] = best;
      }
    }
    const focus = { defaultNodeId, links, algorithm: 'directional-distance', wrap: false };
    storeGameMetadata(parent, { focus }); figma.commitUndo(); return { parentId: parent.id, focus };
  }
  if (command === 'create_game_button') {
    if (args.fontSize + 16 > args.height) throw new Error('Button height must allow font size plus 16 pixels.');
    const parent = await getParent(args.parentId), font = { family: args.fontFamily, style: args.fontStyle };
    await figma.loadFontAsync(font);
    const created = []; let set;
    try {
      for (const [index, state] of ['Default', 'Focused', 'Pressed', 'Disabled'].entries()) {
        const component = figma.createComponent(); created.push(component); parent.appendChild(component);
        component.name = 'State=' + state; component.resize(args.width, args.height); component.x = args.x; component.y = args.y + index * (args.height + 16);
        component.cornerRadius = Math.min(8, args.height / 2); component.clipsContent = true;
        const background = rgb(args.background);
        if (state === 'Pressed') { background.r *= 0.7; background.g *= 0.7; background.b *= 0.7; }
        component.fills = [{ type: 'SOLID', color: background }];
        component.opacity = state === 'Disabled' ? 0.4 : 1;
        if (state === 'Focused') { component.strokes = [{ type: 'SOLID', color: rgb(args.focusColor) }]; component.strokeWeight = 3; component.strokeAlign = 'INSIDE'; }
        const label = figma.createText(); component.appendChild(label); label.name = 'Label'; label.fontName = font; label.fontSize = args.fontSize; label.characters = args.label;
        label.fills = [{ type: 'SOLID', color: rgb(args.textColor) }]; label.textAutoResize = 'NONE'; label.textAlignHorizontal = 'CENTER'; label.textAlignVertical = 'CENTER';
        const padding = Math.min(16, args.width / 4); label.resize(args.width - padding * 2, args.height); label.x = padding; label.y = 0;
        label.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
      }
      set = figma.combineAsVariants(created, parent); set.name = args.name;
      storeGameMetadata(set, { button: { states: ['Default', 'Focused', 'Pressed', 'Disabled'] } });
      figma.commitUndo(); return { componentSet: snapshot(set, 0, budget), variants: created.map(node => ({ id: node.id, name: node.name })) };
    } catch (error) { if (set) set.remove(); else for (const node of created) if (!node.removed) node.remove(); throw error; }
  }
  if (command === 'create_hud_bar') {
    const parent = await getParent(args.parentId), frame = figma.createFrame();
    try {
      parent.appendChild(frame); frame.name = args.name; frame.resize(args.width, args.height); frame.x = args.x; frame.y = args.y;
      frame.fills = []; frame.clipsContent = true; frame.cornerRadius = Math.min(8, args.height / 2, args.width / 2);
      const track = figma.createRectangle(); frame.appendChild(track); track.name = 'Track'; track.x = track.y = 0; track.fills = [{ type: 'SOLID', color: rgb(args.trackColor) }];
      const fill = figma.createRectangle(); frame.appendChild(fill); fill.name = 'Fill'; fill.fills = [{ type: 'SOLID', color: rgb(args.fillColor) }];
      updateBarGeometry(frame, track, fill, args.value, args.direction);
      storeGameMetadata(frame, { bar: { value: args.value, direction: args.direction, trackId: track.id, fillId: fill.id } });
      figma.commitUndo(); return { node: snapshot(frame, 0, budget), fillId: fill.id, value: args.value };
    } catch (error) { frame.remove(); throw error; }
  }
  if (command === 'set_hud_value') {
    const frame = await getNode(args.nodeId), metadata = gameMetadata(frame), bar = metadata.bar;
    if (frame.type !== 'FRAME' || !bar || !['HORIZONTAL', 'VERTICAL'].includes(bar.direction)) throw new Error('Node is not a HUD bar created by this plugin.');
    const track = await getNode(bar.trackId), fill = await getNode(bar.fillId);
    if (track.parent !== frame || fill.parent !== frame) throw new Error('HUD bar children were moved; cannot update safely.');
    try { updateBarGeometry(frame, track, fill, args.value, bar.direction); bar.value = args.value; frame.setPluginData(gameKey, JSON.stringify(metadata)); }
    finally { figma.commitUndo(); }
    return { nodeId: frame.id, fillId: fill.id, value: args.value, visible: fill.visible, width: fill.width, height: fill.height };
  }
  if (command === 'set_nine_slice') {
    const node = requireScene(await getNode(args.nodeId)); validSlice(node, args.borders);
    storeGameMetadata(node, { nineSlice: { borders: args.borders, units: 'logical-pixels', origin: 'top-left' } });
    figma.commitUndo(); return { nodeId: node.id, borders: args.borders };
  }
  if (command === 'export_game_assets') {
    if (args.assets.length * args.scales.length > 8) throw new Error('Export at most 8 images per batch.');
    const assets = [];
    for (const asset of args.assets) {
      const node = requireScene(await getNode(asset.nodeId)), metadata = gameMetadata(node);
      if (!node.exportAsync || node.width <= 0 || node.height <= 0 || (node.rotation && node.rotation !== 0)) throw new Error('Game export requires unrotated, non-empty exportable nodes.');
      if (metadata.nineSlice) validSlice(node, metadata.nineSlice.borders);
      assets.push({ asset, node, metadata });
    }
    const images = []; let total = 0;
    for (const { asset, node, metadata } of assets) for (const scale of args.scales) {
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale }, useAbsoluteBounds: true, contentsOnly: true, colorProfile: 'SRGB' });
      total += bytes.length;
      if (total > 8 * 1024 * 1024) throw new Error('Export exceeds 8 MiB total. Reduce assets or scale.');
      if (bytes.length < 24) throw new Error('Invalid PNG export.');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), pixelWidth = view.getUint32(16), pixelHeight = view.getUint32(20);
      let nineSlice = null;
      if (metadata.nineSlice) {
        const borders = {};
        for (const key of ['left', 'right', 'top', 'bottom']) borders[key] = Math.round(metadata.nineSlice.borders[key] * scale);
        if (borders.left + borders.right >= pixelWidth || borders.top + borders.bottom >= pixelHeight) throw new Error('Scaled 9-slice borders leave no center. Increase scale or reduce borders.');
        nineSlice = { borders, units: 'pixels', origin: 'top-left' };
      }
      images.push({ filename: asset.name + '@' + scale + 'x.png', nodeId: node.id, scale, pixelWidth, pixelHeight,
        logicalWidth: node.width, logicalHeight: node.height, nineSlice, game: metadata, data: figma.base64Encode(bytes) });
    }
    return { images };
  }
}
