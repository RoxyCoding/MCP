import { png } from './png.js';

export function mockFigma(postMessage) {
  const nodes = new Map();
  let sequence = 0;
  const page = { id: '0:1', name: 'Page 1', type: 'PAGE', children: [], selection: [], loadAsync: async () => {} };
  const root = { id: '0:0', name: 'Test file', type: 'DOCUMENT', children: [page] };
  page.parent = root;
  nodes.set(page.id, page); nodes.set(root.id, root);
  function appendChild(node) {
    if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
    node.parent = this; this.children.push(node);
  }
  page.appendChild = appendChild;
  const figma = {
    root, currentPage: page, mixed: Symbol('mixed'), ui: { postMessage, hide() { this.hidden = true; }, show() { this.hidden = false; } }, showUI() {},
    viewport: { scrollAndZoomIntoView() {} }, commits: 0, commitUndo() { this.commits++; },
    getNodeByIdAsync: async id => nodes.get(id), setCurrentPageAsync: async p => { figma.currentPage = p; },
    loadFontAsync: async font => { if (font.family === 'Missing') throw new Error('Font not available'); },
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    base64Decode: text => new Uint8Array(Buffer.from(text, 'base64')),
    createImage: bytes => {
      if (bytes[0] !== 137 && bytes[0] !== 255) throw new Error('Invalid image');
      return { hash: 'test-image', getSizeAsync: async () => ({ width: 24, height: 16 }) };
    }
  };
  const styles = new Map(), collections = new Map(), variables = new Map();
  figma.getStyleByIdAsync = async id => styles.get(id);
  for (const [method, type] of [['createPaintStyle', 'PAINT'], ['createTextStyle', 'TEXT']]) {
    figma[method] = () => {
      const style = { id: 'style:' + ++sequence, type, name: '', paints: [], fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16,
        remove() { styles.delete(this.id); } };
      styles.set(style.id, style); return style;
    };
  }
  figma.variables = {
    getLocalVariableCollectionsAsync: async () => [...collections.values()], getLocalVariablesAsync: async () => [...variables.values()],
    getVariableCollectionByIdAsync: async id => collections.get(id), getVariableByIdAsync: async id => variables.get(id),
    createVariableCollection(name) {
      const collection = { id: 'collection:' + ++sequence, name, defaultModeId: 'mode:0', modes: [{ modeId: 'mode:0', name: 'Mode 1' }],
        renameMode(id, name) { this.modes.find(mode => mode.modeId === id).name = name; },
        addMode(name) { if (name === 'Restricted') throw new Error('Limited to 1 modes only'); const modeId = 'mode:' + this.modes.length; this.modes.push({ modeId, name }); return modeId; },
        remove() { collections.delete(this.id); } };
      collections.set(collection.id, collection); return collection;
    },
    createVariable(name, collection, type) {
      const variable = { id: 'variable:' + ++sequence, name, variableCollectionId: collection.id, resolvedType: type, valuesByMode: {},
        setValueForMode(id, value) { this.valuesByMode[id] = value; }, remove() { variables.delete(this.id); } };
      variables.set(variable.id, variable); return variable;
    },
    setBoundVariableForPaint: (paint, field, variable) => ({ ...paint, boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } } })
  };
  const storage = new Map();
  figma.clientStorage = { getAsync: async key => storage.get(key), setAsync: async (key, value) => storage.set(key, value) };
  figma.createPage = () => {
    const next = { id: '2:' + ++sequence, type: 'PAGE', name: 'Page', parent: root, children: [], selection: [], appendChild, loadAsync: async () => {} };
    root.children.push(next); nodes.set(next.id, next); return next;
  };
  figma.listAvailableFontsAsync = async () => ['Inter', 'Noto Sans JP'].map(family => ({ fontName: { family, style: 'Regular' } }));
  for (const method of ['getLocalPaintStylesAsync', 'getLocalTextStylesAsync', 'getLocalEffectStylesAsync', 'getLocalGridStylesAsync']) {
    figma[method] = async () => [{ id: 'style:1', name: 'Default' }];
  }
  for (const [type, factory] of Object.entries({ FRAME: 'createFrame', RECTANGLE: 'createRectangle', ELLIPSE: 'createEllipse', TEXT: 'createText' })) {
    figma[factory] = () => {
      const node = {
        id: '1:' + ++sequence, type, name: type, x: 0, y: 0, width: 100, height: 100, fills: [], opacity: 1,
        strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', effects: [],
        resize(width, height) {
          this.width = width; this.height = height;
          if (this.type === 'TEXT' && this.textAutoResize === 'HEIGHT') {
            const perLine = Math.max(1, Math.floor(width / (this.fontSize * 0.6)));
            this.height = this.characters.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / perLine)), 0) * this.fontSize * 1.2;
          }
        },
        remove() { if (this.children) for (const child of [...this.children]) child.remove(); this.removed = true; this.parent.children = this.parent.children.filter(child => child !== this); nodes.delete(this.id); },
        exportAsync: async settings => settings.format === 'SVG_STRING' ? '<svg/>' : new Uint8Array(png(Math.max(1, Math.ceil(node.width * (settings.constraint?.value || 1))), Math.max(1, Math.ceil(node.height * (settings.constraint?.value || 1)))))
      };
      const pluginData = new Map();
      node.getPluginData = key => pluginData.get(key) || '';
      node.setPluginData = (key, value) => pluginData.set(key, value);
      if (type === 'FRAME') Object.assign(node, { children: [], appendChild, layoutMode: 'NONE', itemSpacing: 0,
        paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, cornerRadius: 0 });
      if (type === 'RECTANGLE') node.cornerRadius = 0;
      if (type === 'TEXT') Object.assign(node, { characters: '', fontSize: 12, fontName: { family: 'Inter', style: 'Regular' }, textAutoResize: 'NONE',
        textAlignHorizontal: 'LEFT', textDecoration: 'NONE', lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 0 }, paragraphSpacing: 0,
        getRangeAllFontNames: () => [{ family: 'Inter', style: 'Regular' }] });
      nodes.set(node.id, node); page.appendChild(node); return node;
    };
  }
  function clone(source) {
    const factory = { FRAME: 'createFrame', RECTANGLE: 'createRectangle', ELLIPSE: 'createEllipse', TEXT: 'createText', GROUP: 'createFrame', COMPONENT: 'createFrame', INSTANCE: 'createFrame' }[source.type];
    const copy = figma[factory]();
    for (const key of ['name', 'x', 'y', 'width', 'height', 'characters', 'fontSize', 'fontName', 'textAutoResize', 'textAlignHorizontal', 'textAlignVertical', 'fills', 'strokes', 'effects', 'opacity', 'visible', 'constraints', 'layoutMode', 'layoutSizingHorizontal', 'layoutSizingVertical', 'clipsContent', 'arcData']) if (key in source) copy[key] = typeof source[key] === 'object' ? JSON.parse(JSON.stringify(source[key])) : source[key];
    copy.type = source.type;
    if (source.children) for (const child of source.children) copy.appendChild(clone(child));
    if (source.componentProperties) {
      copy.componentProperties = JSON.parse(JSON.stringify(source.componentProperties));
      copy.setProperties = values => {
        for (const [key, value] of Object.entries(values)) {
          if (!copy.componentProperties[key] || (key === 'State' && !['Default', 'Focused', 'Pressed', 'Disabled'].includes(value))) throw new Error('Invalid component property');
          copy.componentProperties[key].value = value;
        }
      };
    }
    return copy;
  }
  function insertChild(index, node) {
    if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
    node.parent = this; this.children.splice(index, 0, node);
  }
  page.insertChild = insertChild;
  for (const factory of ['createFrame', 'createRectangle', 'createEllipse', 'createText']) {
    const create = figma[factory];
    figma[factory] = () => {
      const node = create(); node.clone = () => clone(node);
      if (node.children) node.insertChild = insertChild;
      Object.assign(node, { constraints: { horizontal: 'MIN', vertical: 'MIN' }, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
        minWidth: null, maxWidth: null, minHeight: null, maxHeight: null, primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN', clipsContent: false, boundVariables: {}, explicitVariableModes: {},
        setBoundVariable(field, variable) { this.boundVariables[field] = { type: 'VARIABLE_ALIAS', id: variable.id }; },
        setExplicitVariableModeForCollection(collection, modeId) { this.explicitVariableModes[collection.id] = modeId; },
        setFillStyleIdAsync: async id => { node.fillStyleId = id; }, setTextStyleIdAsync: async id => { node.textStyleId = id; }, setEffectStyleIdAsync: async id => { node.effectStyleId = id; }
      });
      return node;
    };
  }
  figma.createNodeFromSvg = svg => { if (!svg.includes('<svg')) throw new Error('Invalid SVG'); return figma.createFrame(); };
  figma.group = (children, parent) => { const group = figma.createFrame(); group.type = 'GROUP'; parent.appendChild(group); children.forEach(child => group.appendChild(child)); return group; };
  figma.ungroup = group => { const children = [...group.children]; children.forEach(child => group.parent.appendChild(child)); group.remove(); return children; };
  figma.createComponentFromNode = node => {
    if (node.type === 'COMPONENT') throw new Error('Already a component');
    node.type = 'COMPONENT'; node.componentPropertyDefinitions = { Label: { type: 'TEXT', defaultValue: 'Button' }, Enabled: { type: 'BOOLEAN', defaultValue: true } };
    node.createInstance = () => {
      const instance = clone(node); instance.type = 'INSTANCE'; instance.componentProperties = { Label: { type: 'TEXT', value: 'Button' }, Enabled: { type: 'BOOLEAN', value: true } };
      if (node.name.startsWith('State=')) instance.componentProperties.State = { type: 'VARIANT', value: node.name.slice(6) };
      instance.setProperties = values => { for (const [key, value] of Object.entries(values)) { if (!instance.componentProperties[key] || (key === 'State' && !['Default', 'Focused', 'Pressed', 'Disabled'].includes(value))) throw new Error('Invalid component property'); instance.componentProperties[key].value = value; } }; return instance;
    }; return node;
  };
  figma.combineAsVariants = (components, parent) => { const set = figma.createFrame(); set.type = 'COMPONENT_SET'; parent.appendChild(set); components.forEach(component => set.appendChild(component)); set.componentPropertyDefinitions = {}; return set; };
  figma.createComponent = () => figma.createComponentFromNode(figma.createFrame());
  return figma;
}

