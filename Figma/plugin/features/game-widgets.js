function widgetLabel(parent, text, font, size, width, height) {
  const label = figma.createText(); parent.appendChild(label); label.fontName = font; label.fontSize = size; label.characters = text;
  label.fills = [{ type: 'SOLID', color: rgb('#FFFFFF') }]; label.textAutoResize = 'NONE'; label.resize(width, height);
  label.textAlignHorizontal = 'CENTER'; label.textAlignVertical = 'CENTER'; label.x = label.y = 0;
  return label;
}

function inputGlyph(device, action, font) {
  const frame = figma.createFrame();
  try {
    frame.name = device + ' ' + action; frame.resize(56, 36); frame.cornerRadius = 6; frame.fills = [{ type: 'SOLID', color: rgb('#263044') }];
    if (device === 'PLAYSTATION' && action !== 'MENU') {
      const shapes = { CONFIRM: '<path d="M6 6L18 18M18 6L6 18"/>', CANCEL: '<circle cx="12" cy="12" r="7"/>', INTERACT: '<rect x="5" y="5" width="14" height="14"/>' };
      const icon = figma.createNodeFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="#ffffff" stroke-width="2">' + shapes[action] + '</g></svg>');
      frame.appendChild(icon); icon.x = 16; icon.y = 6;
    } else {
      const names = { KEYBOARD: { CONFIRM: 'Enter', CANCEL: 'Esc', INTERACT: 'E', MENU: 'Tab' }, XBOX: { CONFIRM: 'A', CANCEL: 'B', INTERACT: 'X', MENU: 'Menu' }, PLAYSTATION: { MENU: 'Menu' } };
      widgetLabel(frame, names[device][action], font, 13, 56, 36);
    }
    return frame;
  } catch (error) { frame.remove(); throw error; }
}

function targetBox(node, root) {
  let current = node, x = 0, y = 0;
  while (current !== root) {
    if (!current || current.type === 'PAGE' || (current.rotation && current.rotation !== 0)) throw new Error('Target must be an unrotated descendant of the screen.');
    x += current.x; y += current.y; current = current.parent;
  }
  return { x, y, width: node.width, height: node.height };
}

function tooltipPosition(tip, box, root, args) {
  if (tip.width + 2 * args.margin > root.width || tip.height + 2 * args.margin > root.height) throw new Error('Tooltip does not fit inside the screen.');
  const positions = {
    ABOVE: { x: box.x + (box.width - tip.width) / 2, y: box.y - tip.height - args.gap },
    BELOW: { x: box.x + (box.width - tip.width) / 2, y: box.y + box.height + args.gap },
    LEFT: { x: box.x - tip.width - args.gap, y: box.y + (box.height - tip.height) / 2 },
    RIGHT: { x: box.x + box.width + args.gap, y: box.y + (box.height - tip.height) / 2 }
  };
  const opposite = { ABOVE: 'BELOW', BELOW: 'ABOVE', LEFT: 'RIGHT', RIGHT: 'LEFT' };
  for (const placement of [args.preferred, opposite[args.preferred], 'LEFT', 'RIGHT', 'ABOVE', 'BELOW']) {
    const pos = positions[placement];
    if (pos.x >= args.margin && pos.y >= args.margin && pos.x + tip.width <= root.width - args.margin && pos.y + tip.height <= root.height - args.margin) return { ...pos, placement };
  }
  const initial = positions[args.preferred];
  return { x: Math.max(args.margin, Math.min(root.width - args.margin - tip.width, initial.x)), y: Math.max(args.margin, Math.min(root.height - args.margin - tip.height, initial.y)), placement: 'CLAMPED' };
}

async function inventoryInfo(nodeId) {
  const root = await getNode(nodeId), inventory = gameMetadata(root).inventory;
  if (root.type !== 'FRAME' || !inventory || !Array.isArray(inventory.slotIds) || inventory.slotIds.length > 200) throw new Error('Not an inventory created by this plugin.');
  const slots = await Promise.all(inventory.slotIds.map(getNode));
  if (slots.some(slot => slot.parent !== root)) throw new Error('Inventory slots were moved.');
  return { root, inventory, slots };
}

async function executeGameWidgets(command, args) {
  if (command === 'create_input_prompt') {
    const parent = await getParent(args.parentId), font = { family: args.fontFamily, style: args.fontStyle }; await figma.loadFontAsync(font);
    const root = figma.createFrame();
    try {
      parent.appendChild(root); root.name = args.name; root.resize(320, 36); root.x = args.x; root.y = args.y; root.fills = [];
      const glyph = inputGlyph(args.device, args.action, font); root.appendChild(glyph); glyph.x = glyph.y = 0;
      const label = widgetLabel(root, args.label, font, 16, 248, 36); label.x = 64; label.textAlignHorizontal = 'LEFT';
      storeGameMetadata(root, { inputPrompt: { device: args.device, action: args.action, glyphId: glyph.id, labelId: label.id, font } });
      figma.commitUndo(); return { nodeId: root.id, glyphId: glyph.id, labelId: label.id, device: args.device };
    } catch (error) { root.remove(); throw error; }
  }
  if (command === 'set_input_device') {
    const root = await getNode(args.nodeId), metadata = gameMetadata(root), prompt = metadata.inputPrompt;
    if (root.type !== 'FRAME' || !prompt) throw new Error('Not an input prompt created by this plugin.');
    const old = await getNode(prompt.glyphId), label = await getNode(prompt.labelId);
    if (old.parent !== root || label.parent !== root) throw new Error('Input prompt children were moved.');
    await figma.loadFontAsync(prompt.font);
    const glyph = inputGlyph(args.device, prompt.action, prompt.font);
    try { root.insertChild(0, glyph); glyph.x = glyph.y = 0; prompt.glyphId = glyph.id; prompt.device = args.device; root.setPluginData(gameKey, JSON.stringify(metadata)); old.remove(); }
    catch (error) { glyph.remove(); throw error; }
    figma.commitUndo(); return { nodeId: root.id, glyphId: glyph.id, device: args.device };
  }
  if (command === 'create_inventory') {
    const count = args.rows * args.columns;
    if (count > 200) throw new Error('At most 200 inventory slots.');
    const parent = await getParent(args.parentId), font = { family: args.fontFamily, style: args.fontStyle }; await figma.loadFontAsync(font);
    const root = figma.createFrame(), slots = [];
    try {
      parent.appendChild(root); root.name = args.name; root.resize(args.columns * args.slotSize + (args.columns - 1) * args.gap + 16, args.rows * args.slotSize + (args.rows - 1) * args.gap + 16);
      root.x = args.x; root.y = args.y; root.fills = []; root.clipsContent = false;
      for (let index = 0; index < count; index++) {
        const slot = figma.createFrame(); root.appendChild(slot); slots.push(slot); slot.name = 'Slot ' + index; slot.resize(args.slotSize, args.slotSize);
        slot.x = 8 + index % args.columns * (args.slotSize + args.gap); slot.y = 8 + Math.floor(index / args.columns) * (args.slotSize + args.gap);
        slot.cornerRadius = 6; slot.clipsContent = true; slot.fills = [{ type: 'SOLID', color: rgb(args.background) }];
        slot.strokes = [{ type: 'SOLID', color: rgb(index === 0 ? args.focusColor : '#46536A') }]; slot.strokeWeight = index === 0 ? 3 : 1; slot.strokeAlign = 'INSIDE';
        const label = widgetLabel(slot, '', font, 12, args.slotSize - 8, 20); label.name = 'Item label'; label.x = 4; label.y = args.slotSize - 24;
        const quantity = widgetLabel(slot, '', font, 12, args.slotSize - 8, 16); quantity.name = 'Quantity'; quantity.x = 4; quantity.y = 4; quantity.textAlignHorizontal = 'RIGHT';
        storeGameMetadata(slot, { item: { index, labelId: label.id, quantityId: quantity.id, itemName: '', quantity: 0 } });
      }
      storeGameMetadata(root, { inventory: { rows: args.rows, columns: args.columns, slotSize: args.slotSize, gap: args.gap, slotIds: slots.map(slot => slot.id), selectedIndex: 0, focusColor: args.focusColor, font } });
      if (count > 1) await executeGame('build_game_focus', { nodeIds: slots.map(slot => slot.id), defaultNodeId: slots[0].id });
      else storeGameMetadata(root, { focus: { defaultNodeId: slots[0].id, links: { [slots[0].id]: { up: null, down: null, left: null, right: null } }, wrap: false } });
      figma.commitUndo(); return { nodeId: root.id, slots: slots.map(slot => ({ nodeId: slot.id, index: gameMetadata(slot).item.index })) };
    } catch (error) { root.remove(); throw error; }
  }
  if (command === 'set_inventory_item') {
    const { inventory, slots } = await inventoryInfo(args.nodeId), slot = slots[args.index];
    if (!slot) throw new Error('Inventory index is out of range.');
    const metadata = gameMetadata(slot), item = metadata.item;
    const label = await getNode(item.labelId), quantity = await getNode(item.quantityId);
    if (label.parent !== slot || quantity.parent !== slot) throw new Error('Slot labels were moved.');
    await figma.loadFontAsync(inventory.font);
    try { label.characters = args.itemName; quantity.characters = args.itemName ? String(args.quantity) : ''; item.itemName = args.itemName; item.quantity = args.itemName ? args.quantity : 0; slot.setPluginData(gameKey, JSON.stringify(metadata)); }
    finally { figma.commitUndo(); }
    return { nodeId: slot.id, index: args.index, itemName: item.itemName, quantity: item.quantity };
  }
  if (command === 'select_inventory_slot') {
    const { root, inventory, slots } = await inventoryInfo(args.nodeId);
    if (!slots[args.index]) throw new Error('Inventory index is out of range.');
    const metadata = gameMetadata(root);
    try {
      for (const [index, slot] of slots.entries()) { slot.strokes = [{ type: 'SOLID', color: rgb(index === args.index ? inventory.focusColor : '#46536A') }]; slot.strokeWeight = index === args.index ? 3 : 1; }
      inventory.selectedIndex = args.index; metadata.inventory = inventory;
      if (metadata.focus) metadata.focus.defaultNodeId = slots[args.index].id;
      root.setPluginData(gameKey, JSON.stringify(metadata));
    } finally { figma.commitUndo(); }
    return { nodeId: root.id, selectedIndex: args.index, slotId: slots[args.index].id };
  }
  if (command === 'create_cooldown') {
    const parent = await getParent(args.parentId), font = { family: args.fontFamily, style: args.fontStyle }; await figma.loadFontAsync(font);
    const root = figma.createFrame();
    try {
      parent.appendChild(root); root.name = args.name; root.resize(args.size, args.size); root.x = args.x; root.y = args.y; root.fills = [];
      const track = figma.createEllipse(); root.appendChild(track); track.resize(args.size, args.size); track.x = track.y = 0; track.fills = [{ type: 'SOLID', color: rgb('#273044') }];
      const overlay = figma.createEllipse(); root.appendChild(overlay); overlay.resize(args.size, args.size); overlay.x = overlay.y = 0; overlay.fills = [{ type: 'SOLID', color: rgb(args.color) }];
      const label = widgetLabel(root, args.seconds === undefined ? '' : String(Math.ceil(args.seconds)), font, 18, args.size, args.size);
      storeGameMetadata(root, { cooldown: { overlayId: overlay.id, trackId: track.id, labelId: label.id, innerRadius: args.innerRadius, font, value: args.value } });
      await executeGameWidgets('set_cooldown', { nodeId: root.id, value: args.value, seconds: args.seconds });
      figma.commitUndo(); return { nodeId: root.id, overlayId: overlay.id, trackId: track.id, labelId: label.id };
    } catch (error) { root.remove(); throw error; }
  }
  if (command === 'set_cooldown') {
    const root = await getNode(args.nodeId), metadata = gameMetadata(root), cooldown = metadata.cooldown;
    if (!cooldown || root.type !== 'FRAME') throw new Error('Not a cooldown created by this plugin.');
    const overlay = await getNode(cooldown.overlayId), label = await getNode(cooldown.labelId);
    if (overlay.parent !== root || label.parent !== root || overlay.type !== 'ELLIPSE') throw new Error('Cooldown children were moved.');
    if (args.seconds !== undefined) await figma.loadFontAsync(cooldown.font);
    try {
      overlay.arcData = { startingAngle: -Math.PI / 2, endingAngle: -Math.PI / 2 + 2 * Math.PI * Math.max(0.00001, args.value), innerRadius: cooldown.innerRadius };
      overlay.visible = args.value > 0; if (args.seconds !== undefined) { label.characters = String(Math.ceil(args.seconds)); cooldown.seconds = args.seconds; }
      cooldown.value = args.value; root.setPluginData(gameKey, JSON.stringify(metadata));
    } finally { figma.commitUndo(); }
    return { nodeId: root.id, value: args.value, visible: overlay.visible };
  }
  if (command === 'create_tooltip') {
    const parent = await getParent(args.parentId), target = await getNode(args.targetId);
    if (!['FRAME', 'COMPONENT'].includes(parent.type) || (parent.layoutMode && parent.layoutMode !== 'NONE')) throw new Error('Tooltip parent must be a screen without auto-layout.');
    const box = targetBox(target, parent), font = { family: args.fontFamily, style: args.fontStyle }; await figma.loadFontAsync(font);
    const tip = figma.createFrame();
    try {
      parent.appendChild(tip); tip.name = args.name; tip.resize(args.width, 1); tip.fills = [{ type: 'SOLID', color: rgb('#182132') }]; tip.cornerRadius = 8;
      const label = widgetLabel(tip, args.text, font, 16, args.width - 24, 1); label.textAutoResize = 'HEIGHT'; label.textAlignHorizontal = 'LEFT'; label.resize(args.width - 24, 1); label.x = label.y = 12;
      tip.resize(args.width, label.height + 24);
      const pos = tooltipPosition(tip, box, parent, args); tip.x = pos.x; tip.y = pos.y;
      storeGameMetadata(tip, { tooltip: { targetId: target.id, preferred: args.preferred, gap: args.gap, margin: args.margin, labelId: label.id } });
      figma.commitUndo(); return { nodeId: tip.id, ...pos };
    } catch (error) { tip.remove(); throw error; }
  }
  if (command === 'position_tooltip') {
    const tip = await getNode(args.nodeId), parent = tip.parent, target = await getNode(args.targetId);
    if (!gameMetadata(tip).tooltip || !parent || !['FRAME', 'COMPONENT'].includes(parent.type)) throw new Error('Not a tooltip inside a screen.');
    const pos = tooltipPosition(tip, targetBox(target, parent), parent, args);
    try { tip.x = pos.x; tip.y = pos.y; storeGameMetadata(tip, { tooltip: { ...gameMetadata(tip).tooltip, targetId: target.id, preferred: args.preferred, gap: args.gap, margin: args.margin } }); }
    finally { figma.commitUndo(); }
    return { nodeId: tip.id, ...pos };
  }
}
