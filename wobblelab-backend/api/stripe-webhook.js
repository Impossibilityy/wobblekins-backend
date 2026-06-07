// =============================================================================
// wobblelab-backend/api/stripe-webhook.js   (ESM — matches create-checkout-session.js)
// -----------------------------------------------------------------------------
// Stripe calls this after payment. We verify the signature, mark the Supabase
// order paid (idempotently), ensure order items exist, and email the customer
// + admin via Resend.
//
// Reads fields from the REAL locations in a live checkout.session.completed:
//   order id   -> session.metadata.order_id  ||  session.client_reference_id
//   email      -> session.customer_details.email  ||  session.customer_email
//   name       -> session.customer_details.name  ||  session.collected_information.shipping_details.name
//   phone      -> session.customer_details.phone
//   shipping   -> session.collected_information.shipping_details  ||  session.customer_details.address
//
// STRIPE DASHBOARD: Developers > Webhooks > endpoint URL
//   https://wobblekins-backend.vercel.app/api/stripe-webhook
//   event: checkout.session.completed ; copy signing secret -> STRIPE_WEBHOOK_SECRET
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { Resend } from 'resend';

// Raw body is required for Stripe signature verification, so turn off Vercel's
// automatic body parser.
export const config = { api: { bodyParser: false } };

const ADMIN_EMAIL = 'genesisforge@wobblekins.com';
// FROM must be a domain you've VERIFIED in Resend. For a first test you can use
// 'Wobble Lab <onboarding@resend.dev>'. Replace once your domain is verified.
const FROM_EMAIL = 'Wobble Lab <adoptions@wobblekins.com>';

// ---- helpers ----------------------------------------------------------------
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// =============================================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Stripe client is needed to verify the signature.
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Stripe webhook received');
  console.log('  event type:', event.type);

  // Only act on completed checkouts; acknowledge everything else so Stripe stops.
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const resend = new Resend(process.env.RESEND_API_KEY);

    const session = event.data.object;
    console.log('  session id:', session.id);

    // ---- read fields from their real locations ------------------------------
    const orderId = (session.metadata && session.metadata.order_id) || session.client_reference_id || null;
    console.log('  order id:', orderId);

    const details = session.customer_details || {};
    const shippingDetails = session.collected_information && session.collected_information.shipping_details;

    const customerEmail = details.email || session.customer_email || null;
    const customerName  = details.name || (shippingDetails && shippingDetails.name) || null;
    const customerPhone = details.phone || null;
    const shippingAddress = shippingDetails || details.address || null;
    const paymentIntent = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent && session.payment_intent.id) || null;

    console.log('  customer email detected:', customerEmail || '(none)');

    if (!orderId) {
      console.error('Stripe webhook error: no order id on session', session.id);
      return res.status(200).json({ received: true, note: 'no order id' });
    }

    // ---- find the order -----------------------------------------------------
    const { data: order, error: findErr } = await supabase
      .from('wobblekin_orders').select('*').eq('id', orderId).maybeSingle();
    if (findErr) throw findErr;
    if (!order) {
      console.error('Stripe webhook error: order not found for id', orderId);
      return res.status(200).json({ received: true, note: 'order not found' });
    }

    // ---- duplicate guard (already paid?) ------------------------------------
    if (order.status === 'paid') {
      console.log('  order already paid — skipping, no emails resent');
      return res.status(200).json({ received: true, duplicate: true });
    }

    // ---- mark paid (atomic: only the first delivery wins) -------------------
    const { data: updatedRows, error: updErr } = await supabase
      .from('wobblekin_orders')
      .update({
        status: 'paid',
        stripe_session_id: session.id,
        stripe_payment_intent: paymentIntent,
        customer_email: customerEmail,
        customer_name: customerName,
        customer_phone: customerPhone,
        subtotal_cents: session.amount_subtotal ?? session.amount_total ?? order.subtotal_cents,
        shipping_cents: (session.total_details && session.total_details.amount_shipping) || 0,
        tax_cents: (session.total_details && session.total_details.amount_tax) || 0,
        total_cents: session.amount_total ?? order.total_cents,
        currency: session.currency || order.currency,
        shipping_address: shippingAddress,
        billing_details: details || null
      })
      .eq('id', order.id)
      .neq('status', 'paid')
      .select();

    if (updErr) {
      console.error('  order update FAILED:', updErr.message);
      throw updErr;
    }
    if (!updatedRows || updatedRows.length === 0) {
      console.log('  order update: another delivery already marked paid — skipping emails');
      return res.status(200).json({ received: true, duplicate: true });
    }
    console.log('  order update: success');
    const paidOrder = updatedRows[0];

    // ---- ensure order items exist -------------------------------------------
    let { data: items } = await supabase
      .from('wobblekin_order_items').select('*').eq('order_id', paidOrder.id);
    items = items || [];

    if (items.length === 0) {
      console.log('  order items: missing — rebuilding');
      // Prefer the items we stored on the order at checkout time.
      if (paidOrder.metadata && Array.isArray(paidOrder.metadata.line_items) && paidOrder.metadata.line_items.length) {
        const rebuilt = paidOrder.metadata.line_items.map((oi) => ({ ...oi, order_id: paidOrder.id }));
        const { data: ins } = await supabase.from('wobblekin_order_items').insert(rebuilt).select();
        items = ins || rebuilt;
        console.log('  order items: rebuilt from order metadata (', items.length, ')');
      } else {
        // Fallback: pull line items straight from Stripe.
        try {
          const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
          const rebuilt = (li.data || []).map((l) => ({
            order_id: paidOrder.id,
            product_id: null,
            product_slug: null,
            product_name: l.description || 'Wobblekin',
            quantity: l.quantity || 1,
            unit_price_cents: (l.price && l.price.unit_amount) ||
              (l.amount_subtotal && l.quantity ? Math.round(l.amount_subtotal / l.quantity) : 0),
            total_cents: l.amount_total ?? l.amount_subtotal ?? 0
          }));
          if (rebuilt.length) {
            const { data: ins } = await supabase.from('wobblekin_order_items').insert(rebuilt).select();
            items = ins || rebuilt;
          }
          console.log('  order items: rebuilt from Stripe line items (', items.length, ')');
        } catch (e) {
          console.error('  listLineItems failed:', e.message);
        }
      }
    } else {
      console.log('  order items: found', items.length);
    }

    // ---- emails -------------------------------------------------------------
    if (customerEmail) {
      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: customerEmail,
          subject: 'Your Wobblekin adoption is confirmed',
          html: customerEmailHtml(paidOrder, items)
        });
        console.log('  customer email: sent to', customerEmail);
      } catch (e) {
        console.error('  customer email: error', e.message);
      }
    } else {
      console.log('  customer email: skipped (no email on session)');
    }

    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: ADMIN_EMAIL,
        subject: `New adoption · ${money(paidOrder.total_cents)} · ${customerEmail || 'no email'}`,
        html: adminEmailHtml(paidOrder, items, session)
      });
      console.log('  admin email: sent to', ADMIN_EMAIL);
    } catch (e) {
      console.error('  admin email: error', e.message);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    return res.status(500).json({ error: 'webhook processing failed' });
  }
}

// =============================================================================
// EMAIL TEMPLATES (inline styles only — email clients can't run JS or <style>)
// =============================================================================
function rainbowWordmark() {
  const colors = ['#ff3b6b', '#ff8a1f', '#ffd23f', '#42d60c', '#15d0c0', '#3b9dff', '#a85cff', '#ff5fd2'];
  return 'WOBBLEKINS'.split('').map((ch, i) =>
    `<span style="color:${colors[i % colors.length]};font-weight:800;letter-spacing:2px;">${ch}</span>`
  ).join('');
}
function itemsRows(items) {
  return (items || []).map((it) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.10);color:#f4f4f8;font-size:14px;">
        ${escapeHtml(it.product_name)} <span style="color:#9a9aa6;">&times; ${it.quantity}</span>
      </td>
      <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.10);color:#f4f4f8;font-size:14px;">
        ${money(it.total_cents)}
      </td>
    </tr>`).join('');
}
function customerEmailHtml(order, items) {
  const name = order.customer_name ? escapeHtml(String(order.customer_name).split(' ')[0]) : 'friend';
  return `
  <div style="margin:0;padding:0;background:#000000;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#060608;border:1px solid rgba(255,255,255,.12);border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
          <tr><td style="height:5px;line-height:5px;font-size:5px;background:linear-gradient(90deg,#ff3b6b,#ff8a1f,#ffd23f,#42d60c,#15d0c0,#3b9dff,#a85cff,#ff5fd2);">&nbsp;</td></tr>
          <tr><td style="padding:30px 28px 8px;">
            <div style="font-size:12px;letter-spacing:3px;text-transform:uppercase;">${rainbowWordmark()}</div>
            <h1 style="margin:14px 0 6px;color:#f4f4f8;font-size:24px;line-height:1.2;">Your adoption has been confirmed</h1>
            <p style="margin:0;color:#b6b6c2;font-size:15px;line-height:1.6;">
              Hi ${name}, the Wobble Lab has logged your order. Your Wobblekin discovery is being prepared.
            </p>
          </td></tr>
          <tr><td style="padding:18px 28px 6px;">
            <div style="background:#0d0d12;border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:16px 18px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${itemsRows(items)}
                <tr><td style="padding:14px 0 0;color:#9a9aa6;font-size:13px;">Subtotal</td>
                    <td align="right" style="padding:14px 0 0;color:#f4f4f8;font-size:13px;">${money(order.subtotal_cents)}</td></tr>
                ${order.shipping_cents ? `<tr><td style="padding:4px 0;color:#9a9aa6;font-size:13px;">Shipping</td><td align="right" style="padding:4px 0;color:#f4f4f8;font-size:13px;">${money(order.shipping_cents)}</td></tr>` : ''}
                ${order.tax_cents ? `<tr><td style="padding:4px 0;color:#9a9aa6;font-size:13px;">Tax</td><td align="right" style="padding:4px 0;color:#f4f4f8;font-size:13px;">${money(order.tax_cents)}</td></tr>` : ''}
                <tr><td style="padding:10px 0 0;color:#f4f4f8;font-size:16px;font-weight:bold;">Total paid</td>
                    <td align="right" style="padding:10px 0 0;color:#ffd23f;font-size:16px;font-weight:bold;">${money(order.total_cents)}</td></tr>
              </table>
            </div>
          </td></tr>
          <tr><td style="padding:16px 28px 4px;">
            <p style="margin:0;color:#b6b6c2;font-size:14px;line-height:1.6;">
              You'll receive updates as your adoption moves through the forge. If a shipping address was collected, your Wobblekin will be sent there.
            </p>
          </td></tr>
          <tr><td style="padding:18px 28px 30px;">
            <div style="border-top:1px solid rgba(255,255,255,.10);padding-top:16px;color:#6f6f7c;font-size:12px;line-height:1.6;">
              Order ref: ${escapeHtml(order.id)}<br/>
              Genesis Forge &middot; Wobblekins
            </div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </div>`;
}
function adminEmailHtml(order, items, session) {
  const sd = order.shipping_address || {};
  const a = sd.address ? sd.address : sd;   // shipping_details {name,address} OR a raw address
  const addrLine = [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ');
  return `
  <div style="margin:0;padding:0;background:#000000;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#060608;border:1px solid rgba(255,255,255,.12);border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
          <tr><td style="height:5px;line-height:5px;font-size:5px;background:linear-gradient(90deg,#ff3b6b,#ff8a1f,#ffd23f,#42d60c,#15d0c0,#3b9dff,#a85cff,#ff5fd2);">&nbsp;</td></tr>
          <tr><td style="padding:24px 26px;">
            <h2 style="margin:0 0 14px;color:#f4f4f8;font-size:19px;">New adoption order</h2>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="color:#cfcfd8;font-size:14px;line-height:1.7;">
              <tr><td style="color:#9a9aa6;width:150px;">Customer</td><td style="color:#f4f4f8;">${escapeHtml(order.customer_name || '—')}</td></tr>
              <tr><td style="color:#9a9aa6;">Email</td><td style="color:#f4f4f8;">${escapeHtml(order.customer_email || '—')}</td></tr>
              <tr><td style="color:#9a9aa6;">Phone</td><td style="color:#f4f4f8;">${escapeHtml(order.customer_phone || '—')}</td></tr>
              <tr><td style="color:#9a9aa6;">Total</td><td style="color:#ffd23f;font-weight:bold;">${money(order.total_cents)}</td></tr>
              <tr><td style="color:#9a9aa6;">Supabase order</td><td style="color:#f4f4f8;">${escapeHtml(order.id)}</td></tr>
              <tr><td style="color:#9a9aa6;">Stripe session</td><td style="color:#f4f4f8;">${escapeHtml(session.id)}</td></tr>
              <tr><td style="color:#9a9aa6;">Payment intent</td><td style="color:#f4f4f8;">${escapeHtml(order.stripe_payment_intent || '—')}</td></tr>
              <tr><td style="color:#9a9aa6;">Placed</td><td style="color:#f4f4f8;">${new Date(order.created_at).toISOString()}</td></tr>
              <tr><td style="color:#9a9aa6;vertical-align:top;">Shipping</td><td style="color:#f4f4f8;">${escapeHtml(addrLine || '— (none collected)')}</td></tr>
            </table>
            <h3 style="margin:20px 0 8px;color:#f4f4f8;font-size:15px;">Items</h3>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${(items || []).map((it) => `
                <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);color:#f4f4f8;font-size:14px;">
                  ${escapeHtml(it.product_name)} <span style="color:#9a9aa6;">(${escapeHtml(it.product_slug || '')})</span> &times; ${it.quantity}</td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);color:#f4f4f8;font-size:14px;">${money(it.total_cents)}</td></tr>`).join('')}
            </table>
            <div style="margin-top:18px;background:#0d0d12;border:1px dashed rgba(255,255,255,.16);border-radius:12px;padding:14px 16px;color:#9a9aa6;font-size:13px;">
              <strong style="color:#cfcfd8;">Fulfillment notes:</strong><br/>
              ________________________________________________<br/>
              ________________________________________________
            </div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </div>`;
}
