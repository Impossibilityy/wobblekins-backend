// =============================================================================
// wobblelab-backend/api/create-checkout-session.js
// -----------------------------------------------------------------------------
// Receives the Adoption Bag from the widget, RE-VALIDATES everything against
// Supabase (never trusts browser prices), creates a PENDING order + order items,
// then creates a Stripe Checkout Session and returns its URL.
//
// CORS / preflight notes:
//   • setCorsHeaders() runs FIRST on every request, so OPTIONS and every error
//     response carry the CORS headers (the browser hides the real error if they
//     are missing).
//   • Stripe/Supabase clients are created INSIDE the handler, AFTER the OPTIONS
//     short-circuit. If they were created at module load and an env var was
//     missing, the function would crash on load and the preflight would return a
//     header-less 500 — which the browser reports as a CORS error. Lazy init
//     keeps the preflight bulletproof regardless of env config.
//
// Module style: ESM (import / export default). This MUST match your other API
// routes. If submit-request.js / join-wobblelist.js use require()/module.exports
// (CommonJS), use the CommonJS version of this file instead.
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// ---- CORS allowlist + helper (dynamic origin, no wildcard) ------------------
const allowedOrigins = [
  'https://wobblekins.com',
  'https://www.wobblekins.com'
];
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : 'https://www.wobblekins.com';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Where Stripe sends the customer back to. Uses WOBBLEKINS_SITE_URL if set,
// then SITE_URL, then a hard default. (Check Vercel > Settings > Env Vars.)
const SITE_URL = process.env.WOBBLEKINS_SITE_URL || process.env.SITE_URL || 'https://wobblekins.com';

// Countries you ship physical Wobblekins to. Add more as needed: ['US','CA','GB']
const SHIPPING_COUNTRIES = ['US'];

// Flat-rate shipping shown at checkout. Edit the price/name/estimate here.
// (amount is in CENTS: 699 = $6.99)
const SHIPPING_RATE = {
  display_name: 'Standard Shipping',
  amount_cents: 699,
  delivery_min_days: 3,
  delivery_max_days: 7
};

export default async function handler(req, res) {
  // CORS headers on EVERY response (set before anything can fail).
  setCorsHeaders(req, res);

  // Preflight: answer immediately, before any Stripe/Supabase logic.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // Lazy init so a missing/misnamed env var can't break the CORS preflight above.
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) {
      return res.status(400).json({ ok: false, error: 'Your Adoption Bag is empty.' });
    }

    // Collapse the cart to slug -> quantity. The server decides price & validity.
    const wanted = new Map();
    for (const it of rawItems) {
      const slug = String(it.slug || '').trim();
      const qty = Math.max(1, Math.min(99, parseInt(it.quantity, 10) || 1));
      if (slug) wanted.set(slug, (wanted.get(slug) || 0) + qty);
    }
    if (wanted.size === 0) {
      return res.status(400).json({ ok: false, error: 'No valid items in the bag.' });
    }

    // Look up the real products (active only). NEVER trust browser prices.
    const { data: products, error: prodErr } = await supabase
      .from('wobblekin_products')
      .select('*')
      .in('slug', [...wanted.keys()])
      .eq('is_active', true);
    if (prodErr) throw prodErr;
    if (!products || products.length === 0) {
      return res.status(400).json({ ok: false, error: 'None of those products are available.' });
    }

    const line_items = [];
    const orderItems = [];
    let subtotal = 0;

    for (const product of products) {
      const qty = wanted.get(product.slug);
      if (!qty) continue;

      // OPTIONAL stock check — OFF by default. To enforce on a product, set
      // metadata.track_inventory = true and keep stock_quantity accurate.
      if (product.metadata && product.metadata.track_inventory === true) {
        if (product.stock_quantity < qty) {
          return res.status(409).json({ ok: false, error: `${product.name} is sold out or low on stock.` });
        }
      }

      const lineTotal = product.price_cents * qty;
      subtotal += lineTotal;

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

    if (line_items.length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid items to check out.' });
    }

    // 1) Create a PENDING order first (gives us an order id for Stripe metadata).
    const { data: order, error: orderErr } = await supabase
      .from('wobblekin_orders')
      .insert({
        subtotal_cents: subtotal,
        total_cents: subtotal,            // shipping/tax (if any) filled in by webhook
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
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      client_reference_id: order.id,
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      // Flat-rate shipping. Stripe adds this to the total and reports it back on
      // the completed session as total_details.amount_shipping (saved by the webhook).
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: SHIPPING_RATE.amount_cents, currency: 'usd' },
            display_name: SHIPPING_RATE.display_name,
            delivery_estimate: {
              minimum: { unit: 'business_day', value: SHIPPING_RATE.delivery_min_days },
              maximum: { unit: 'business_day', value: SHIPPING_RATE.delivery_max_days }
            }
          }
        }
      ],
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

    return res.status(200).json({ ok: true, url: session.url, id: session.id });
  } catch (err) {
    // CORS headers were already set at the top, so the browser will see THIS error.
    console.error('[create-checkout-session] error:', err);
    return res.status(500).json({ ok: false, error: 'Could not start checkout. Please try again.' });
  }
}
