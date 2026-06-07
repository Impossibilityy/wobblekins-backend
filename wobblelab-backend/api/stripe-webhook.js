// =============================================================================
// wobblelab-backend/api/stripe-webhook.js
// -----------------------------------------------------------------------------
// Stripe calls this URL after events. We verify the signature, and on
// `checkout.session.completed` we:
//   1) mark the matching Supabase order as PAID (idempotently),
//   2) save payment intent / customer / totals / shipping address,
//   3) ensure order items exist,
//   4) email the customer a branded confirmation (Resend),
//   5) email the admin an order notification (Resend).
//
// STRIPE DASHBOARD SETUP (do this once):
//   Developers > Webhooks > Add endpoint
//     Endpoint URL: https://wobblekins-backend.vercel.app/api/stripe-webhook
//     Events to send: checkout.session.completed
//   Then copy the "Signing secret" (whsec_...) into Vercel env as
//   STRIPE_WEBHOOK_SECRET and redeploy.
//
// RAW BODY: Stripe signature verification needs the UNPARSED body, so we turn
// Vercel's automatic body parser OFF (see `module.exports.config` at the bottom)
// and read the raw stream ourselves.
// =============================================================================
 
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { Resend } = require('resend');
 
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
 
const ADMIN_EMAIL = 'genesisforge@wobblekins.com';
 
// FROM address MUST be on a domain you've verified in Resend.
// For your very first test you may use 'Wobble Lab <onboarding@resend.dev>'.
// Replace with your verified domain sender once DNS is set up in Resend.
const FROM_EMAIL = 'Wobble Lab <adoptions@wobblekins.com>';
 
// ---- read the raw request body (needed for signature verification) ----------
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
 
const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
 
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
 
  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
 
  // We only act on completed checkouts. Always return 200 for anything else so
  // Stripe doesn't keep retrying events we don't handle.
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }
 
  try {
    const session = event.data.object;
    const orderId = session.metadata && session.metadata.order_id;
 
    // Find the order by id (preferred) or by the Stripe session id (fallback).
    let order = null;
    if (orderId) {
      const { data } = await supabase.from('wobblekin_orders').select('*').eq('id', orderId).maybeSingle();
      order = data;
    }
    if (!order) {
      const { data } = await supabase.from('wobblekin_orders').select('*').eq('stripe_session_id', session.id).maybeSingle();
      order = data;
    }
    if (!order) {
      console.error('[stripe-webhook] no matching order for session', session.id);
      return res.status(200).json({ received: true, note: 'no matching order' });
    }
 
    // Shipping address (Stripe field name has varied; handle both shapes).
    const shipping =
      session.shipping_details ||
      (session.collected_information && session.collected_information.shipping_details) ||
      null;
    const customer = session.customer_details || {};
 
    // ---- IDEMPOTENT paid-marking --------------------------------------------
    // Only the FIRST webhook to flip pending->paid "wins". If a duplicate event
    // arrives, the .neq('status','paid') filter returns 0 rows and we skip the
    // emails, so the customer never gets two confirmations.
    const { data: updatedRows, error: updErr } = await supabase
      .from('wobblekin_orders')
      .update({
        status: 'paid',
        stripe_payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        customer_email: customer.email || session.customer_email || null,
        customer_name: customer.name || (shipping && shipping.name) || null,
        customer_phone: customer.phone || null,
        subtotal_cents: session.amount_subtotal ?? order.subtotal_cents,
        shipping_cents: (session.total_details && session.total_details.amount_shipping) || 0,
        tax_cents: (session.total_details && session.total_details.amount_tax) || 0,
        total_cents: session.amount_total ?? order.total_cents,
        currency: session.currency || order.currency,
        shipping_address: shipping ? (shipping.address || shipping) : null,
        billing_details: customer || null
      })
      .eq('id', order.id)
      .neq('status', 'paid')
      .select();
 
    if (updErr) throw updErr;
 
    if (!updatedRows || updatedRows.length === 0) {
      // Already processed by an earlier delivery of this event — do nothing.
      console.log('[stripe-webhook] order already paid, skipping:', order.id);
      return res.status(200).json({ received: true, duplicate: true });
    }
    const paidOrder = updatedRows[0];
 
    // ---- Ensure order items exist (rebuild from metadata if missing) --------
    const { data: existingItems } = await supabase
      .from('wobblekin_order_items')
      .select('*')
      .eq('order_id', paidOrder.id);
 
    let items = existingItems || [];
    if (items.length === 0 && paidOrder.metadata && Array.isArray(paidOrder.metadata.line_items)) {
      const rebuilt = paidOrder.metadata.line_items.map((oi) => ({ ...oi, order_id: paidOrder.id }));
      const { data: inserted } = await supabase.from('wobblekin_order_items').insert(rebuilt).select();
      items = inserted || rebuilt;
    }
 
    // ---- Send the emails -----------------------------------------------------
    const toEmail = paidOrder.customer_email;
    if (toEmail) {
      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: toEmail,
          subject: 'Your Wobblekin adoption is confirmed 🐣',
          html: customerEmailHtml(paidOrder, items)
        });
      } catch (e) {
        console.error('[stripe-webhook] customer email failed:', e);
      }
    }
    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: ADMIN_EMAIL,
        subject: `New adoption · ${money(paidOrder.total_cents)} · ${toEmail || 'no email'}`,
        html: adminEmailHtml(paidOrder, items, session)
      });
    } catch (e) {
      console.error('[stripe-webhook] admin email failed:', e);
    }
 
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err);
    // Return 200 so Stripe doesn't infinitely retry on a non-signature error;
    // the error is logged above for you to inspect in Vercel logs.
    return res.status(200).json({ received: true, error: 'handled-with-error' });
  }
}
 
module.exports = handler;
// Turn OFF Vercel's body parser so we can verify the Stripe signature.
module.exports.config = { api: { bodyParser: false } };
 
// =============================================================================
// EMAIL TEMPLATES (inline styles only — email clients can't run JS or <style>)
// =============================================================================
 
// Rainbow wordmark built from inline colored <span>s (works in email).
function rainbowWordmark() {
  const colors = ['#ff3b6b', '#ff8a1f', '#ffd23f', '#42d60c', '#15d0c0', '#3b9dff', '#a85cff', '#ff5fd2'];
  const word = 'WOBBLEKINS';
  return word.split('').map((ch, i) =>
    `<span style="color:${colors[i % colors.length]};font-weight:800;letter-spacing:2px;">${ch}</span>`
  ).join('');
}
 
function itemsRows(items) {
  return items.map((it) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.10);color:#f4f4f8;font-size:14px;">
        ${escapeHtml(it.product_name)} <span style="color:#9a9aa6;">× ${it.quantity}</span>
      </td>
      <td align="right" style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.10);color:#f4f4f8;font-size:14px;">
        ${money(it.total_cents)}
      </td>
    </tr>`).join('');
}
 
// ---- CUSTOMER confirmation ---------------------------------------------------
function customerEmailHtml(order, items) {
  const name = order.customer_name ? escapeHtml(order.customer_name.split(' ')[0]) : 'friend';
  return `
  <div style="margin:0;padding:0;background:#000000;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#060608;border:1px solid rgba(255,255,255,.12);border-radius:18px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
          <!-- rainbow top border -->
          <tr><td style="height:5px;line-height:5px;font-size:5px;background:#ff3b6b;background:linear-gradient(90deg,#ff3b6b,#ff8a1f,#ffd23f,#42d60c,#15d0c0,#3b9dff,#a85cff,#ff5fd2);">&nbsp;</td></tr>
          <tr><td style="padding:30px 28px 8px;">
            <div style="font-size:12px;letter-spacing:3px;color:#9a9aa6;text-transform:uppercase;">${rainbowWordmark()}</div>
            <h1 style="margin:14px 0 6px;color:#f4f4f8;font-size:24px;line-height:1.2;">Your adoption has been confirmed</h1>
            <p style="margin:0;color:#b6b6c2;font-size:15px;line-height:1.6;">
              Hi ${name}, the Wobble Lab has logged your order. Your Wobblekin discovery is being prepared.
            </p>
          </td></tr>
 
          <tr><td style="padding:18px 28px 6px;">
            <div style="background:#0d0d12;border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:16px 18px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${itemsRows(items)}
                <tr>
                  <td style="padding:14px 0 0;color:#9a9aa6;font-size:13px;">Subtotal</td>
                  <td align="right" style="padding:14px 0 0;color:#f4f4f8;font-size:13px;">${money(order.subtotal_cents)}</td>
                </tr>
                ${order.shipping_cents ? `<tr><td style="padding:4px 0;color:#9a9aa6;font-size:13px;">Shipping</td><td align="right" style="padding:4px 0;color:#f4f4f8;font-size:13px;">${money(order.shipping_cents)}</td></tr>` : ''}
                ${order.tax_cents ? `<tr><td style="padding:4px 0;color:#9a9aa6;font-size:13px;">Tax</td><td align="right" style="padding:4px 0;color:#f4f4f8;font-size:13px;">${money(order.tax_cents)}</td></tr>` : ''}
                <tr>
                  <td style="padding:10px 0 0;color:#f4f4f8;font-size:16px;font-weight:bold;">Total paid</td>
                  <td align="right" style="padding:10px 0 0;color:#ffd23f;font-size:16px;font-weight:bold;">${money(order.total_cents)}</td>
                </tr>
              </table>
            </div>
          </td></tr>
 
          <tr><td style="padding:16px 28px 4px;">
            <p style="margin:0;color:#b6b6c2;font-size:14px;line-height:1.6;">
              You'll receive updates as your adoption moves through the forge. If a shipping
              address was collected, your Wobblekin will be sent there.
            </p>
          </td></tr>
 
          <tr><td style="padding:18px 28px 30px;">
            <div style="border-top:1px solid rgba(255,255,255,.10);padding-top:16px;color:#6f6f7c;font-size:12px;line-height:1.6;">
              Order ref: ${escapeHtml(order.id)}<br/>
              Genesis Forge · Wobblekins · This is an order confirmation for ${escapeHtml(order.customer_email || '')}.
            </div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </div>`;
}
 
// ---- ADMIN notification ------------------------------------------------------
function adminEmailHtml(order, items, session) {
  const addr = order.shipping_address || {};
  const addrLine = [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country]
    .filter(Boolean).join(', ');
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
              ${items.map(it => `
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);color:#f4f4f8;font-size:14px;">
                    ${escapeHtml(it.product_name)} <span style="color:#9a9aa6;">(${escapeHtml(it.product_slug || '')})</span> × ${it.quantity}
                  </td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);color:#f4f4f8;font-size:14px;">${money(it.total_cents)}</td>
                </tr>`).join('')}
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
 
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
