async function executeGamePreviews(command, args) {
  if (command === 'preview_resolutions') {
    const source = await getNode(args.rootId);
    if (source.type !== 'FRAME') throw new Error('Resolution previews require a screen FRAME.');
    await gameTree(source, args.maxNodes);
    const parent = await getParent(source.parent.id), previews = [];
    try {
      let x = source.x + source.width + 64;
      for (const view of args.views) {
        const copy = cloneGameTree(source, parent); previews.push({ nodeId: copy.id, name: view.name, width: view.width, height: view.height, issues: [] });
        copy.name = source.name + ' [' + view.name + ']'; copy.resize(view.width, view.height); copy.x = x; copy.y = source.y; x += view.width + 64;
        const nodes = await gameTree(copy, args.maxNodes), metadata = gameMetadata(copy);
        if (metadata.screen) {
          const safe = await getNode(metadata.screen.safeAreaId), inset = metadata.screen.insets;
          if (view.width <= inset.left + inset.right || view.height <= inset.top + inset.bottom) throw new Error('Preview is too small for its safe area.');
          safe.resize(view.width - inset.left - inset.right, view.height - inset.top - inset.bottom); safe.x = inset.left; safe.y = inset.top;
        }
        for (const node of nodes) {
          const anchor = gameMetadata(node).anchor;
          if (anchor) {
            try { await executeGame('set_game_anchor', { nodeId: node.id, anchor: anchor.preset, marginX: anchor.marginX, marginY: anchor.marginY }); }
            catch (error) { previews.at(-1).issues.push({ nodeId: node.id, code: 'ANCHOR_DOES_NOT_FIT', message: error.message }); }
          }
        }
        for (const node of nodes) {
          const widget = gameMetadata(node);
          if (widget.bar) await executeGame('set_hud_value', { nodeId: node.id, value: widget.bar.value });
        }
        const audit = await auditDesign({ rootId: copy.id, maxNodes: args.maxNodes, spacingStep: 4 });
        previews.at(-1).issues.push(...audit.issues);
      }
      figma.commitUndo(); return { sourceId: source.id, previews };
    } catch (error) { for (const preview of previews) { const node = await figma.getNodeByIdAsync(preview.nodeId); if (node && !node.removed) node.remove(); } throw error; }
  }
  if (command === 'create_state_sheet') {
    const source = await getNode(args.nodeId);
    if (source.type !== 'INSTANCE' || !source.componentProperties[args.property] || source.componentProperties[args.property].type !== 'VARIANT') throw new Error('State sheets require an instance VARIANT property.');
    const font = { family: args.fontFamily, style: args.fontStyle }; await figma.loadFontAsync(font);
    const parent = await getParent(source.parent.id), sheet = figma.createFrame();
    try {
      parent.appendChild(sheet); sheet.name = args.name; sheet.fills = [{ type: 'SOLID', color: rgb('#10151F') }];
      const columns = Math.min(3, args.states.length), states = [], copies = [];
      sheet.x = source.x + source.width + 64; sheet.y = source.y;
      for (const state of args.states) {
        const copy = source.clone(); sheet.appendChild(copy); copy.setProperties({ [args.property]: state });
        copies.push(copy); states.push({ nodeId: copy.id, state });
      }
      const cellWidth = Math.max(...copies.map(copy => copy.width)) + 32, cellHeight = Math.max(...copies.map(copy => copy.height)) + 56;
      sheet.resize(columns * cellWidth + 16, Math.ceil(args.states.length / columns) * cellHeight + 16);
      for (const [index, copy] of copies.entries()) {
        copy.x = 16 + index % columns * cellWidth; copy.y = 16 + Math.floor(index / columns) * cellHeight;
        const label = figma.createText(); sheet.appendChild(label); label.fontName = font; label.fontSize = 14; label.fills = [{ type: 'SOLID', color: rgb('#FFFFFF') }];
        label.characters = args.states[index]; label.x = copy.x; label.y = copy.y + copy.height + 8;
      }
      figma.commitUndo(); return { sheetId: sheet.id, sourceId: source.id, states };
    } catch (error) { sheet.remove(); throw error; }
  }
}
