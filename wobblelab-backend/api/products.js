// =============================================================================
// wobblelab-backend/api/products.js
// -----------------------------------------------------------------------------
// PUBLIC, read-only list of active Wobblekin products for the shop widget.
// Uses the Supabase SERVICE ROLE key on the SERVER only (never sent to browser).
// Returns only safe, public columns.
//
// Module style: CommonJS (require / module.exports). If your other api/*.js use
// `import`/`export default`, convert this to match (or ask for the ESM version).
// =============================================================================
 
const { createClient } = require('@supabase/supabase-js');
 
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
 
// --- CORS: only allow your storefront domains --------------------------------
const ALLOWED_ORIGINS = ['https://wobblekins.com', 'https://www.wobblekins.com'];
function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
 
module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();          // preflight
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
 
  try {
    const { data, error } = await supabase
      .from('wobblekin_products')
      // Only public-safe columns. (No internal-only fields exist here, but we
      // still list columns explicitly so nothing leaks if you add some later.)
      .select('id, slug, name, short_description, description, price_cents, image_url, gallery_urls, category, rarity, stock_quantity, is_active, is_featured, allow_multiple, metadata')
      .eq('is_active', true)
      .order('is_featured', { ascending: false })   // featured first
      .order('created_at', { ascending: false });    // then newest first
 
    if (error) throw error;
 
    // Small CDN cache so the widget loads fast without hammering the DB.
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ products: data || [] });
  } catch (err) {
    console.error('[products] error:', err);
    return res.status(500).json({ error: 'Failed to load products' });
  }
};
