import { z } from 'zod';

export function registerProTools(live, { nodeId, nodeIds, color, properties }) {
  const id = z.string().min(1).max(300);
  const name = z.string().min(1).max(500);
  const rgba = z.object({ r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1), a: z.number().min(0).max(1).default(1) }).strict();
  const value = z.union([rgba, z.number().finite(), z.boolean(), z.string().max(10000)]);
  live('set_gradient', 'Replace fills with a gradient. Stops must be sorted from 0 to 1. angle is degrees for the gradient transform.', {
    nodeId, type: z.enum(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']).default('GRADIENT_LINEAR'),
    angle: z.number().min(-360).max(360).default(0),
    stops: z.array(z.object({ position: z.number().min(0).max(1), color, opacity: z.number().min(0).max(1).default(1) }).strict()).min(2).max(20)
      .refine(stops => stops.every((stop, i) => !i || stop.position >= stops[i - 1].position), 'Stops must be sorted.')
  }, false, true);
  live('reorder_node', 'Change one node stacking order within its existing parent.', { nodeId, position: z.enum(['FRONT', 'BACK', 'FORWARD', 'BACKWARD']) }, false, true);
  live('create_paint_style', 'Create a reusable solid-color paint style.', { name, color, opacity: z.number().min(0).max(1).default(1) }, false);
  live('create_text_style', 'Create a reusable text style after loading its font.', {
    name, fontFamily: z.string().min(1).max(100).default('Inter'), fontStyle: z.string().min(1).max(100).default('Regular'), fontSize: z.number().positive().max(1000).default(16)
  }, false);
  live('apply_styles', 'Apply existing paint/text/effect styles. Validates every style type before changing the node. Text styles load fonts.', {
    nodeId, fillStyleId: id.optional(), textStyleId: id.optional(), effectStyleId: id.optional()
  }, false, true);
  live('get_variables', 'List local collections, modes, and a bounded page of local variables including values.', {
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100)
  });
  live('create_variable_collection', 'Create a local variable collection with named modes. Mode limits depend on the Figma plan.', {
    name, modes: z.array(name).min(1).max(20).default(['Default']).refine(values => new Set(values).size === values.length, 'Mode names must be unique.')
  }, false);
  live('create_variable', 'Create a COLOR, FLOAT, STRING or BOOLEAN variable in an existing collection, with values for selected modes.', {
    name, collectionId: id, type: z.enum(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN']),
    values: z.array(z.object({ modeId: id, value }).strict()).min(1).max(20)
  }, false);
  live('set_variable', 'Set an existing variable value for a collection mode. COLOR values are RGBA objects.', { variableId: id, modeId: id, value }, false, true);
  live('bind_variable', 'Bind a COLOR variable to one solid fill, or a FLOAT variable to a supported spacing/opacity/radius/size property.', {
    nodeId, variableId: id,
    field: z.enum(['fill', 'opacity', 'cornerRadius', 'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'width', 'height'])
  }, false, true);
  live('set_variable_mode', 'Set a node explicit collection mode, e.g. Light/Dark.', { nodeId, collectionId: id, modeId: id }, false, true);
  live('set_responsive', 'Set sizing, constraints and auto-layout alignment. FILL needs an auto-layout parent; HUG needs text or an auto-layout frame.', {
    nodeId, properties: z.object({
      layoutSizingHorizontal: z.enum(['FIXED', 'HUG', 'FILL']).optional(), layoutSizingVertical: z.enum(['FIXED', 'HUG', 'FILL']).optional(),
      constraints: z.object({ horizontal: z.enum(['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']), vertical: z.enum(['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']) }).strict().optional(),
      primaryAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']).optional(), counterAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX', 'BASELINE']).optional(),
      clipsContent: z.boolean().optional(), minWidth: z.number().min(0).max(100000).nullable().optional(), maxWidth: z.number().min(0).max(100000).nullable().optional(),
      minHeight: z.number().min(0).max(100000).nullable().optional(), maxHeight: z.number().min(0).max(100000).nullable().optional()
    }).strict().refine(p => Object.keys(p).length > 0, 'Provide at least one property.')
  }, false, true);
  live('combine_variants', 'Combine sibling COMPONENT nodes into a component set. Use names like State=Default and State=Hover.', { nodeIds: nodeIds.refine(ids => ids.length >= 2, 'At least two components required.'), name }, false, true);
  live('get_component_properties', 'Read a component/set property definitions or an instance current properties.', { nodeId });
  live('set_instance_properties', 'Set existing BOOLEAN, TEXT, VARIANT or INSTANCE_SWAP properties by exact key. Unsupported property types are rejected.', {
    nodeId, properties: z.record(z.string().min(1).max(500), z.union([z.string().max(10000), z.boolean()])).refine(p => Object.keys(p).length > 0 && Object.keys(p).length <= 100, 'Provide 1–100 properties.')
  }, false, true);
  live('batch_update', 'Apply the same node properties to up to 100 nodes. Prevalidates capabilities. Returns completed node IDs and failures; partial updates are possible.', {
    nodeIds, properties: properties.refine(p => Object.keys(p).length > 0, 'Provide at least one property.')
  }, false, true);
  live('audit_design', 'Read-only heuristic audit: spacing grid, clipped text bounds, small text, and contrast for opaque single-solid text/backgrounds. Complex paints are skipped. This is not a complete accessibility or visual-quality certification.', {
    rootId: nodeId.optional(), maxNodes: z.number().int().min(1).max(5000).default(1000), spacingStep: z.number().positive().max(100).default(4)
  });
}
