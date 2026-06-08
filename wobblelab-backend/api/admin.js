// api/admin.js
// =============================================================================
// Forge Console — SINGLE consolidated admin route (Vercel Hobby friendly).
//
// IMPORTANT: This file is ESM (`import` / `export default`) to match the rest
// of this project. If your project is CommonJS instead (no "type":"module" in
// package.json, other routes use module.exports), tell me and I'll hand you a
// CommonJS version — but the symptom you hit (no CORS header even on OPTIONS)
// is the classic sign the function never loaded, which is what a module-format
// mismatch causes.
//
//   GET  /api/admin?action=summary
//   GET  /api/admin?action=orders        (optional: status, fulfillment_status, limit, offset)
//   GET  /api/admin?action=requests      (optional: status, limit, offset)
//   GET  /api/admin?action=products      (optional: limit, offset)
//   GET  /api/admin?action=wobblelist    (optional: interest, unsubscribed, limit, offset)
//   POST /api/admin?action=update-order      body: { order_id, fulfillment_status?, admin_notes? }
//   POST /api/admin?action=update-request    body: { request_id, status?, admin_notes? }
//   POST /api/admin?action=update-product    body: { product_id, is_active?, is_featured?, stock_quantity?, price_cents?, admin_notes? }
//
// Runs SERVER-SIDE ONLY. Uses the Supabase service role key. Requires
// x-admin-key === process.env.ADMIN_SECRET_KEY on every non-OPTIONS request.
// =============================================================================

import { createClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// CONFIG — edit ONLY these if your Supabase names differ.
// -----------------------------------------------------------------------------
const TABLES = {
  orders: "wobblekin_orders",
  orderItems: "wobblekin_order_items",
  requests: "wobblekin_requests",
  products: "wobblekin_products",
  subscribers: "wobblelist_subscribers",
};

// Column on wobblekin_order_items that points back at an order's primary key.
const ORDER_ITEMS_FK = "order_id";
// Primary key column on the orders table.
const ORDERS_PK = "id";

const ALLOWED_FULFILLMENT = [
  "new", "reviewing", "printing", "packed", "shipped", "fulfilled", "cancelled",
];
const ALLOWED_REQUEST_STATUS = [
  "new", "reviewing", "needs_info", "approved", "in_design", "printing", "completed", "declined",
];

// -----------------------------------------------------------------------------
// CORS — set on EVERY response via setCorsHeaders + sendJson.
// -----------------------------------------------------------------------------
const allowedOrigins = [
  "https://wobblekins.com",
  "https://www.wobblekins.com",
  "https://wobblekins-backend.vercel.app",
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const allowedOrigin = allowedOrigins.includes(origin)
    ? origin
    : "https://www.wobblekins.com";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key, X-Admin-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store");
}

// Single response helper — re-applies CORS before sending, so unauthorized,
// invalid-action, method-not-allowed, Supabase-error and success paths all
// carry the headers.
function sendJson(req, res, status, payload) {
  setCorsHeaders(req, res);
  return res.status(status).json(payload);
}
function jsonOk(req, res, data) {
  return sendJson(req, res, 200, { ok: true, ...data });
}
function jsonError(req, res, status, message) {
  return sendJson(req, res, status, { ok: false, error: message });
}

// -----------------------------------------------------------------------------
// Supabase (service role). Reuses the same env names your other functions use.
// -----------------------------------------------------------------------------
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  }
  _supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

// -----------------------------------------------------------------------------
// Auth (Node lowercases incoming header names, so this catches x-admin-key
// AND X-Admin-Key from the client).
// -----------------------------------------------------------------------------
function requireAdmin(req, res) {
  const provided = req.headers["x-admin-key"];
  const expected = process.env.ADMIN_SECRET_KEY;
  if (!expected) {
    console.error("[forge] ADMIN_SECRET_KEY is not set on the server.");
    jsonError(req, res, 500, "Server not configured.");
    return false;
  }
  if (!provided || provided !== expected) {
    jsonError(req, res, 401, "Unauthorized");
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Validation utilities
// -----------------------------------------------------------------------------
function parseIntParam(value, def, { min = 0, max = 500 } = {}) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function toIntOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}
function toBoolOrNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return null;
}
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

// =============================================================================
// CUSTOMER STATUS EMAILS (via Resend)
//
// Best-effort: a failed send NEVER fails the status update. Emails fire only
// when the status actually CHANGES (handled in the update routes below).
//
// To silence a status, delete its entry / set it to null below. `new` is
// intentionally omitted because your order + request confirmation emails
// already cover the "we received it" moment.
//
// Uses RESEND_API_KEY (already set, since your other emails work) and sends
// from your verified domain. Edit FROM_EMAIL / REPLY_TO_EMAIL if needed.
// -----------------------------------------------------------------------------
const FROM_EMAIL = "The Wobble Lab <requests@wobblekins.com>";
const REPLY_TO_EMAIL = "genesisforge@wobblekins.com";

const ORDER_STATUS_EMAILS = {
  // new: null,  // initial state — covered by the order confirmation email
  reviewing: { accent: "#3b9dff", subject: "We're reviewing your Wobblekins order",
    heading: "Your order is being reviewed",
    body: "Our team is looking over your order to make sure every detail is just right before we begin." },
  printing: { accent: "#ff8a1f", subject: "Your Wobblekins order is being forged",
    heading: "In the forge",
    body: "Good news — your order has entered production. Each Wobblekin is made with care, so this is where the magic starts." },
  packed: { accent: "#ffd23f", subject: "Your Wobblekins order is packed",
    heading: "Packed and ready",
    body: "Your order is packed up and ready to leave the workshop. We'll let you know the moment it ships." },
  shipped: { accent: "#15d0c0", subject: "Your Wobblekins order is on its way",
    heading: "On its way to you",
    body: "Your order has shipped and is making its way to you. Keep an eye out — your Wobblekins are almost home." },
  fulfilled: { accent: "#42d60c", subject: "Your Wobblekins order is complete",
    heading: "All done",
    body: "Your order is now complete. We hope your new Wobblekins bring a little wobble of joy. Thank you for adopting from the Wobble Lab." },
  cancelled: { accent: "#ff3b6b", subject: "Your Wobblekins order has been cancelled",
    heading: "Your order was cancelled",
    body: "Your order has been cancelled. If this wasn't expected or you have any questions, just reply to this email and we'll help sort it out." },
};

const REQUEST_STATUS_EMAILS = {
  // new: null,  // initial state — covered by the request confirmation email
  reviewing: { accent: "#3b9dff", subject: "We're reviewing your Wobble Lab request",
    heading: "Your request is being reviewed",
    body: "Thanks for your Wobble Lab request! Our team is reviewing the details now and will be in touch soon." },
  needs_info: { accent: "#ffd23f", subject: "We need a little more info on your Wobble Lab request",
    heading: "A quick question",
    body: "We'd love to move your request forward, but we need a little more information first. Please reply to this email and we'll take it from there." },
  approved: { accent: "#42d60c", subject: "Your Wobble Lab request is approved",
    heading: "Approved!",
    body: "Great news — your Wobble Lab request has been approved and is heading into design." },
  in_design: { accent: "#a85cff", subject: "Your Wobblekin is in design",
    heading: "In design",
    body: "Your custom Wobblekin is now being designed. This is where your ideas start taking shape." },
  printing: { accent: "#ff8a1f", subject: "Your Wobblekin is being forged",
    heading: "In the forge",
    body: "Your custom Wobblekin has entered production — made with care, one wobble at a time." },
  completed: { accent: "#42d60c", subject: "Your Wobble Lab creation is complete",
    heading: "Complete",
    body: "Your custom Wobblekin is finished! Thank you for creating something one-of-a-kind with the Wobble Lab." },
  declined: { accent: "#ff3b6b", subject: "An update on your Wobble Lab request",
    heading: "About your request",
    body: "After review, we're not able to move forward with this particular request. If you'd like to know more or try a different idea, just reply — we're happy to help." },
};

function escapeHtmlEmail(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Email-safe template: inline styles, web-safe fonts (email clients strip web
// fonts), dark card with the status accent + a thin rainbow bar for brand feel.
function renderStatusEmail({ accent, heading, body, customerName, statusLabel, refLabel, refValue, extraHtml }) {
  const name = customerName ? escapeHtmlEmail(customerName) : "there";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#000000;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtmlEmail(heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:28px 12px;">
 <tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0d0d12;border:1px solid rgba(255,255,255,0.12);border-radius:18px;overflow:hidden;">
   <tr><td style="height:5px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>
   <tr><td style="height:3px;background:linear-gradient(90deg,#ff3b6b,#ff8a1f,#ffd23f,#42d60c,#15d0c0,#3b9dff,#a85cff,#ff5fd2);font-size:0;line-height:0;">&nbsp;</td></tr>
   <tr><td style="padding:30px 30px 6px 30px;">
     <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${accent};">The Wobble Lab</div>
     <div style="margin-top:10px;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.15;color:#f4f4f8;font-weight:bold;">${escapeHtmlEmail(heading)}</div>
   </td></tr>
   <tr><td style="padding:14px 30px 4px 30px;">
     <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#d8d8e0;">Hi ${name},</p>
     <p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#d8d8e0;">${escapeHtmlEmail(body)}</p>
   </td></tr>
   <tr><td style="padding:0 30px 6px 30px;">
     <span style="display:inline-block;background:#060608;border:1px solid rgba(255,255,255,0.12);border-radius:999px;padding:8px 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#f4f4f8;">
       ${escapeHtmlEmail(refLabel)}: <strong style="color:${accent};">${escapeHtmlEmail(refValue)}</strong> &nbsp;&middot;&nbsp; Status: <strong style="color:${accent};">${escapeHtmlEmail(statusLabel)}</strong>
     </span>
   </td></tr>
   ${extraHtml || ""}
   <tr><td style="padding:22px 30px 30px 30px;">
     <hr style="border:0;border-top:1px solid rgba(255,255,255,0.12);margin:0 0 16px 0;"/>
     <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#8a8a96;">
       Questions? Just reply to this email and we'll get back to you.<br/>
       With wobbles,<br/>The Wobble Lab &middot; wobblekins.com
     </p>
   </td></tr>
  </table>
 </td></tr>
</table></body></html>`;
}

async function sendCustomerEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set on the server.");
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], reply_to: REPLY_TO_EMAIL, subject, html }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Resend ${resp.status}: ${text.slice(0, 300)}`);
  }
  return true;
}

// Returns { emailed, emailError }. Never throws.
async function maybeSendStatusEmail({ map, status, to, customerName, refLabel, refValue, statusLabel, extraHtml }) {
  const tpl = map[status];
  if (!tpl) return { emailed: false, emailError: null };        // silenced / no template
  if (!to) return { emailed: false, emailError: "No customer email on record." };
  try {
    const html = renderStatusEmail({
      accent: tpl.accent, heading: tpl.heading, body: tpl.body,
      customerName, statusLabel: statusLabel || status, refLabel, refValue, extraHtml,
    });
    await sendCustomerEmail({ to, subject: tpl.subject, html });
    console.log(`[forge] status email sent: ${refLabel} ${refValue} -> ${status} (${to})`);
    return { emailed: true, emailError: null };
  } catch (e) {
    console.error("[forge] status email failed:", e.message);
    return { emailed: false, emailError: e.message };
  }
}

// =============================================================================
// ACTION HANDLERS  (each takes req, res, supabase)
// =============================================================================

// --- summary -----------------------------------------------------------------
async function safeCount(supabase, table, filter) {
  try {
    let q = supabase.from(table).select("*", { count: "exact", head: true });
    if (filter) q = q.eq(filter.col, filter.val);
    const { count, error } = await q;
    if (error) { console.error(`[forge] count(${table})`, error.message); return null; }
    return count ?? 0;
  } catch (err) {
    console.error(`[forge] count(${table}) threw`, err.message);
    return null;
  }
}
async function latest(supabase, table, columns) {
  const { data, error } = await supabase
    .from(table).select(columns)
    .order("created_at", { ascending: false }).limit(5);
  if (error) { console.error(`[forge] latest(${table})`, error.message); return []; }
  return data || [];
}
async function handleSummary(req, res, supabase) {
  const [
    ordersTotal, ordersPaid, ordersPending, ordersUnfulfilled,
    requestsTotal, requestsNew, subscribersTotal, productsActive,
    latestOrders, latestRequests,
  ] = await Promise.all([
    safeCount(supabase, TABLES.orders),
    safeCount(supabase, TABLES.orders, { col: "status", val: "paid" }),
    safeCount(supabase, TABLES.orders, { col: "status", val: "pending" }),
    safeCount(supabase, TABLES.orders, { col: "fulfillment_status", val: "new" }),
    safeCount(supabase, TABLES.requests),
    safeCount(supabase, TABLES.requests, { col: "status", val: "new" }),
    safeCount(supabase, TABLES.subscribers),
    safeCount(supabase, TABLES.products, { col: "is_active", val: true }),
    latest(supabase, TABLES.orders,
      "id, created_at, customer_name, customer_email, status, fulfillment_status, amount_total"),
    latest(supabase, TABLES.requests,
      "id, created_at, customer_name, email, status"),
  ]);

  return jsonOk(req, res, {
    counts: {
      ordersTotal, ordersPaid, ordersPending, ordersUnfulfilled,
      requestsTotal, requestsNew, subscribersTotal, productsActive,
    },
    latestOrders, latestRequests,
  });
}

// --- orders (with nested items) ----------------------------------------------
async function handleOrders(req, res, supabase) {
  const { status, fulfillment_status } = req.query || {};
  const limit = parseIntParam(req.query?.limit, 100, { min: 1, max: 500 });
  const offset = parseIntParam(req.query?.offset, 0, { min: 0, max: 100000 });

  let q = supabase.from(TABLES.orders).select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq("status", status);
  if (fulfillment_status) q = q.eq("fulfillment_status", fulfillment_status);

  const { data: orders, error } = await q;
  if (error) {
    console.error("[forge] orders select:", error.message);
    return jsonError(req, res, 500, "Failed to load orders.");
  }
  const safeOrders = orders || [];

  const orderIds = safeOrders.map((o) => o[ORDERS_PK]).filter(Boolean);
  const itemsByOrder = {};
  if (orderIds.length) {
    const { data: items, error: itemsErr } = await supabase
      .from(TABLES.orderItems).select("*").in(ORDER_ITEMS_FK, orderIds);
    if (itemsErr) {
      console.error("[forge] orders items:", itemsErr.message); // non-fatal
    } else {
      for (const it of items || []) {
        const key = it[ORDER_ITEMS_FK];
        (itemsByOrder[key] = itemsByOrder[key] || []).push(it);
      }
    }
  }
  const withItems = safeOrders.map((o) => ({ ...o, items: itemsByOrder[o[ORDERS_PK]] || [] }));
  return jsonOk(req, res, { orders: withItems, limit, offset });
}

// --- requests ----------------------------------------------------------------
async function handleRequests(req, res, supabase) {
  const { status } = req.query || {};
  const limit = parseIntParam(req.query?.limit, 100, { min: 1, max: 500 });
  const offset = parseIntParam(req.query?.offset, 0, { min: 0, max: 100000 });

  let q = supabase.from(TABLES.requests).select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    console.error("[forge] requests select:", error.message);
    return jsonError(req, res, 500, "Failed to load requests.");
  }
  return jsonOk(req, res, { requests: data || [], limit, offset });
}

// --- products ----------------------------------------------------------------
async function handleProducts(req, res, supabase) {
  const limit = parseIntParam(req.query?.limit, 200, { min: 1, max: 500 });
  const offset = parseIntParam(req.query?.offset, 0, { min: 0, max: 100000 });

  const { data, error } = await supabase
    .from(TABLES.products).select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    console.error("[forge] products select:", error.message);
    return jsonError(req, res, 500, "Failed to load products.");
  }
  return jsonOk(req, res, { products: data || [], limit, offset });
}

// --- wobblelist --------------------------------------------------------------
async function handleWobblelist(req, res, supabase) {
  const { interest } = req.query || {};
  const unsubscribed = toBoolOrNull(req.query?.unsubscribed);
  const limit = parseIntParam(req.query?.limit, 500, { min: 1, max: 500 });
  const offset = parseIntParam(req.query?.offset, 0, { min: 0, max: 100000 });

  let q = supabase.from(TABLES.subscribers).select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (interest) q = q.eq("interest", interest);
  if (unsubscribed !== null) q = q.eq("unsubscribed", unsubscribed);

  const { data, error } = await q;
  if (error) {
    console.error("[forge] wobblelist select:", error.message);
    return jsonError(req, res, 500, "Failed to load subscribers.");
  }
  return jsonOk(req, res, { subscribers: data || [], limit, offset });
}

// --- update-order ------------------------------------------------------------
async function handleUpdateOrder(req, res, supabase) {
  const body = readBody(req);
  const { order_id, fulfillment_status, admin_notes } = body;
  if (!order_id) return jsonError(req, res, 400, "order_id is required.");

  // Read the current row first so we can tell whether the status actually
  // changed — we only email on a real change, never on a notes-only save.
  const { data: existing, error: exErr } = await supabase
    .from(TABLES.orders).select("*").eq(ORDERS_PK, order_id).single();
  if (exErr || !existing) {
    console.error("[forge] update-order load:", exErr && exErr.message);
    return jsonError(req, res, 404, "Order not found.");
  }

  const update = {};
  if (fulfillment_status !== undefined) {
    if (!ALLOWED_FULFILLMENT.includes(fulfillment_status)) {
      return jsonError(req, res, 400, "Invalid fulfillment_status.");
    }
    update.fulfillment_status = fulfillment_status;
  }
  if (admin_notes !== undefined) {
    update.admin_notes = admin_notes === null ? null : String(admin_notes);
  }
  if (Object.keys(update).length === 0) return jsonError(req, res, 400, "Nothing to update.");
  update.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from(TABLES.orders).update(update).eq(ORDERS_PK, order_id).select().single();
  if (error) {
    console.error("[forge] update-order:", error.message);
    return jsonError(req, res, 500, "Failed to update order.");
  }

  // Customer status email — best effort, only on a real status change.
  let emailResult = { emailed: false, emailError: null };
  if (update.fulfillment_status && update.fulfillment_status !== existing.fulfillment_status) {
    const to = data.customer_email || existing.customer_email;
    const name = data.customer_name || existing.customer_name;

    // Optional tracking block — shown only when shipped AND a tracking value
    // exists on the order (future-proof; harmless if those columns are absent).
    let extraHtml = "";
    if (update.fulfillment_status === "shipped" && (data.tracking_url || data.tracking_number)) {
      const inner = data.tracking_url
        ? `<a href="${data.tracking_url}" style="color:#15d0c0;">Track your package</a>`
        : `Tracking: <strong style="color:#15d0c0;">${escapeHtmlEmail(data.tracking_number)}</strong>`;
      extraHtml = `<tr><td style="padding:10px 30px 0 30px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#d8d8e0;">${inner}</td></tr>`;
    }

    emailResult = await maybeSendStatusEmail({
      map: ORDER_STATUS_EMAILS,
      status: update.fulfillment_status,
      to, customerName: name,
      refLabel: "Order", refValue: String(order_id),
      statusLabel: update.fulfillment_status, extraHtml,
    });
  }

  return jsonOk(req, res, { order: data, emailed: emailResult.emailed, emailError: emailResult.emailError });
}

// --- update-request ----------------------------------------------------------
async function handleUpdateRequest(req, res, supabase) {
  const body = readBody(req);
  const { request_id, status, admin_notes } = body;
  if (!request_id) return jsonError(req, res, 400, "request_id is required.");

  // Read the current row first so we only email on a real status change.
  const { data: existing, error: exErr } = await supabase
    .from(TABLES.requests).select("*").eq("id", request_id).single();
  if (exErr || !existing) {
    console.error("[forge] update-request load:", exErr && exErr.message);
    return jsonError(req, res, 404, "Request not found.");
  }

  const update = {};
  if (status !== undefined) {
    if (!ALLOWED_REQUEST_STATUS.includes(status)) {
      return jsonError(req, res, 400, "Invalid status.");
    }
    update.status = status;
  }
  if (admin_notes !== undefined) {
    update.admin_notes = admin_notes === null ? null : String(admin_notes);
  }
  if (Object.keys(update).length === 0) return jsonError(req, res, 400, "Nothing to update.");
  update.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from(TABLES.requests).update(update).eq("id", request_id).select().single();
  if (error) {
    console.error("[forge] update-request:", error.message);
    return jsonError(req, res, 500, "Failed to update request.");
  }

  // Customer status email — best effort, only on a real status change.
  let emailResult = { emailed: false, emailError: null };
  if (update.status && update.status !== existing.status) {
    const to = data.email || existing.email || data.customer_email || existing.customer_email;
    const name = data.customer_name || existing.customer_name;
    emailResult = await maybeSendStatusEmail({
      map: REQUEST_STATUS_EMAILS,
      status: update.status,
      to, customerName: name,
      refLabel: "Request", refValue: String(request_id),
      statusLabel: update.status,
    });
  }

  return jsonOk(req, res, { request: data, emailed: emailResult.emailed, emailError: emailResult.emailError });
}

// --- update-product ----------------------------------------------------------
async function handleUpdateProduct(req, res, supabase) {
  const body = readBody(req);
  const { product_id, is_active, is_featured, stock_quantity, price_cents, admin_notes } = body;
  if (!product_id) return jsonError(req, res, 400, "product_id is required.");

  const update = {};
  if (is_active !== undefined) {
    const b = toBoolOrNull(is_active);
    if (b === null) return jsonError(req, res, 400, "is_active must be boolean.");
    update.is_active = b;
  }
  if (is_featured !== undefined) {
    const b = toBoolOrNull(is_featured);
    if (b === null) return jsonError(req, res, 400, "is_featured must be boolean.");
    update.is_featured = b;
  }
  if (stock_quantity !== undefined) {
    const n = toIntOrNull(stock_quantity);
    if (n === null || n < 0) return jsonError(req, res, 400, "stock_quantity must be a number >= 0.");
    update.stock_quantity = n;
  }
  if (price_cents !== undefined) {
    const n = toIntOrNull(price_cents);
    if (n === null || n < 0) return jsonError(req, res, 400, "price_cents must be a number >= 0.");
    update.price_cents = n;
  }
  if (admin_notes !== undefined) {
    update.admin_notes = admin_notes === null ? null : String(admin_notes);
  }
  if (Object.keys(update).length === 0) return jsonError(req, res, 400, "Nothing to update.");
  update.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from(TABLES.products).update(update).eq("id", product_id).select().single();
  if (error) {
    console.error("[forge] update-product:", error.message);
    return jsonError(req, res, 500, "Failed to update product.");
  }
  return jsonOk(req, res, { product: data });
}

// =============================================================================
// ROUTER
// =============================================================================
const GET_ACTIONS = {
  summary: handleSummary,
  orders: handleOrders,
  requests: handleRequests,
  products: handleProducts,
  wobblelist: handleWobblelist,
};
const POST_ACTIONS = {
  "update-order": handleUpdateOrder,
  "update-request": handleUpdateRequest,
  "update-product": handleUpdateProduct,
};

export default async function handler(req, res) {
  // 1) CORS first — before auth, action parsing, or anything that can fail.
  setCorsHeaders(req, res);

  // Diagnostic logs (visible in Vercel -> Deployments -> Functions -> Logs).
  console.log("Admin API method:", req.method);
  console.log("Admin API origin:", req.headers.origin);
  console.log("Admin API action:", req.query && req.query.action);

  // 2) Answer the preflight before checking the admin key.
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // 3) Auth (writes a CORS-bearing 401/500 and returns false if it fails).
  if (!requireAdmin(req, res)) return;

  const action = (req.query && req.query.action) || "";

  try {
    const supabase = getSupabase();

    if (req.method === "GET") {
      const fn = GET_ACTIONS[action];
      if (!fn) return jsonError(req, res, 404, `Unknown GET action: ${action || "(none)"}`);
      return await fn(req, res, supabase);
    }
    if (req.method === "POST") {
      const fn = POST_ACTIONS[action];
      if (!fn) return jsonError(req, res, 404, `Unknown POST action: ${action || "(none)"}`);
      return await fn(req, res, supabase);
    }
    return jsonError(req, res, 405, "Method not allowed.");
  } catch (error) {
    console.error("Admin API error:", error);
    return sendJson(req, res, 500, { ok: false, error: "Admin API failed." });
  }
}
