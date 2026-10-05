-- =====================================================
-- Customize Tool — product details move from materials to categories
--
-- A material preset (ct_presets kind 'material') is reusable across
-- categories and products: it now holds only the material's look. What a
-- finished product has besides it — a hanging hole, a spring and a cord, a
-- visor clip… — belongs to the category: rules.details (same shape as the
-- old params.specs), with photos of the finished product in
-- rules.productRefs. Details are never drawn on the flat clipart (the file
-- the factory gets); only the material versions get them (FP Material).
--
-- This copies each material's old params.specs into the categories using
-- that material (rules.materialIds) that have no details yet, then removes
-- them from the material. A category using several materials with details
-- gets the last one's — check it in the category dialog.
--
-- No schema change (rules / params are JSONB). Run after 001–008.
-- =====================================================

SET search_path TO flexiprint, public;

UPDATE flexiprint.ct_clipart_categories c
SET rules = jsonb_set(c.rules, '{details}', p.params -> 'specs', true)
FROM flexiprint.ct_presets p
WHERE p.kind = 'material'
  AND jsonb_typeof(p.params -> 'specs') = 'array'
  AND jsonb_array_length(p.params -> 'specs') > 0
  AND jsonb_typeof(c.rules -> 'materialIds') = 'array'
  AND c.rules -> 'materialIds' ? p.id::text
  AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(c.rules -> 'details') = 'array' THEN c.rules -> 'details' END), 0) = 0;

UPDATE flexiprint.ct_presets
SET params = params - 'specs'
WHERE kind = 'material' AND params ? 'specs';
