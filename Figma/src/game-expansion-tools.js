import { z } from 'zod';
import { saveGameAssets, saveGameData } from './game-assets.js';

export function registerGameExpansion(live, tool, schemas, bridge, { nodeId, nodeIds, color }) {
  const idName = z.string().min(1).max(200), name = z.string().min(1).max(500);
  const placement = { parentId: nodeId.optional(), name, x: z.number().finite().default(0), y: z.number().finite().default(0) };
  const font = { fontFamily: z.string().min(1).max(100).default('Inter'), fontStyle: z.string().min(1).max(100).default('Regular') };
  const root = { rootId: nodeId, maxNodes: z.number().int().min(1).max(2000).default(1000) };
  const translations = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/), z.string().max(5000)).refine(values => Object.keys(values).length <= 500, 'At most 500 translations.');
  const locale = { ...root, locale: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), translations, fontFamily: z.string().min(1).max(100).optional(), fontStyle: z.string().min(1).max(100).default('Regular') };
  live('set_localization_key', 'Bind a stable localization key to a text node.', { nodeId, key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/) }, false, true);
  live('apply_localization', 'Apply supplied translations to bound text nodes and measure fixed-box overflow. No automatic translation; returns missing keys and partial failures.', locale, false, true);
  live('preview_localization', 'Clone a screen, apply supplied translations, and report long-text overflow without editing the source. At most 200 text nodes.', locale, false);
  live('preview_resolutions', 'Clone a screen at requested resolutions, remap game IDs, reapply HUD anchors, and report layout issues. Source stays unchanged.', {
    ...root, views: z.array(z.object({ name, width: z.number().int().min(64).max(8192), height: z.number().int().min(64).max(8192) }).strict()).min(1).max(4)
  }, false);
  live('create_state_sheet', 'Create labeled comparison instances for a VARIANT property (e.g. State). Source instance stays unchanged.', {
    nodeId, name, property: idName.default('State'), states: z.array(idName).min(1).max(12).default(['Default', 'Focused', 'Pressed', 'Disabled']), ...font
  }, false);
  const prompt = { ...placement, ...font, device: z.enum(['KEYBOARD', 'XBOX', 'PLAYSTATION']).default('KEYBOARD'), action: z.enum(['CONFIRM', 'CANCEL', 'INTERACT', 'MENU']), label: z.string().min(1).max(200) };
  live('create_input_prompt', 'Create a labeled generic keyboard/Xbox/PlayStation input glyph. These are authoring symbols, not official licensed artwork.', prompt, false);
  live('set_input_device', 'Switch a previously created input prompt glyph while preserving its label.', { nodeId, device: prompt.device }, false, true);
  live('create_inventory', 'Create a labeled item grid with selection and a directional focus graph. Maximum 200 slots.', {
    ...placement, ...font, rows: z.number().int().min(1).max(20), columns: z.number().int().min(1).max(20),
    slotSize: z.number().int().min(32).max(256).default(72), gap: z.number().int().min(0).max(64).default(8),
    background: color.default('#202A3A'), focusColor: color.default('#67D8FF')
  }, false);
  live('set_inventory_item', 'Update an inventory slot item label and quantity. Empty itemName clears the slot label.', { nodeId, index: z.number().int().min(0).max(199), itemName: z.string().max(200), quantity: z.number().int().min(1).max(9999).default(1) }, false, true);
  live('select_inventory_slot', 'Move the authored selection outline to one inventory slot.', { nodeId, index: z.number().int().min(0).max(199) }, false, true);
  live('create_cooldown', 'Create a circular normalized remaining-time indicator and optional seconds label. No runtime timer.', {
    ...placement, ...font, size: z.number().int().min(32).max(512).default(64), value: z.number().min(0).max(1).default(1),
    innerRadius: z.number().min(0).max(0.95).default(0), seconds: z.number().min(0).max(1000000).optional(), color: color.default('#67D8FF')
  }, false);
  live('set_cooldown', 'Update a circular cooldown created by this plugin; zero hides its sweep.', { nodeId, value: z.number().min(0).max(1), seconds: z.number().min(0).max(1000000).optional() }, false, true);
  const tooltip = { targetId: nodeId, preferred: z.enum(['ABOVE', 'BELOW', 'LEFT', 'RIGHT']).default('ABOVE'), gap: z.number().min(0).max(128).default(8), margin: z.number().min(0).max(128).default(8) };
  live('create_tooltip', 'Create a measured tooltip inside a screen; flip or clamp near edges. Target must be an unrotated descendant of the parent frame.', {
    ...placement, ...font, ...tooltip, text: z.string().min(1).max(2000), width: z.number().int().min(64).max(2048).default(280)
  }, false);
  live('position_tooltip', 'Reposition an existing tooltip near a target in its parent frame.', { nodeId, ...tooltip }, false, true);
  live('audit_game_focus', 'Check a stored focus graph for missing/disabled targets, invalid edges, unreachable controls and asymmetric links.', root);
  const atlas = {
    assets: z.array(z.object({ nodeId, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/) }).strict()).min(1).max(32)
      .refine(items => new Set(items.map(item => item.name)).size === items.length, 'Sprite names must be unique.'),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).default('atlas'), scale: z.number().min(0.25).max(4).default(1),
    maxWidth: z.number().int().min(64).max(4096).default(1024), maxHeight: z.number().int().min(64).max(4096).default(4096),
    padding: z.number().int().min(1).max(32).default(2), powerOfTwo: z.boolean().default(true)
  };
  schemas.set('export_game_atlas', z.object(atlas).strict());
  tool('figma_export_game_atlas', 'Pack up to 32 unrotated sprites into one PNG and coordinate JSON. Clones are cleaned up. Outer effects are clipped; no edge extrusion, mipmap generation or engine import.', {
    ...atlas, outputDirectory: z.string().min(1).max(4000).optional()
  }, async ({ outputDirectory, ...args }) => saveGameAssets(await bridge.request('export_game_atlas', args), outputDirectory), false);
  for (const [command, filename, description] of [
    ['export_localization', 'localization.json', 'Export bound text keys and current source strings to JSON. Reports conflicting duplicate keys. No automatic translation.'],
    ['export_ui_spec', 'ui-spec.json', 'Export a bounded game UI hierarchy, layout, text/style IDs and game metadata to JSON. No engine code generation.']
  ]) {
    schemas.set(command, z.object(root).strict());
    tool('figma_' + command, description, { ...root, outputDirectory: z.string().min(1).max(4000).optional() },
      async ({ outputDirectory, ...args }) => {
        const data = await bridge.request(command, args);
        return { ...await saveGameData(data, filename, outputDirectory), data };
      }, false);
  }
}
