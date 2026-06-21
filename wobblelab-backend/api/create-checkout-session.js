// =============================================================================
// wobblelab-backend/api/create-checkout-session.js
// -----------------------------------------------------------------------------
// Receives the Adoption Bag from the widget, RE-VALIDATES everything against
// Supabase (never trusts browser prices), creates a PENDING order + order items,
// then creates a Stripe Checkout Session and returns its URL.
//
// FULFILLMENT METHODS (added):
//   • "shipping"     -> collects a shipping address + flat shipping rate (unchanged).
//   • "local_pickup" -> NO shipping address, NO shipping options, $0 shipping,
//                       phone collection on, a pickup note in Checkout, and the
//                       method stamped into session + payment_intent metadata.
// The method is validated server-side. The browser NEVER sends a shipping price.
//
// CORS / preflight + lazy client init notes are unchanged (see below).
// Module style: ESM (import / export default).
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

// Where Stripe sends the customer back to.
const SITE_URL = process.env.WOBBLEKINS_SITE_URL || process.env.SITE_URL || 'https://wobblekins.com';

// Countries you ship physical Wobblekins to.
const SHIPPING_COUNTRIES = ['US'];

// Flat-rate shipping shown at checkout (amount in CENTS: 699 = $6.99).
const SHIPPING_RATE = {
  display_name: 'Standard Shipping',
  amount_cents: 699,
  delivery_min_days: 3,
  delivery_max_days: 7
};

// The two valid fulfillment methods. Anything else is rejected.
const VALID_FULFILLMENT = ['shipping', 'local_pickup'];

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // ---- validate fulfillment method (server-side, never trusted blindly) ---
    // Missing -> default to 'shipping' so older callers keep working. If present,
    // it MUST be exactly one of the valid values.
    const fulfillment_method = body.fulfillment_method == null ? 'shipping' : String(body.fulfillment_method);
    if (!VALID_FULFILLMENT.includes(fulfillment_method)) {
      return res.status(400).json({ ok: false, error: 'Invalid fulfillment method.' });
    }
    const isPickup = fulfillment_method === 'local_pickup';

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
    const mysteryLines = [];
    let subtotal = 0;

    for (const product of products) {
      const qty = wanted.get(product.slug);
      if (!qty) continue;

      // OPTIONAL stock check — off unless a product sets metadata.track_inventory = true.
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
      mysteryLines.push({
        product_slug: product.slug,
        product_name: product.name,
        quantity: qty,
        product_type: product.product_type || 'legacy_individual',
        mystery_quantity: product.mystery_quantity || 1,
        egg_count: (product.mystery_quantity || 1) * qty
      });
    }

    if (line_items.length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid items to check out.' });
    }

    // Wobblekins to assign for mystery fulfillment (eggs x quantity).
    const totalEggs = mysteryLines
      .filter(l => l.product_type === 'mystery_egg' || l.product_type === 'mystery_trove')
      .reduce((a, l) => a + l.egg_count, 0);

    // 1) Create a PENDING order. Stamp the fulfillment method now so it is known
    //    even before the webhook, and zero shipping for pickup orders.
    const { data: order, error: orderErr } = await supabase
      .from('wobblekin_orders')
      .insert({
        subtotal_cents: subtotal,
        total_cents: subtotal,            // shipping/tax (if any) reconciled by the webhook
        shipping_cents: 0,
        currency: 'usd',
        status: 'pending',
        fulfillment_method,
        metadata: { line_items: orderItems, mystery: { total_eggs: totalEggs, lines: mysteryLines } }
      })
      .select()
      .single();
    if (orderErr) throw orderErr;

    // 2) Insert the order items.
    const { error: itemsErr } = await supabase
      .from('wobblekin_order_items')
      .insert(orderItems.map(oi => ({ ...oi, order_id: order.id })));
    if (itemsErr) throw itemsErr;

    // 3) Build the Stripe Checkout Session. Shared params first, then branch.
    const sessionParams = {
      mode: 'payment',
      line_items,
      client_reference_id: order.id,
      phone_number_collection: { enabled: true },
      // Method travels with the session AND the payment intent so the webhook
      // reads an explicit value (never inferred from address presence).
      metadata: { order_id: order.id, fulfillment_method },
      payment_intent_data: { metadata: { order_id: order.id, fulfillment_method } },
      success_url: `${SITE_URL}/adoption-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/adopt`
    };

    if (isPickup) {
      // Local pickup: no address, no shipping options, $0 shipping. A note tells
      // the buyer what happens next. (Billing details are still collected by
      // Stripe as needed for the payment.)
      sessionParams.custom_text = {
        submit: { message: 'This order is for local pickup. We will email you when it is ready.' }
      };
    } else {
      // Shipping: unchanged behavior — collect address + flat shipping rate.
      sessionParams.shipping_address_collection = { allowed_countries: SHIPPING_COUNTRIES };
      sessionParams.shipping_options = [
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
      ];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // 4) Save the Stripe session id on the order.
    await supabase.from('wobblekin_orders')
      .update({ stripe_session_id: session.id })
      .eq('id', order.id);

    return res.status(200).json({ ok: true, url: session.url, id: session.id });
  } catch (err) {
    console.error('[create-checkout-session] error:', err);
    return res.status(500).json({ ok: false, error: 'Could not start checkout. Please try again.' });
  }
}
