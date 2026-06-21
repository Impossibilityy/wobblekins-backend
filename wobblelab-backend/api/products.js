// =============================================================================
// wobblelab-backend/api/products.js   (ESM — now matches the rest of the project)
// -----------------------------------------------------------------------------
// PUBLIC, read-only catalog for the Adoption Center. Uses the Supabase SERVICE
// ROLE key on the SERVER only (never sent to the browser) and returns only
// safe, public columns.
//
// WHAT CHANGED vs the previous version:
//   • Converted CommonJS (require/module.exports) -> ESM (import/export default).
//     Your package.json has "type":"module", so the old CommonJS file would
//     throw at runtime ("require is not defined"). This was a real bug.
//   • Lazy client init inside the handler so a missing env var can't crash the
//     function on load and turn the CORS preflight into a header-less 500.
//   • Orders by display_order (then featured, then newest).
//   • Optional single-product fetch:  /api/products?slug=foo  or  ?id=<uuid>
//   • Returns the new optional catalog fields (wave_name, personality, species,
//     adoption_status, currency, display_order). Response SHAPE is unchanged
//     for the list ({ products: [...] }), so the storefront keeps working.
//
// PREREQ: apply migrations/products-catalog-migration.sql FIRST, otherwise the
// SELECT references columns that don't exist yet.
// =============================================================================

import { createClient } from '@supabase/supabase-js';

// Public-safe columns only. (No service keys, no admin_notes.)
const PUBLIC_COLUMNS =
  'id, slug, name, short_description, description, price_cents, currency, ' +
  'image_url, gallery_urls, category, rarity, stock_quantity, is_active, ' +
  'is_featured, allow_multiple, wave_name, personality, species, ' +
  'adoption_status, display_order, metadata, ' +
  'product_type, mystery_quantity, wave_scope';

// CORS: only your storefront domains.
const ALLOWED_ORIGINS = ['https://wobblekins.com', 'https://www.wobblekins.com'];
function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();                 // preflight
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Lazy init so a missing env var can't crash the function on load.
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const slug = req.query && req.query.slug ? String(req.query.slug).trim() : '';
    const id = req.query && req.query.id ? String(req.query.id).trim() : '';

    // ---- single product (for a detail view) --------------------------------
    if (slug || id) {
      let q = supabase.from('wobblekin_products').select(PUBLIC_COLUMNS).eq('is_active', true).neq('product_type', 'legacy_individual');
      q = slug ? q.eq('slug', slug) : q.eq('id', id);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Product not found' });
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      return res.status(200).json({ product: data });
    }

    // ---- full catalog (active only) ----------------------------------------
    const { data, error } = await supabase
      .from('wobblekin_products')
      .select(PUBLIC_COLUMNS)
      .eq('is_active', true)
      .neq('product_type', 'legacy_individual')
      .order('display_order', { ascending: true, nullsFirst: false }) // explicit catalog order
      .order('is_featured', { ascending: false })                     // featured first
      .order('created_at', { ascending: false });                     // then newest
    if (error) throw error;

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ products: data || [] });
  } catch (err) {
    console.error('[products] error:', err);
    return res.status(500).json({ error: 'Failed to load products' });
  }
}
