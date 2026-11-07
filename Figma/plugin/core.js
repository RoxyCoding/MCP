figma.showUI(__html__, { width: 340, height: 400, themeColors: true });

function snapshot(node, depth, budget) {
  if (--budget.remaining < 0) throw new Error('Too many nodes (limit 1000). Use a smaller depth or get_node.');
  const result = { id: node.id, type: node.type, name: node.name };
  const keys = ['x', 'y', 'width', 'height', 'opacity', 'cornerRadius', 'characters', 'fontSize', 'fontName',
    'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'effects', 'textAlignHorizontal', 'textDecoration', 'lineHeight', 'letterSpacing', 'paragraphSpacing',
    'layoutMode', 'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'constraints', 'layoutSizingHorizontal', 'layoutSizingVertical',
    'primaryAxisAlignItems', 'counterAxisAlignItems', 'clipsContent', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'fillStyleId', 'textStyleId', 'effectStyleId'];
  for (const key of keys) if (key in node && typeof node[key] !== 'symbol') result[key] = node[key];
  if ('children' in node) {
    result.childCount = node.children.length;
    if (depth > 0) result.children = node.children.map(child => snapshot(child, depth - 1, budget));
  }
  return result;
}

async function getNode(id) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.removed) throw new Error('Node not found: ' + id);
  return node;
}

function requireScene(node) {
  if (['DOCUMENT', 'PAGE'].includes(node.type)) throw new Error('A scene node is required.');
  return node;
}

async function getParent(id) {
  const node = id ? await getNode(id) : figma.currentPage;
  if (!['PAGE', 'FRAME', 'COMPONENT', 'GROUP'].includes(node.type)) throw new Error('Parent must be a page, frame, component or group.');
  if (node.type === 'PAGE') await node.loadAsync();
  return node;
}

function preventCycle(node, parent) {
  for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor === node) throw new Error('Cannot move a node into itself or its descendants.');
    if (ancestor.type === 'INSTANCE') throw new Error('Cannot reparent inside an instance.');
  }
}

async function placeNew(node, parent, args) {
  try {
    parent.appendChild(node);
    for (const key of ['name', 'x', 'y']) if (args[key] !== undefined) node[key] = args[key];
    figma.commitUndo();
    return snapshot(node, 0, { remaining: 1000 });
  } catch (error) { node.remove(); throw error; }
}

async function siblings(ids) {
  const nodes = await Promise.all(ids.map(async id => requireScene(await getNode(id))));
  if (nodes.some(node => node.parent !== nodes[0].parent)) throw new Error('Nodes must have the same parent.');
  if (nodes[0].parent.type === 'INSTANCE') throw new Error('Cannot reorganize instance children.');
  return nodes;
}

function rgb(hex) {
  return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 };
}

const textKeys = ['characters', 'fontSize', 'fontFamily', 'fontStyle', 'textAlignHorizontal', 'textDecoration', 'lineHeight', 'letterSpacing', 'paragraphSpacing'];
const layoutKeys = ['layoutMode', 'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
const allowedKeys = ['name', 'x', 'y', 'width', 'height', 'fill', 'opacity', 'cornerRadius'].concat(textKeys, layoutKeys);

async function applyProperties(node, properties) {
  validateProperties(node, properties);
  if (node.type === 'TEXT' && (textKeys.some(key => properties[key] !== undefined) || properties.fill !== undefined)) {
    if (properties.fontFamily !== undefined || properties.fontStyle !== undefined) {
      if (node.fontName === figma.mixed && (!properties.fontFamily || !properties.fontStyle)) throw new Error('Mixed fonts: specify both fontFamily and fontStyle.');
      const font = { family: properties.fontFamily || node.fontName.family, style: properties.fontStyle || node.fontName.style };
      await figma.loadFontAsync(font); node.fontName = font;
    } else await loadNodeFonts(node);
  }
  if (properties.width !== undefined || properties.height !== undefined) node.resize(properties.width === undefined ? node.width : properties.width, properties.height === undefined ? node.height : properties.height);
  for (const key of allowedKeys) {
    if (properties[key] === undefined || ['width', 'height', 'fontFamily', 'fontStyle'].includes(key)) continue;
    if (key === 'fill') node.fills = [{ type: 'SOLID', color: rgb(properties.fill) }];
    else node[key] = properties[key];
  }
}

function validateProperties(node, properties) {
  for (const key of Object.keys(properties)) {
    if (!allowedKeys.includes(key)) throw new Error('Unsupported property: ' + key);
    const target = key === 'fill' ? 'fills' : textKeys.includes(key) ? 'characters' : key;
    if (!(target in node)) throw new Error('Property not supported by this node: ' + key);
  }
}

async function loadNodeFonts(node) {
  const fonts = node.fontName === figma.mixed ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
  await Promise.all(fonts.map(font => figma.loadFontAsync(font)));
}

async function execute(command, args) {
  for (const handler of [executeGameLocalization, executeGamePreviews, executeGameWidgets, executeGamePackaging]) {
    const result = await handler(command, args);
    if (result !== undefined) return result;
  }
  const gameResult = await executeGame(command, args);
  if (gameResult !== undefined) return gameResult;
  const proResult = await executePro(command, args);
  if (proResult !== undefined) return proResult;
  const budget = { remaining: 1000 };
  if (command === 'get_document') {
    await figma.currentPage.loadAsync();
    return { name: figma.root.name, pages: figma.root.children.map(page => ({ id: page.id, name: page.name })),
      currentPage: snapshot(figma.currentPage, args.depth, budget) };
  }
  if (command === 'get_selection') return figma.currentPage.selection.map(node => snapshot(node, args.depth, budget));
  if (command === 'get_node') return snapshot(await getNode(args.nodeId), args.depth, budget);
  if (command === 'find_nodes') {
    const root = args.rootId ? await getNode(args.rootId) : figma.currentPage;
    if (root.type === 'DOCUMENT') throw new Error('Search one page or subtree at a time.');
    if (root.type === 'PAGE') await root.loadAsync();
    const stack = [root], matches = [];
    const query = args.query.toLowerCase();
    let visited = 0, truncated = false;
    while (stack.length && visited < 20000) {
      const node = stack.pop(); visited++;
      if (node.type !== 'PAGE' && node.name.toLowerCase().includes(query) && (!args.types || !args.types.length || args.types.includes(node.type))) {
        if (matches.length === args.limit) { truncated = true; break; }
        matches.push(snapshot(node, 0, budget));
      }
      if ('children' in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    return { nodes: matches, visited, truncated: truncated || stack.length > 0 };
  }
  if (command === 'get_fonts') {
    const query = args.query.toLowerCase();
    const fonts = (await figma.listAvailableFontsAsync()).map(font => font.fontName)
      .filter(font => (font.family + ' ' + font.style).toLowerCase().includes(query));
    return { fonts: fonts.slice(args.offset, args.offset + args.limit), total: fonts.length,
      nextOffset: args.offset + args.limit < fonts.length ? args.offset + args.limit : null };
  }
  if (command === 'get_local_styles') {
    const result = {};
    for (const [key, method] of [['paint', 'getLocalPaintStylesAsync'], ['text', 'getLocalTextStylesAsync'],
      ['effect', 'getLocalEffectStylesAsync'], ['grid', 'getLocalGridStylesAsync']]) {
      const styles = await figma[method]();
      result[key] = { styles: styles.slice(0, 200).map(style => ({ id: style.id, name: style.name })), total: styles.length };
    }
    return result;
  }
  if (command === 'create_page') {
    const page = figma.createPage(); page.name = args.name; figma.commitUndo();
    return { id: page.id, name: page.name, type: page.type };
  }
  if (command === 'set_current_page') {
    const page = await getNode(args.pageId);
    if (page.type !== 'PAGE') throw new Error('pageId must refer to a page.');
    await figma.setCurrentPageAsync(page);
    return { id: page.id, name: page.name, type: page.type };
  }
  if (command === 'duplicate_node') {
    const node = requireScene(await getNode(args.nodeId));
    const parent = await getParent(args.parentId || node.parent.id);
    return placeNew(node.clone(), parent, args);
  }
  if (command === 'move_node') {
    const node = requireScene(await getNode(args.nodeId));
    const parent = await getParent(args.parentId);
    preventCycle(node, parent);
    parent.appendChild(node);
    if (args.x !== undefined) node.x = args.x;
    if (args.y !== undefined) node.y = args.y;
    figma.commitUndo();
    return snapshot(node, 0, budget);
  }
  if (command === 'import_svg') {
    const parent = await getParent(args.parentId);
    return placeNew(figma.createNodeFromSvg(args.svg), parent, args);
  }
  if (command === 'group_nodes') {
    const nodes = await siblings(args.nodeIds);
    const group = figma.group(nodes, nodes[0].parent);
    if (args.name !== undefined) group.name = args.name;
    figma.commitUndo(); return snapshot(group, 0, budget);
  }
  if (command === 'ungroup_node') {
    const node = await getNode(args.nodeId);
    if (node.type !== 'GROUP') throw new Error('Only GROUP nodes can be ungrouped.');
    const nodes = figma.ungroup(node); figma.commitUndo();
    return nodes.map(child => snapshot(child, 0, budget));
  }
  if (command === 'align_nodes') {
    const nodes = await siblings(args.nodeIds);
    if (nodes[0].parent.type === 'GROUP') throw new Error('Align nodes inside a page or frame, not an auto-resizing group.');
    if (nodes[0].parent.layoutMode && nodes[0].parent.layoutMode !== 'NONE') throw new Error('Manual alignment is unavailable in auto-layout parents.');
    if (nodes.some(node => node.rotation !== undefined && node.rotation !== 0)) throw new Error('Alignment requires unrotated nodes.');
    const left = Math.min(...nodes.map(node => node.x)), top = Math.min(...nodes.map(node => node.y));
    const right = Math.max(...nodes.map(node => node.x + node.width)), bottom = Math.max(...nodes.map(node => node.y + node.height));
    for (const node of nodes) {
      if (args.alignment === 'LEFT') node.x = left;
      if (args.alignment === 'CENTER') node.x = (left + right - node.width) / 2;
      if (args.alignment === 'RIGHT') node.x = right - node.width;
      if (args.alignment === 'TOP') node.y = top;
      if (args.alignment === 'MIDDLE') node.y = (top + bottom - node.height) / 2;
      if (args.alignment === 'BOTTOM') node.y = bottom - node.height;
    }
    figma.commitUndo(); return nodes.map(node => snapshot(node, 0, budget));
  }
  if (command === 'create_component') {
    const component = figma.createComponentFromNode(requireScene(await getNode(args.nodeId)));
    figma.commitUndo(); return snapshot(component, 0, budget);
  }
  if (command === 'create_instance') {
    const component = await getNode(args.componentId);
    if (component.type !== 'COMPONENT') throw new Error('componentId must refer to a local component.');
    const parent = await getParent(args.parentId);
    return placeNew(component.createInstance(), parent, args);
  }
  if (command === 'place_image') {
    if (args.nodeId && args.parentId) throw new Error('Cannot specify both nodeId and parentId.');
    const existing = args.nodeId ? requireScene(await getNode(args.nodeId)) : null;
    if (existing && !('fills' in existing)) throw new Error('This node does not support image fills.');
    const parent = existing ? null : await getParent(args.parentId);
    const bytes = figma.base64Decode(args.dataBase64);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Image exceeds 8 MiB.');
    const image = figma.createImage(bytes);
    const size = await image.getSizeAsync();
    const node = existing || figma.createRectangle();
    try {
      if (parent) parent.appendChild(node);
      const props = {};
      for (const key of ['name', 'x', 'y', 'width', 'height']) if (args[key] !== undefined) props[key] = args[key];
      if (!existing) { props.width = args.width || size.width; props.height = args.height || size.height; }
      await applyProperties(node, props);
      node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: args.scaleMode }];
      figma.commitUndo(); return snapshot(node, 0, budget);
    } catch (error) {
      if (!existing) node.remove();
      else figma.commitUndo();
      throw error;
    }
  }
  if (command === 'set_text_style') {
    const node = await getNode(args.nodeId);
    if (node.type !== 'TEXT') throw new Error('Text styling requires a TEXT node.');
    try { await applyProperties(node, args.properties); }
    finally { figma.commitUndo(); }
    return snapshot(node, 0, budget);
  }
  if (command === 'set_appearance') {
    const node = requireScene(await getNode(args.nodeId));
    if (args.stroke === undefined && args.effects === undefined) throw new Error('Provide stroke or effects.');
    if (args.stroke !== undefined && !('strokes' in node && 'strokeWeight' in node && 'strokeAlign' in node)) throw new Error('This node does not support strokes.');
    if (args.effects !== undefined && !('effects' in node)) throw new Error('This node does not support effects.');
    const effects = args.effects && args.effects.map(effect => {
      if (effect.type.endsWith('BLUR')) return { type: effect.type, blurType: 'NORMAL', radius: effect.radius, visible: true };
      return { type: effect.type, color: Object.assign(rgb(effect.color), { a: effect.opacity }),
        offset: { x: effect.x, y: effect.y }, radius: effect.radius, visible: true, blendMode: 'NORMAL' };
    });
    try {
      if (args.stroke !== undefined) {
        if (args.stroke === null) node.strokes = [];
        else {
          node.strokeWeight = args.stroke.width; node.strokeAlign = args.stroke.align;
          node.strokes = [{ type: 'SOLID', color: rgb(args.stroke.color), opacity: args.stroke.opacity }];
        }
      }
      if (effects !== undefined) node.effects = effects;
    } finally { figma.commitUndo(); }
    return snapshot(node, 0, budget);
  }
  if (command === 'distribute_nodes') {
    const nodes = await siblings(args.nodeIds);
    const parent = nodes[0].parent;
    if (parent.type === 'GROUP' || (parent.layoutMode && parent.layoutMode !== 'NONE')) throw new Error('Distribution requires a page or a frame without auto-layout.');
    if (nodes.some(node => node.rotation !== undefined && node.rotation !== 0)) throw new Error('Distribution requires unrotated nodes.');
    const position = args.axis === 'HORIZONTAL' ? 'x' : 'y';
    const dimension = args.axis === 'HORIZONTAL' ? 'width' : 'height';
    nodes.sort((a, b) => a[position] - b[position]);
    const start = nodes[0][position];
    const end = Math.max(...nodes.map(node => node[position] + node[dimension]));
    const sizes = nodes.reduce((sum, node) => sum + node[dimension], 0);
    const gap = args.gap === undefined ? (end - start - sizes) / (nodes.length - 1) : args.gap;
    if (gap < 0) throw new Error('Combined bounds are too small for non-overlapping gaps. Specify gap explicitly.');
    let offset = start;
    try { for (const node of nodes) { node[position] = offset; offset += node[dimension] + gap; } }
    finally { figma.commitUndo(); }
    return { nodes: nodes.map(node => snapshot(node, 0, budget)), gap };
  }
  if (command === 'create_node') {
    const parent = args.parentId ? await getNode(args.parentId) : figma.currentPage;
    if (!['PAGE', 'FRAME', 'COMPONENT'].includes(parent.type)) throw new Error('Parent must be a page, frame or component.');
    const factories = { FRAME: () => figma.createFrame(), RECTANGLE: () => figma.createRectangle(),
      ELLIPSE: () => figma.createEllipse(), TEXT: () => figma.createText() };
    if (!factories[args.type]) throw new Error('Unsupported node type.');
    const node = factories[args.type]();
    try {
      parent.appendChild(node);
      await applyProperties(node, args.properties);
      figma.commitUndo();
      return snapshot(node, 0, budget);
    } catch (error) { node.remove(); throw error; }
  }
  if (command === 'update_node') {
    const node = await getNode(args.nodeId);
    if (node.type === 'DOCUMENT' || node.type === 'PAGE') throw new Error('Only scene nodes can be updated.');
    try { await applyProperties(node, args.properties); }
    catch (error) { throw new Error(error.message + ' Inspect the node; changes may be partial. Use Figma undo if needed.'); }
    finally { figma.commitUndo(); }
    return snapshot(node, 0, budget);
  }
  if (command === 'delete_node') {
    if (args.confirm !== true) throw new Error('Deletion requires confirm=true.');
    const node = await getNode(args.nodeId);
    if (['DOCUMENT', 'PAGE'].includes(node.type)) throw new Error('Document and page deletion is not supported.');
    node.remove(); figma.commitUndo();
    return { deleted: args.nodeId };
  }
  if (command === 'select_nodes') {
    const nodes = await Promise.all(args.nodeIds.map(getNode));
    let page;
    for (const node of nodes) {
      if (['DOCUMENT', 'PAGE'].includes(node.type)) throw new Error('Select scene nodes only.');
      let ancestor = node.parent;
      while (ancestor && ancestor.type !== 'PAGE') ancestor = ancestor.parent;
      if (!ancestor || (page && page !== ancestor)) throw new Error('All selected nodes must belong to the same page.');
      page = ancestor;
    }
    await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
    return nodes.map(node => snapshot(node, 0, budget));
  }
  if (command === 'export_node') {
    const node = await getNode(args.nodeId);
    if (!node.exportAsync) throw new Error('This node cannot be exported.');
    if (args.format === 'SVG') return { format: 'SVG', data: await node.exportAsync({ format: 'SVG_STRING' }) };
    const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: args.scale } });
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Image exceeds 8 MiB. Reduce scale.');
    return { format: 'PNG', data: figma.base64Encode(bytes) };
  }
  throw new Error('Unknown command: ' + command);
}

let queue = Promise.resolve();
figma.ui.onmessage = message => {
  if (message && message.type === 'load-connection') {
    figma.clientStorage.getAsync('connection').then(config => {
      figma.ui.postMessage({ type: 'connection-config', config });
    }).catch(() => figma.ui.postMessage({ type: 'connection-config', config: null }));
    return;
  }
  if (message && message.type === 'save-connection') {
    const config = message.config;
    if (!config || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== 'string' || config.token.length < 32 || config.token.length > 1000) return;
    figma.clientStorage.setAsync('connection', { port: config.port, token: config.token })
      .catch(() => figma.ui.postMessage({ type: 'connection-storage-error' }));
    return;
  }
  if (message && message.type === 'hide-ui') { figma.ui.hide(); return; }
  if (message && message.type === 'show-ui') { figma.ui.show(); return; }
  if (!message || message.type !== 'command' || typeof message.id !== 'string' || !message.args) return;
  queue = queue.then(async () => {
    try {
      const result = await execute(message.command, message.args);
      figma.ui.postMessage({ id: message.id, result });
    } catch (error) { figma.ui.postMessage({ id: message.id, error: error.message }); }
  }).catch(() => {});
};
