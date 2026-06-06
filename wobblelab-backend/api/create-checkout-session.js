// =============================================================================
// wobblelab-backend/api/create-checkout-session.js
// -----------------------------------------------------------------------------
// Receives the Adoption Bag from the widget, RE-VALIDATES everything against
// Supabase (never trusts browser prices), creates a PENDING order + order items,
// then creates a Stripe Checkout Session and returns its URL.
//
// Security: prices, availability, and line items are built ONLY from server-side
// Supabase data. The browser only sends { slug, quantity }.
// =============================================================================

const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Where Stripe sends the customer back to. Uses WOBBLEKINS_SITE_URL if set,
// then SITE_URL, then a hard default. (Check Vercel > Settings > Env Vars.)
const SITE_URL = process.env.WOBBLEKINS_SITE_URL || process.env.SITE_URL || 'https://wobblekins.com';

// Countries you ship physical Wobblekins to. Add more as needed: ['US','CA','GB']
const SHIPPING_COUNTRIES = ['US'];

const ALLOWED_ORIGINS = ['https://wobblekins.com', 'https://www.wobblekins.com'];
function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();          // preflight
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) return res.status(400).json({ error: 'Your Adoption Bag is empty.' });

    // Collapse the cart to slug -> quantity. The server decides price & validity.
    const wanted = new Map();
    for (const it of rawItems) {
      const slug = String(it.slug || '').trim();
      const qty = Math.max(1, Math.min(99, parseInt(it.quantity, 10) || 1));
      if (slug) wanted.set(slug, (wanted.get(slug) || 0) + qty);
    }
    if (wanted.size === 0) return res.status(400).json({ error: 'No valid items in the bag.' });

    // Look up the real products (active only). NEVER trust browser prices.
    const { data: products, error: prodErr } = await supabase
      .from('wobblekin_products')
      .select('*')
      .in('slug', [...wanted.keys()])
      .eq('is_active', true);
    if (prodErr) throw prodErr;
    if (!products || products.length === 0)
      return res.status(400).json({ error: 'None of those products are available.' });

    const line_items = [];
    const orderItems = [];
    let subtotal = 0;

    for (const product of products) {
      const qty = wanted.get(product.slug);
      if (!qty) continue;

      // OPTIONAL stock check — OFF by default for Phase 1.
      // To enforce stock on a product: set metadata.track_inventory = true and
      // keep stock_quantity accurate. (All Adoption Center products ship as
      // "available" by default, so we don't block on stock unless you opt in.)
      if (product.metadata && product.metadata.track_inventory === true) {
        if (product.stock_quantity < qty) {
          return res.status(409).json({ error: `${product.name} is sold out or low on stock.` });
        }
      }

      const lineTotal = product.price_cents * qty;
      subtotal += lineTotal;

      // Stripe line item built from SERVER price data.
      line_items.push({
        quantity: qty,
        price_data: {
          currency: 'usd',
          unit_amount: product.price_cents,
          product_data: {
            name: product.name,
            description: product.short_description || undefined,
            images: product.image_url ? [product.image_url] : undefined,
            metadata: { slug: product.slug, product_id: product.id }
          }
        }
      });

      orderItems.push({
        product_id: product.id,
        product_slug: product.slug,
        product_name: product.name,
        quantity: qty,
        unit_price_cents: product.price_cents,
        total_cents: lineTotal
      });
    }

    if (line_items.length === 0) return res.status(400).json({ error: 'No valid items to check out.' });

    // 1) Create a PENDING order first, so we have an order id for Stripe metadata.
    //    We also stash the computed items in metadata so the webhook can rebuild
    //    them if the rows below ever fail to write.
    const { data: order, error: orderErr } = await supabase
      .from('wobblekin_orders')
      .insert({
        subtotal_cents: subtotal,
        total_cents: subtotal,           // shipping/tax (if any) filled in by webhook
        currency: 'usd',
        status: 'pending',
        metadata: { line_items: orderItems }
      })
      .select()
      .single();
    if (orderErr) throw orderErr;

    // 2) Insert the order items.
    const { error: itemsErr } = await supabase
      .from('wobblekin_order_items')
      .insert(orderItems.map(oi => ({ ...oi, order_id: order.id })));
    if (itemsErr) throw itemsErr;

    // 3) Create the Stripe Checkout Session.
    //    NOTE: we intentionally do NOT set payment_method_types — leaving it off
    //    lets Stripe show every method you enable in the Dashboard (card, Apple
    //    Pay, Google Pay, Link). Stripe collects the email automatically.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      client_reference_id: order.id,
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      phone_number_collection: { enabled: true },
      metadata: { order_id: order.id },
      payment_intent_data: { metadata: { order_id: order.id } },
      success_url: `${SITE_URL}/adoption-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/adopt`
    });

    // 4) Save the Stripe session id on the order.
    await supabase.from('wobblekin_orders')
      .update({ stripe_session_id: session.id })
      .eq('id', order.id);

    return res.status(200).json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[create-checkout-session] error:', err);
    return res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
};