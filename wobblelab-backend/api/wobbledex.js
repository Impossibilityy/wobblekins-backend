// =============================================================================
// wobblelab-backend/api/wobbledex.js   (ESM)
// -----------------------------------------------------------------------------
// Public, read-only Wobbledex feed for the Hostinger embed.
//   GET /api/wobbledex -> { ok: true, entries: [...] }
// Returns ONLY published entries, normalized to the exact shape the current
// Wobbledex front-end expects (slug->id, category->cat, collector_note->note,
// image_url->image, product_url->url, coming_soon->comingSoon). Sorted by
// sort_order asc, then created_at asc. Mirrors the CORS pattern of the other
// public endpoints (join-wobblelist / products).
// =============================================================================

import { createClient } from '@supabase/supabase-js';

const ALLOWED_ORIGINS = [
  'https://www.wobblekins.com',
  'https://wobblekins.com',
];

function setCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader(
    'Access-Control-Allow-Origin',
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : 'https://wobblekins.com'
  );
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// DB columns we read (published-only). No internal-only fields are exposed.
const COLUMNS =
  'slug, name, type, wave, status, category, hint, personality, format, ' +
  'habitat, wiggle, care, collector_note, friends, edition, image_url, ' +
  'product_url, coming_soon, sort_order, created_at, ' +
  'rarity, stats, traits, lore, visual_description';

// DB row -> current Wobbledex front-end entry shape.
function normalize(r) {
  return {
    id: r.slug,
    name: r.name || '',
    type: r.type || '',
    wave: r.wave || '',
    status: r.status || '',
    cat: r.category || '',
    hint: r.hint || '',
    personality: r.personality || '',
    format: r.format || '',
    habitat: r.habitat || '',
    wiggle: r.wiggle || '',
    care: r.care || '',
    note: r.collector_note || '',
    friends: Array.isArray(r.friends) ? r.friends : [],
    edition: r.edition || '',
    image: r.image_url || '',
    url: r.product_url || '#',
    comingSoon: !!r.coming_soon,
    // migrated species stats (forward-compatible; current renderer ignores unknowns)
    rarity: r.rarity || '',
    stats: r.stats || {},
    traits: r.traits || {},
    lore: r.lore || '',
    visualDescription: r.visual_description || '',
  };
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('wobblekin_dex_entries')
      .select(COLUMNS)
      .eq('is_published', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;

    return res.status(200).json({ ok: true, entries: (data || []).map(normalize) });
  } catch (err) {
    console.error('[wobbledex] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not load the Wobbledex.' });
  }
}
