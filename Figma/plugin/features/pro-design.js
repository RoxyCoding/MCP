function variableSummary(variable) {
  return { id: variable.id, name: variable.name, collectionId: variable.variableCollectionId, type: variable.resolvedType, values: variable.valuesByMode };
}

function collectionSummary(collection) {
  return { id: collection.id, name: collection.name, modes: collection.modes, defaultModeId: collection.defaultModeId };
}

async function getCollection(id) {
  const collection = await figma.variables.getVariableCollectionByIdAsync(id);
  if (!collection) throw new Error('Variable collection not found.');
  return collection;
}

async function getVariable(id) {
  const variable = await figma.variables.getVariableByIdAsync(id);
  if (!variable) throw new Error('Variable not found.');
  return variable;
}

function validateVariableValue(type, value) {
  const valid = type === 'COLOR' ? value && typeof value === 'object' && ['r', 'g', 'b', 'a'].every(key => typeof value[key] === 'number' && value[key] >= 0 && value[key] <= 1)
    : type === 'FLOAT' ? typeof value === 'number' && Number.isFinite(value) : type === 'BOOLEAN' ? typeof value === 'boolean' : typeof value === 'string';
  if (!valid) throw new Error('Variable value does not match ' + type + '.');
}

function requireMode(collection, modeId) {
  if (!collection.modes.some(mode => mode.modeId === modeId)) throw new Error('Mode does not belong to this collection.');
}

async function executePro(command, args) {
  const budget = { remaining: 1000 };
  if (command === 'set_gradient') {
    const node = requireScene(await getNode(args.nodeId));
    if (!('fills' in node)) throw new Error('This node does not support fills.');
    if (node.type === 'TEXT') await loadNodeFonts(node);
    const angle = args.angle * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    node.fills = [{ type: args.type, gradientTransform: [[c, s, 0.5 - 0.5 * c - 0.5 * s], [-s, c, 0.5 + 0.5 * s - 0.5 * c]],
      gradientStops: args.stops.map(stop => ({ position: stop.position, color: Object.assign(rgb(stop.color), { a: stop.opacity }) })) }];
    figma.commitUndo(); return snapshot(node, 0, budget);
  }
  if (command === 'reorder_node') {
    const node = requireScene(await getNode(args.nodeId)), parent = node.parent;
    if (!parent || !parent.insertChild || parent.type === 'INSTANCE') throw new Error('Cannot reorder this node.');
    const index = parent.children.indexOf(node), last = parent.children.length - 1;
    const target = args.position === 'FRONT' ? last : args.position === 'BACK' ? 0 : args.position === 'FORWARD' ? Math.min(last, index + 1) : Math.max(0, index - 1);
    parent.insertChild(target, node); figma.commitUndo(); return { id: node.id, index: parent.children.indexOf(node) };
  }
  if (command === 'create_paint_style') {
    const style = figma.createPaintStyle();
    try { style.name = args.name; style.paints = [{ type: 'SOLID', color: rgb(args.color), opacity: args.opacity }]; }
    catch (error) { style.remove(); throw error; }
    figma.commitUndo(); return { id: style.id, name: style.name, type: style.type };
  }
  if (command === 'create_text_style') {
    const font = { family: args.fontFamily, style: args.fontStyle };
    await figma.loadFontAsync(font);
    const style = figma.createTextStyle();
    try { style.name = args.name; style.fontName = font; style.fontSize = args.fontSize; }
    catch (error) { style.remove(); throw error; }
    figma.commitUndo(); return { id: style.id, name: style.name, type: style.type };
  }
  if (command === 'apply_styles') {
    const node = requireScene(await getNode(args.nodeId));
    const settings = [];
    for (const [key, type, method] of [['fillStyleId', 'PAINT', 'setFillStyleIdAsync'], ['textStyleId', 'TEXT', 'setTextStyleIdAsync'], ['effectStyleId', 'EFFECT', 'setEffectStyleIdAsync']]) {
      if (args[key] === undefined) continue;
      const style = await figma.getStyleByIdAsync(args[key]);
      if (!style || style.type !== type || typeof node[method] !== 'function' || (type === 'TEXT' && node.type !== 'TEXT')) throw new Error('Style type or node capability mismatch: ' + key);
      if (type === 'TEXT') await figma.loadFontAsync(style.fontName);
      settings.push([method, args[key]]);
    }
    if (!settings.length) throw new Error('Provide at least one style ID.');
    if (node.type === 'TEXT') await loadNodeFonts(node);
    try { for (const [method, id] of settings) await node[method](id); }
    finally { figma.commitUndo(); }
    return { id: node.id, fillStyleId: node.fillStyleId, textStyleId: node.textStyleId, effectStyleId: node.effectStyleId };
  }
  if (command === 'get_variables') {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    return { collections: collections.slice(0, 200).map(collectionSummary), collectionTotal: collections.length,
      variables: variables.slice(args.offset, args.offset + args.limit).map(variableSummary), total: variables.length,
      nextOffset: args.offset + args.limit < variables.length ? args.offset + args.limit : null };
  }
  if (command === 'create_variable_collection') {
    const collection = figma.variables.createVariableCollection(args.name);
    try {
      collection.renameMode(collection.defaultModeId, args.modes[0]);
      for (const name of args.modes.slice(1)) collection.addMode(name);
    } catch (error) { collection.remove(); throw error; }
    figma.commitUndo(); return collectionSummary(collection);
  }
  if (command === 'create_variable') {
    const collection = await getCollection(args.collectionId);
    if (new Set(args.values.map(entry => entry.modeId)).size !== args.values.length) throw new Error('Mode IDs must be unique.');
    for (const entry of args.values) { requireMode(collection, entry.modeId); validateVariableValue(args.type, entry.value); }
    const variable = figma.variables.createVariable(args.name, collection, args.type);
    try { for (const entry of args.values) variable.setValueForMode(entry.modeId, entry.value); }
    catch (error) { variable.remove(); throw error; }
    figma.commitUndo(); return variableSummary(variable);
  }
  if (command === 'set_variable') {
    const variable = await getVariable(args.variableId), collection = await getCollection(variable.variableCollectionId);
    requireMode(collection, args.modeId); validateVariableValue(variable.resolvedType, args.value);
    variable.setValueForMode(args.modeId, args.value); figma.commitUndo(); return variableSummary(variable);
  }
  if (command === 'bind_variable') {
    const node = requireScene(await getNode(args.nodeId)), variable = await getVariable(args.variableId);
    if (args.field === 'fill') {
      if (variable.resolvedType !== 'COLOR' || !Array.isArray(node.fills) || node.fills.length !== 1 || node.fills[0].type !== 'SOLID') throw new Error('Fill binding requires a COLOR variable and one solid fill.');
      if (node.type === 'TEXT') await loadNodeFonts(node);
      node.fills = [figma.variables.setBoundVariableForPaint(node.fills[0], 'color', variable)];
    } else {
      if (variable.resolvedType !== 'FLOAT' || !(args.field in node) || !node.setBoundVariable) throw new Error('Numeric binding requires a FLOAT variable and a supported property.');
      node.setBoundVariable(args.field, variable);
    }
    figma.commitUndo(); return { id: node.id, field: args.field, variableId: variable.id };
  }
  if (command === 'set_variable_mode') {
    const node = requireScene(await getNode(args.nodeId)), collection = await getCollection(args.collectionId);
    requireMode(collection, args.modeId);
    node.setExplicitVariableModeForCollection(collection, args.modeId); figma.commitUndo();
    return { id: node.id, collectionId: collection.id, modeId: args.modeId };
  }
  if (command === 'set_responsive') {
    const node = requireScene(await getNode(args.nodeId)), props = args.properties;
    for (const key of Object.keys(props)) if (!(key in node)) throw new Error('Unsupported layout property: ' + key);
    const autoParent = node.parent && node.parent.layoutMode && node.parent.layoutMode !== 'NONE';
    const autoFrame = node.layoutMode && node.layoutMode !== 'NONE';
    for (const key of ['layoutSizingHorizontal', 'layoutSizingVertical']) {
      if (props[key] === 'FILL' && !autoParent) throw new Error('FILL needs an auto-layout parent.');
      if (props[key] === 'HUG' && node.type !== 'TEXT' && !autoFrame) throw new Error('HUG needs text or an auto-layout frame.');
    }
    if ((props.primaryAxisAlignItems !== undefined || props.counterAxisAlignItems !== undefined) && !autoFrame) throw new Error('Axis alignment needs an auto-layout frame.');
    for (const axis of ['Width', 'Height']) {
      const min = props['min' + axis] === undefined ? node['min' + axis] : props['min' + axis];
      const max = props['max' + axis] === undefined ? node['max' + axis] : props['max' + axis];
      if (min !== null && max !== null && min !== undefined && max !== undefined && min > max) throw new Error('Minimum size exceeds maximum size.');
    }
    try { for (const key of Object.keys(props)) node[key] = props[key]; }
    finally { figma.commitUndo(); }
    return { id: node.id, properties: props };
  }
  if (command === 'combine_variants') {
    const nodes = await siblings(args.nodeIds);
    if (nodes.some(node => node.type !== 'COMPONENT')) throw new Error('All variants must be COMPONENT nodes.');
    if (new Set(nodes.map(node => node.name)).size !== nodes.length) throw new Error('Variant names must be unique.');
    const set = figma.combineAsVariants(nodes, nodes[0].parent); set.name = args.name;
    figma.commitUndo(); return snapshot(set, 0, budget);
  }
  if (command === 'get_component_properties') {
    const node = await getNode(args.nodeId);
    if (!['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(node.type)) throw new Error('A component, component set or instance is required.');
    return { id: node.id, properties: node.type === 'INSTANCE' ? node.componentProperties : node.componentPropertyDefinitions };
  }
  if (command === 'set_instance_properties') {
    const node = await getNode(args.nodeId);
    if (node.type !== 'INSTANCE') throw new Error('An INSTANCE node is required.');
    for (const [key, value] of Object.entries(args.properties)) {
      const property = node.componentProperties[key];
      if (!property || !['TEXT', 'BOOLEAN', 'VARIANT', 'INSTANCE_SWAP'].includes(property.type)) throw new Error('Unknown or unsupported component property: ' + key);
      if (typeof value !== (property.type === 'BOOLEAN' ? 'boolean' : 'string')) throw new Error('Component property value type mismatch: ' + key);
    }
    node.setProperties(args.properties); figma.commitUndo(); return { id: node.id, properties: node.componentProperties };
  }
  if (command === 'batch_update') {
    const nodes = await Promise.all(args.nodeIds.map(async id => requireScene(await getNode(id))));
    for (const node of nodes) validateProperties(node, args.properties);
    const updated = [], failed = [];
    try {
      for (const node of nodes) {
        try { await applyProperties(node, args.properties); updated.push(node.id); }
        catch (error) { failed.push({ id: node.id, error: error.message }); }
      }
    } finally { figma.commitUndo(); }
    return { updated, failed, partial: failed.length > 0 };
  }
  if (command === 'audit_design') return auditDesign(args);
}
