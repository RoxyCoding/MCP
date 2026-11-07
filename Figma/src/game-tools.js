import { z } from 'zod';
import { saveGameAssets } from './game-assets.js';

export function registerGameTools(live, tool, schemas, bridge, { nodeId, nodeIds, color }) {
  const dimension = z.number().int().min(1).max(8192), margin = z.number().int().min(0).max(4096);
  const borders = z.object({ left: margin, right: margin, top: margin, bottom: margin }).strict();
  const placement = { parentId: nodeId.optional(), x: z.number().finite().default(0), y: z.number().finite().default(0), name: z.string().min(1).max(500) };
  live('create_game_screen', 'Create a game screen with a transparent Safe Area child. Insets are logical pixels.', {
    ...placement, width: dimension.default(1920), height: dimension.default(1080), background: color.default('#10151F'),
    insets: borders.default({ left: 96, right: 96, top: 54, bottom: 54 })
  }, false);
  live('set_game_anchor', 'Position an unrotated node inside its frame using a game HUD anchor. STRETCH fills the frame with margins. Use the Safe Area frame as parent for safe placement.', {
    nodeId, anchor: z.enum(['TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'CENTER_LEFT', 'CENTER', 'CENTER_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT', 'STRETCH']),
    marginX: z.number().min(0).max(4096).default(16), marginY: z.number().min(0).max(4096).default(16)
  }, false, true);
  live('build_game_focus', 'Build and store a directional focus graph for visible sibling controls from spatial proximity. Engine input is not implemented.', {
    nodeIds: nodeIds.refine(ids => ids.length >= 2, 'At least two controls required.'), defaultNodeId: nodeId.optional()
  }, false, true);
  live('create_game_button', 'Create Default/Focused/Pressed/Disabled button variants with a focus outline. Engine interaction routing is separate.', {
    ...placement, label: z.string().min(1).max(200), width: dimension.default(240), height: dimension.default(64),
    fontFamily: z.string().min(1).max(100).default('Inter'), fontStyle: z.string().min(1).max(100).default('Regular'), fontSize: z.number().min(8).max(100).default(20),
    background: color.default('#263044'), textColor: color.default('#FFFFFF'), focusColor: color.default('#67D8FF')
  }, false);
  live('create_hud_bar', 'Create an HP/MP/progress bar with editable fill and normalized value.', {
    ...placement, width: dimension.default(320), height: dimension.default(24), value: z.number().min(0).max(1).default(1),
    direction: z.enum(['HORIZONTAL', 'VERTICAL']).default('HORIZONTAL'), trackColor: color.default('#273044'), fillColor: color.default('#4ADC86')
  }, false);
  live('set_hud_value', 'Update a bar created with create_hud_bar. Recomputes fill from current dimensions; zero hides it.', { nodeId, value: z.number().min(0).max(1) }, false, true);
  live('set_nine_slice', 'Store 9-slice borders in logical pixels on an unrotated asset. Export scales borders per PNG resolution; no engine importer is configured.', { nodeId, borders }, false, true);
  const assets = {
    assets: z.array(z.object({ nodeId, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/) }).strict()).min(1).max(4)
      .refine(items => new Set(items.map(item => item.name)).size === items.length, 'Asset names must be unique.'),
    scales: z.array(z.number().min(0.25).max(4)).min(1).max(3).default([1, 2]).refine(values => new Set(values).size === values.length, 'Scales must be unique.')
  };
  schemas.set('export_game_assets', z.object(assets).strict());
  tool('figma_export_game_assets', 'Export PNG files and manifest.json to a new local folder, including scaled 9-slice and game metadata. Maximum 8 images / 8 MiB total; no engine import.', {
    ...assets, outputDirectory: z.string().min(1).max(4000).optional()
  }, async ({ outputDirectory, ...args }) => {
    if (args.assets.length * args.scales.length > 8) throw new Error('Export at most 8 images per batch.');
    return saveGameAssets(await bridge.request('export_game_assets', args), outputDirectory);
  }, false);
}
