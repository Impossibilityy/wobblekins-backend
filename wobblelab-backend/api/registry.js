// api/registry.js
// =============================================================================
// THE WOBBLE REGISTRY — single consolidated route (Vercel Hobby friendly),
// modelled on api/admin.js so it matches this project's conventions exactly:
// CORS-first, jsonOk/jsonError helpers, lazy memoized service-role client, ESM.
//
// CUSTOMER actions  (identity comes ONLY from verifying the Supabase JWT):
//   POST /api/registry?action=validate_claim     { token? , code? }
//   POST /api/registry?action=claim_forgeprint   { token? , code? }
//   GET  /api/registry?action=get_my_forgeprints
//   GET  /api/registry?action=get_forgeprint&id=<uuid|forge_id>
//
// ADMIN actions  (x-admin-key === process.env.ADMIN_SECRET_KEY):
//   POST /api/registry?action=admin_create_forgeprints
//   GET  /api/registry?action=admin_list_forgeprints   (q, status, wave, order_id, product_id, limit, offset)
//   GET  /api/registry?action=admin_get_forgeprint&id=<uuid|forge_id>
//   POST /api/registry?action=admin_reissue_claim       { instance_id }
//   POST /api/registry?action=admin_revoke_forgeprint   { instance_id }
//   POST /api/registry?action=admin_reset_claim         { instance_id }
//   GET  /api/registry?action=admin_generate_print_data (order_id | ids)
//
// SECURITY
//   • Customer identity is the verified Bearer JWT (supabase.auth.getUser). A
//     user_id in the body is ignored.
//   • Only SHA-256 hashes of the token + manual code are stored.
//   • All mutations run through SECURITY DEFINER RPCs granted to service_role
//     only (see registry-migration.sql).
//   • The public Forge ID can never claim — claims need the token or manual code.
//   • Lightweight in-memory rate limiting blunts brute-force of the manual code.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------
const TABLES = {
  instances: "wobblekin_instances",
  events: "wobblekin_ownership_events",
  orders: "wobblekin_orders",
  orderItems: "wobblekin_order_items",
  products: "wobblekin_products",
};
const DEFAULT_WAVE = parseInt(process.env.REGISTRY_DEFAULT_WAVE || "2", 10);
const CLAIM_BASE_URL =
  process.env.REGISTRY_CLAIM_BASE_URL || process.env.WOBBLEKINS_SITE_URL || "https://www.wobblekins.com";

// Safe columns to return to a customer (never the secret hashes).
const CUSTOMER_COLUMNS =
  "id, forge_id, product_id, order_id, wave_number, wave_name, instance_number, " +
  "edition_size, display_name, image_url, species, personality, temperament, " +
  "element_theme, colorway, rarity, traits_snapshot, lore_snapshot, claim_status, " +
  "forged_at, issued_at, claimed_at";

// -----------------------------------------------------------------------------
// CORS — identical pattern to admin.js (CORS on EVERY response).
// -----------------------------------------------------------------------------
const allowedOrigins = [
  "https://wobblekins.com",
  "https://www.wobblekins.com",
  "https://wobblekins-backend.vercel.app",
];
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : "https://www.wobblekins.com";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-key, X-Admin-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store");
}
function sendJson(req, res, status, payload) {
  setCorsHeaders(req, res);
  return res.status(status).json(payload);
}
const jsonOk = (req, res, data) => sendJson(req, res, 200, { ok: true, ...data });
const jsonError = (req, res, status, message, extra) =>
  sendJson(req, res, status, { ok: false, error: message, ...(extra || {}) });

// -----------------------------------------------------------------------------
// Supabase service-role client (lazy + memoized; identical to admin.js).
// -----------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  _supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return _supabase;
}

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------
function requireAdmin(req, res) {
  const provided = req.headers["x-admin-key"];
  const expected = process.env.ADMIN_SECRET_KEY;
  if (!expected) { console.error("[registry] ADMIN_SECRET_KEY not set."); jsonError(req, res, 500, "Server not configured."); return false; }
  if (!provided || provided !== expected) { jsonError(req, res, 401, "Unauthorized"); return false; }
  return true;
}
async function getAuthedUser(req, supabase) {
  const header = req.headers["authorization"] || req.headers["Authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch (e) { console.error("[registry] getUser:", e.message); return null; }
}

// -----------------------------------------------------------------------------
// Crypto / utilities
// -----------------------------------------------------------------------------
const sha256hex = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
function newClaimToken() { return crypto.randomBytes(32).toString("base64url"); }
function newManualCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = (n) => Array.from(crypto.randomBytes(n), (b) => A[b % A.length]).join("");
  return `WBL-${pick(4)}-${pick(4)}`;
}
function normalizeManualCode(raw) {
  let s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("WBL")) s = s.slice(3);
  if (s.length !== 8) return null;
  return `WBL-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}
function codeHashFromInput(raw) { const n = normalizeManualCode(raw); return n ? sha256hex(n) : "__invalid__"; }
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}
function parseIntParam(value, def, { min = 0, max = 500 } = {}) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function parseWaveFromName(name) {
  const m = String(name || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}
// Lightweight per-instance rate limit (best-effort; resets on cold start). For
// hard guarantees add Vercel/edge or Upstash rate limiting in front.
const _rl = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const rec = _rl.get(key);
  if (!rec || now - rec.start > windowMs) { _rl.set(key, { start: now, n: 1 }); return false; }
  rec.n += 1;
  return rec.n > max;
}

// -----------------------------------------------------------------------------
// Optional best-effort issue email (OFF unless REGISTRY_ISSUE_EMAIL=true).
// Reuses the existing Resend conventions; NEVER includes the private token.
// -----------------------------------------------------------------------------
function escapeBasic(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
async function maybeSendIssueEmail(supabase, orderId, created) {
  if (String(process.env.REGISTRY_ISSUE_EMAIL || "").toLowerCase() !== "true") return { emailed: false, emailError: null };
  if (!orderId || !process.env.RESEND_API_KEY) return { emailed: false, emailError: null };
  try {
    const { data: order } = await supabase.from(TABLES.orders).select("customer_email, customer_name").eq("id", orderId).maybeSingle();
    const to = order && order.customer_email;
    if (!to) return { emailed: false, emailError: "No customer email on the order." };
    const name = (order.customer_name || "there").split(" ")[0];
    const count = created.length;
    const names = created.map((c) => c.display_name).filter(Boolean).slice(0, 6).join(", ");
    const html =
      `<div style="margin:0;background:#000;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;">
        <table role="presentation" width="560" align="center" style="max-width:560px;background:#0d0d12;border:1px solid rgba(255,255,255,.12);border-radius:18px;overflow:hidden;">
          <tr><td style="height:4px;background:linear-gradient(90deg,#ff3b6b,#ff8a1f,#ffd23f,#42d60c,#15d0c0,#3b9dff,#a85cff,#ff5fd2);font-size:0;">&nbsp;</td></tr>
          <tr><td style="padding:28px 28px 18px;">
            <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#15d0c0;">The Wobble Registry</div>
            <h1 style="margin:10px 0 6px;color:#f4f4f8;font-size:23px;">Your Wobblekin is ready to complete its adoption</h1>
            <p style="margin:0 0 14px;color:#cfcfd8;font-size:15px;line-height:1.6;">Hi ${escapeBasic(name)}, the Wobble Lab has prepared ${count > 1 ? `${count} Forgeprints` : "a Forgeprint"}${names ? ` (${escapeBasic(names)})` : ""}. When your Wobblekin${count > 1 ? "s" : ""} arrive, scan the <strong>Adoption Tag</strong> in the box to complete the adoption and add ${count > 1 ? "them" : "it"} to your Wobblekin Family.</p>
            <p style="margin:0;color:#8a8a96;font-size:12px;line-height:1.6;">For your security, the scannable code lives only on the physical Adoption Tag — never in email.</p>
          </td></tr>
        </table>
      </div>`;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.REGISTRY_FROM_EMAIL || "The Wobble Lab <adoptions@wobblekins.com>",
        to: [to], reply_to: process.env.REGISTRY_REPLY_TO || "genesisforge@wobblekins.com",
        subject: "Your Wobblekin is ready to complete its adoption", html,
      }),
    });
    if (!resp.ok) return { emailed: false, emailError: `Resend ${resp.status}` };
    return { emailed: true, emailError: null };
  } catch (e) { console.error("[registry] issue email (non-fatal):", e.message); return { emailed: false, emailError: e.message }; }
}

// Safe preview projection (never hashes / owner id / order internals).
function preview(inst) {
  if (!inst) return null;
  return {
    id: inst.id, forge_id: inst.forge_id, display_name: inst.display_name, image_url: inst.image_url,
    wave_number: inst.wave_number, wave_name: inst.wave_name, instance_number: inst.instance_number,
    edition_size: inst.edition_size, species: inst.species, personality: inst.personality,
    temperament: inst.temperament, element_theme: inst.element_theme, colorway: inst.colorway,
    rarity: inst.rarity, traits_snapshot: inst.traits_snapshot, lore_snapshot: inst.lore_snapshot,
    claim_status: inst.claim_status, forged_at: inst.forged_at, claimed_at: inst.claimed_at,
  };
}
async function resolveInstanceBySecret(supabase, { token, code }) {
  if (token) {
    const { data } = await supabase.from(TABLES.instances).select("*").eq("claim_token_hash", sha256hex(token)).maybeSingle();
    if (data) return data;
  }
  if (code) {
    const { data } = await supabase.from(TABLES.instances).select("*").eq("manual_claim_code_hash", codeHashFromInput(code)).maybeSingle();
    if (data) return data;
  }
  return null;
}

// =============================================================================
// CUSTOMER ACTIONS
// =============================================================================
async function handleGetMyForgeprints(req, res, supabase, user) {
  if (!user) return jsonError(req, res, 401, "Please sign in to view your Wobblekin Family.", { state: "auth_required" });
  const { data, error } = await supabase.from(TABLES.instances).select(CUSTOMER_COLUMNS)
    .eq("owner_user_id", user.id)
    .order("claimed_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) { console.error("[registry] get_my_forgeprints:", error.message); return jsonError(req, res, 500, "We couldn't load your Wobblekin Family right now."); }
  return jsonOk(req, res, { forgeprints: data || [] });
}

async function handleGetForgeprint(req, res, supabase, user) {
  if (!user) return jsonError(req, res, 401, "Please sign in.", { state: "auth_required" });
  const idParam = String((req.query && (req.query.id || req.query.forge_id)) || "").trim();
  if (!idParam) return jsonError(req, res, 400, "Missing id.");
  const isUuid = /^[0-9a-f-]{36}$/i.test(idParam);
  const { data, error } = await supabase.from(TABLES.instances).select(CUSTOMER_COLUMNS + ", owner_user_id")
    .eq(isUuid ? "id" : "forge_id", idParam).maybeSingle();
  if (error) { console.error("[registry] get_forgeprint:", error.message); return jsonError(req, res, 500, "We couldn't load that Adoption Record."); }
  if (!data || data.owner_user_id !== user.id) return jsonError(req, res, 404, "Adoption Record not found.");
  delete data.owner_user_id;
  return jsonOk(req, res, { forgeprint: data });
}

// Preview only (no mutation). Requires auth so the customer reaches the claim
// step already signed in — a 401 tells the UI to stash the pending claim and
// prompt sign-in, then replay it afterwards (preserves the QR claim token).
async function handleValidateClaim(req, res, supabase, user) {
  if (!user) return jsonError(req, res, 401, "Please sign in to complete the adoption.", { state: "auth_required" });
  if (rateLimited("validate:" + clientIp(req), 30, 60000)) return jsonError(req, res, 429, "Too many attempts. Please wait a moment and try again.", { state: "rate_limited" });
  const { token, code } = readBody(req);
  if (!token && !code) return jsonError(req, res, 400, "Provide a scan token or an Adoption Code.");
  const inst = await resolveInstanceBySecret(supabase, { token, code });
  if (!inst) return jsonError(req, res, 404, "That Adoption Tag wasn't recognised.", { state: "invalid" });

  if (inst.claim_status === "revoked") return jsonOk(req, res, { state: "revoked", forgeprint: preview(inst) });
  if (inst.claim_status === "claimed")
    return jsonOk(req, res, { state: inst.owner_user_id === user.id ? "already_yours" : "taken", forgeprint: preview(inst) });
  if (inst.claim_status !== "issued") return jsonOk(req, res, { state: "not_ready", forgeprint: preview(inst) });
  return jsonOk(req, res, { state: "claimable", forgeprint: preview(inst) });
}

// The claim — authenticated, single-use, atomic, idempotent.
async function handleClaimForgeprint(req, res, supabase, user) {
  if (!user) return jsonError(req, res, 401, "Please sign in to complete the adoption.", { state: "auth_required" });
  if (rateLimited("claim:" + user.id, 20, 60000)) return jsonError(req, res, 429, "Too many attempts. Please wait a moment and try again.", { state: "rate_limited" });
  const { token, code } = readBody(req);
  if (!token && !code) return jsonError(req, res, 400, "Provide a scan token or an Adoption Code.");
  const inst = await resolveInstanceBySecret(supabase, { token, code });
  if (!inst) return jsonError(req, res, 404, "That Adoption Tag wasn't recognised.", { state: "invalid" });

  const { data, error } = await supabase.rpc("claim_wobblekin", { p_instance_id: inst.id, p_user_id: user.id });
  if (error) { console.error("[registry] claim_wobblekin:", error.message); return jsonError(req, res, 500, "We couldn't complete the adoption right now. Please try again."); }
  const row = (Array.isArray(data) ? data[0] : data) || {};

  // Success (and idempotent retry) both return ok + the full owned record.
  if (row.result === "claimed" || row.result === "already_yours") {
    const { data: full } = await supabase.from(TABLES.instances).select(CUSTOMER_COLUMNS).eq("id", inst.id).maybeSingle();
    return jsonOk(req, res, { state: row.result, forgeprint: full || preview(inst) });
  }
  if (row.result === "taken")    return jsonError(req, res, 409, "This Wobblekin has already joined another family.", { state: "taken" });
  if (row.result === "revoked")  return jsonError(req, res, 410, "This Adoption Tag is no longer active. Please contact support.", { state: "revoked" });
  if (row.result === "not_found")return jsonError(req, res, 404, "That Adoption Tag wasn't recognised.", { state: "invalid" });
  return jsonError(req, res, 409, "This Wobblekin isn't ready to be adopted yet.", { state: "not_ready" });
}

// =============================================================================
// ADMIN ACTIONS
// =============================================================================
function deriveProductCode(product, override) {
  const o = String(override || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (o) return o.slice(0, 4);
  const base = String(product?.slug || product?.name || "WK").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return base.slice(0, 2) || "WK";
}
function buildSnapshot(product, ov) {
  const m = (product && product.metadata) || {};
  return {
    display_name: ov.display_name || product?.name || "Wobblekin",
    image_url: ov.image_url || product?.image_url || null,
    species: ov.species || product?.species || null,
    personality: ov.personality || product?.personality || null,
    temperament: ov.temperament || m.temperament || null,
    element_theme: ov.element_theme || m.element_theme || null,
    colorway: ov.colorway || m.colorway || null,
    rarity: ov.rarity || product?.rarity || null,
    wave_name: ov.wave_name || product?.wave_name || null,
    traits_snapshot: ov.traits_snapshot || m.traits || m || {},
    lore_snapshot: ov.lore_snapshot || { wobbledex: m.wobbledex_lore || null, description: product?.description || null, short_description: product?.short_description || null },
  };
}
async function hashesTaken(supabase, tokenHash, codeHash) {
  const { data } = await supabase.from(TABLES.instances).select("id")
    .or(`claim_token_hash.eq.${tokenHash},manual_claim_code_hash.eq.${codeHash}`).limit(1);
  return (data || []).length > 0;
}

async function handleAdminCreate(req, res, supabase) {
  const body = readBody(req);
  const { product_id, order_id, order_item_id, quantity, edition_size, issue = true, overrides, performed_by } = body;
  if (!product_id) return jsonError(req, res, 400, "product_id is required.");
  const qty = Math.max(1, Math.min(500, parseInt(quantity, 10) || 1));
  const ov = overrides && typeof overrides === "object" ? overrides : {};

  const { data: product, error: prodErr } = await supabase.from(TABLES.products).select("*").eq("id", product_id).maybeSingle();
  if (prodErr) { console.error("[registry] create load product:", prodErr.message); return jsonError(req, res, 500, "Could not load product."); }
  if (!product) return jsonError(req, res, 404, "Product not found.");

  const productCode = deriveProductCode(product, body.product_code);
  const waveNumber = parseIntParam(body.wave_number, parseWaveFromName(product.wave_name) ?? DEFAULT_WAVE, { min: 1, max: 999 });
  const snap = buildSnapshot(product, ov);
  const editionSize = edition_size != null ? (parseInt(edition_size, 10) || null) : null;
  const who = performed_by ? String(performed_by).slice(0, 120) : "forge-console";

  const created = [];
  for (let i = 0; i < qty; i++) {
    let token, code2, tokenHash, codeHash, attempt = 0;
    do {
      token = newClaimToken(); code2 = newManualCode();
      tokenHash = sha256hex(token); codeHash = sha256hex(code2); attempt++;
    } while (attempt < 4 && await hashesTaken(supabase, tokenHash, codeHash));

    const { data, error } = await supabase.rpc("create_wobblekin_instance", {
      p_product_id: product_id, p_product_code: productCode, p_wave_number: waveNumber,
      p_wave_name: snap.wave_name, p_edition_size: editionSize, p_order_id: order_id || null,
      p_order_item_id: order_item_id || null, p_display_name: snap.display_name, p_image_url: snap.image_url,
      p_species: snap.species, p_personality: snap.personality, p_temperament: snap.temperament,
      p_element_theme: snap.element_theme, p_colorway: snap.colorway, p_rarity: snap.rarity,
      p_traits_snapshot: snap.traits_snapshot, p_lore_snapshot: snap.lore_snapshot,
      p_claim_token_hash: tokenHash, p_manual_claim_code_hash: codeHash, p_issued: !!issue, p_performed_by: who,
    });
    if (error) {
      console.error("[registry] create_wobblekin_instance:", error.message);
      return jsonError(req, res, 500, `Created ${created.length}/${qty}. Stopped on an error.`, { created });
    }
    const r = (Array.isArray(data) ? data[0] : data) || {};
    created.push({
      id: r.id, forge_id: r.forge_id, instance_number: r.instance_number,
      display_name: snap.display_name, image_url: snap.image_url, wave_number: waveNumber, wave_name: snap.wave_name,
      claim_url: `${CLAIM_BASE_URL}/claim/${token}`, manual_code: code2,   // secrets — returned ONCE
    });
  }

  const { emailed, emailError } = await maybeSendIssueEmail(supabase, order_id || null, created);
  return jsonOk(req, res, { created, count: created.length, product_code: productCode, wave_number: waveNumber, emailed, emailError, note: "Secrets are shown only once — print the tags now." });
}

async function handleAdminList(req, res, supabase) {
  const q = (req.query && req.query.q ? String(req.query.q) : "").trim();
  const status = req.query && req.query.status;
  const wave = req.query && req.query.wave;
  const orderId = req.query && req.query.order_id;
  const productId = req.query && req.query.product_id;
  const limit = parseIntParam(req.query?.limit, 100, { min: 1, max: 500 });
  const offset = parseIntParam(req.query?.offset, 0, { min: 0, max: 100000 });

  let query = supabase.from(TABLES.instances).select(
    "id, forge_id, product_code, product_id, order_id, order_item_id, owner_user_id, wave_number, wave_name, " +
    "instance_number, edition_size, display_name, image_url, rarity, claim_status, created_at, issued_at, claimed_at, revoked_at",
    { count: "exact" })
    .order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (status) query = query.eq("claim_status", status);
  if (wave) query = query.eq("wave_number", parseInt(wave, 10) || wave);
  if (orderId) query = query.eq("order_id", orderId);
  if (productId) query = query.eq("product_id", productId);
  if (q) query = query.or(`forge_id.ilike.%${q}%,display_name.ilike.%${q}%`);

  const { data: rows, error, count } = await query;
  if (error) { console.error("[registry] admin_list:", error.message); return jsonError(req, res, 500, "Failed to load the registry."); }
  const list = rows || [];

  const ownerIds = [...new Set(list.map((r) => r.owner_user_id).filter(Boolean))];
  const emailByUser = {};
  if (ownerIds.length) {
    try {
      const { data: u } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      for (const usr of (u && u.users) || []) emailByUser[usr.id] = usr.email;
    } catch (e) { console.error("[registry] listUsers:", e.message); }
  }
  const withEmail = list.map((r) => ({ ...r, owner_email: r.owner_user_id ? emailByUser[r.owner_user_id] || null : null }));
  return jsonOk(req, res, { forgeprints: withEmail, count: count ?? withEmail.length, limit, offset });
}

async function handleAdminGet(req, res, supabase) {
  const idParam = String((req.query && (req.query.id || req.query.forge_id)) || "").trim();
  if (!idParam || idParam === "__noop__") return jsonError(req, res, 400, "Missing id.");
  const isUuid = /^[0-9a-f-]{36}$/i.test(idParam);
  const { data: row, error } = await supabase.from(TABLES.instances).select("*").eq(isUuid ? "id" : "forge_id", idParam).maybeSingle();
  if (error) { console.error("[registry] admin_get:", error.message); return jsonError(req, res, 500, "Failed to load record."); }
  if (!row) return jsonError(req, res, 404, "Forgeprint not found.");
  const { data: events } = await supabase.from(TABLES.events).select("*").eq("wobblekin_instance_id", row.id).order("created_at", { ascending: false });
  const { claim_token_hash, manual_claim_code_hash, ...safe } = row;   // strip secret hashes
  return jsonOk(req, res, { forgeprint: safe, events: events || [] });
}

async function handleAdminReissue(req, res, supabase) {
  const { instance_id, performed_by } = readBody(req);
  if (!instance_id) return jsonError(req, res, 400, "instance_id is required.");
  const token = newClaimToken(), code = newManualCode();
  const { data, error } = await supabase.rpc("admin_reissue_wobblekin", {
    p_instance_id: instance_id, p_new_token_hash: sha256hex(token), p_new_code_hash: sha256hex(code),
    p_performed_by: performed_by ? String(performed_by).slice(0, 120) : "forge-console",
  });
  if (error) { console.error("[registry] reissue:", error.message); return jsonError(req, res, 500, "Failed to reissue."); }
  const r = (Array.isArray(data) ? data[0] : data) || {};
  if (r.result === "not_found") return jsonError(req, res, 404, "Forgeprint not found.");
  if (r.result === "already_claimed") return jsonError(req, res, 409, "Already claimed — reset it first if you really need to rotate the secret.");
  return jsonOk(req, res, { forge_id: r.forge_id, claim_url: `${CLAIM_BASE_URL}/claim/${token}`, manual_code: code });
}

async function handleAdminRevoke(req, res, supabase) {
  const { instance_id, performed_by } = readBody(req);
  if (!instance_id) return jsonError(req, res, 400, "instance_id is required.");
  const { data, error } = await supabase.rpc("admin_revoke_wobblekin", {
    p_instance_id: instance_id, p_performed_by: performed_by ? String(performed_by).slice(0, 120) : "forge-console",
  });
  if (error) { console.error("[registry] revoke:", error.message); return jsonError(req, res, 500, "Failed to revoke."); }
  const r = (Array.isArray(data) ? data[0] : data) || {};
  if (r.result === "not_found") return jsonError(req, res, 404, "Forgeprint not found.");
  return jsonOk(req, res, { forge_id: r.forge_id, revoked: true });
}

async function handleAdminReset(req, res, supabase) {
  const { instance_id, performed_by } = readBody(req);
  if (!instance_id) return jsonError(req, res, 400, "instance_id is required.");
  const { data, error } = await supabase.rpc("admin_reset_wobblekin", {
    p_instance_id: instance_id, p_performed_by: performed_by ? String(performed_by).slice(0, 120) : "forge-console",
  });
  if (error) { console.error("[registry] reset:", error.message); return jsonError(req, res, 500, "Failed to reset."); }
  const r = (Array.isArray(data) ? data[0] : data) || {};
  if (r.result === "not_found") return jsonError(req, res, 404, "Forgeprint not found.");
  return jsonOk(req, res, { forge_id: r.forge_id, reset: true });
}

async function handleAdminPrintData(req, res, supabase) {
  const orderId = req.query && req.query.order_id;
  let ids = [];
  const idsParam = req.query && (req.query.ids || req.query.instance_id);
  if (idsParam) ids = String(idsParam).split(",").map((s) => s.trim()).filter(Boolean);
  let query = supabase.from(TABLES.instances).select("id, forge_id, display_name, image_url, wave_number, wave_name, instance_number, edition_size, claim_status");
  if (orderId) query = query.eq("order_id", orderId);
  else if (ids.length) query = query.in("id", ids);
  else return jsonError(req, res, 400, "Provide order_id or ids.");
  const { data, error } = await query.order("instance_number", { ascending: true });
  if (error) { console.error("[registry] print_data:", error.message); return jsonError(req, res, 500, "Failed to build print data."); }
  return jsonOk(req, res, { tags: data || [], note: "Non-secret fields only. The scannable QR/code is shown once at creation or after reissue." });
}

// =============================================================================
// ROUTER
// =============================================================================
const CUSTOMER_GET = { get_my_forgeprints: handleGetMyForgeprints, get_forgeprint: handleGetForgeprint };
const CUSTOMER_POST = { validate_claim: handleValidateClaim, claim_forgeprint: handleClaimForgeprint };
const ADMIN_GET = { admin_list_forgeprints: handleAdminList, admin_get_forgeprint: handleAdminGet, admin_generate_print_data: handleAdminPrintData };
const ADMIN_POST = { admin_create_forgeprints: handleAdminCreate, admin_reissue_claim: handleAdminReissue, admin_revoke_forgeprint: handleAdminRevoke, admin_reset_claim: handleAdminReset };

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = (req.query && req.query.action) || "";
  const isAdmin = action.startsWith("admin_");

  try {
    const supabase = getSupabase();
    if (isAdmin) {
      if (!requireAdmin(req, res)) return;
      if (req.method === "GET") { const fn = ADMIN_GET[action]; if (!fn) return jsonError(req, res, 404, `Unknown GET action: ${action}`); return await fn(req, res, supabase); }
      if (req.method === "POST") { const fn = ADMIN_POST[action]; if (!fn) return jsonError(req, res, 404, `Unknown POST action: ${action}`); return await fn(req, res, supabase); }
      return jsonError(req, res, 405, "Method not allowed.");
    }
    const user = await getAuthedUser(req, supabase);
    if (req.method === "GET") { const fn = CUSTOMER_GET[action]; if (!fn) return jsonError(req, res, 404, `Unknown GET action: ${action}`); return await fn(req, res, supabase, user); }
    if (req.method === "POST") { const fn = CUSTOMER_POST[action]; if (!fn) return jsonError(req, res, 404, `Unknown POST action: ${action}`); return await fn(req, res, supabase, user); }
    return jsonError(req, res, 405, "Method not allowed.");
  } catch (error) {
    console.error("[registry] fatal:", error);
    return sendJson(req, res, 500, { ok: false, error: "Registry API failed." });
  }
}
