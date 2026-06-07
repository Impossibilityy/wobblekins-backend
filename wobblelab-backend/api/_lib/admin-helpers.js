// api/_lib/admin-helpers.js
// -----------------------------------------------------------------------------
// Forge Console — shared server-side helpers (Phase 1)
//
// This file lives in api/_lib/ . On Vercel, any file or folder inside /api whose
// name starts with an underscore ( _ ) is NOT turned into an HTTP endpoint, so
// this module is safe to import from the real admin-* routes without creating a
// "/api/_lib/admin-helpers" URL.
//
// Everything here runs SERVER-SIDE ONLY. It uses the Supabase service role key.
// Never import this from client code.
// -----------------------------------------------------------------------------

const { createClient } = require("@supabase/supabase-js");

// -----------------------------------------------------------------------------
// 1. CONFIG — edit ONLY these if your Supabase names differ.
//    (See the "How to verify your real names" notes in the chat answer.)
// -----------------------------------------------------------------------------

// Table names exactly as they appear in Supabase.
const TABLES = {
  orders: "wobblekin_orders",
  orderItems: "wobblekin_order_items",
  requests: "wobblekin_requests",
  products: "wobblekin_products",
  subscribers: "wobblelist_subscribers",
};

// Column on wobblekin_order_items that points back at an order's primary key.
// If your order items use a different column (e.g. "wobblekin_order_id"),
// change it here only.
const ORDER_ITEMS_FK = "order_id";

// Primary key column on the orders table (used to match order items + updates).
const ORDERS_PK = "id";

// Origins allowed to call these admin routes from a browser.
const ALLOWED_ORIGINS = [
  "https://wobblekins.com",
  "https://www.wobblekins.com",
  "https://wobblekins-backend.vercel.app",
];

// -----------------------------------------------------------------------------
// 2. Supabase (service role) client
// -----------------------------------------------------------------------------

// We reuse the same env var names your existing working functions use.
// Common fallbacks are included so this matches most setups out of the box.
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // Thrown server-side; caller converts to a generic 500 for the browser.
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars on the server."
    );
  }
  _supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

// -----------------------------------------------------------------------------
// 3. CORS + caching
// -----------------------------------------------------------------------------

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-admin-key"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

// Returns true if it fully handled an OPTIONS preflight (caller should return).
function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

function noCache(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

// -----------------------------------------------------------------------------
// 4. Auth + method guards
// -----------------------------------------------------------------------------

// Returns true if authorized. If not, writes a 401 and returns false.
function requireAdmin(req, res) {
  const provided = req.headers["x-admin-key"];
  const expected = process.env.ADMIN_SECRET_KEY;

  if (!expected) {
    console.error("[forge] ADMIN_SECRET_KEY is not set on the server.");
    jsonError(res, 500, "Server not configured.");
    return false;
  }
  if (!provided || provided !== expected) {
    jsonError(res, 401, "Unauthorized");
    return false;
  }
  return true;
}

// Returns true if the method matches. Otherwise writes 405 and returns false.
function requireMethod(req, res, method) {
  if (req.method !== method) {
    jsonError(res, 405, `Method not allowed. Use ${method}.`);
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// 5. JSON response helpers
// -----------------------------------------------------------------------------

function jsonOk(res, data) {
  res.setHeader("Content-Type", "application/json");
  res.status(200).json({ ok: true, ...data });
}

function jsonError(res, status, message) {
  res.setHeader("Content-Type", "application/json");
  res.status(status).json({ ok: false, error: message });
}

// -----------------------------------------------------------------------------
// 6. Small validation utilities
// -----------------------------------------------------------------------------

// Parse a query param as a bounded integer with a default.
function parseIntParam(value, def, { min = 0, max = 500 } = {}) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Returns a finite integer or null (used to validate price_cents / stock).
function toIntOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

// Coerce common truthy/falsey inputs into a real boolean, or null if absent.
function toBoolOrNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return null;
}

// Read JSON body whether Vercel parsed it or handed us a raw string.
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

module.exports = {
  TABLES,
  ORDER_ITEMS_FK,
  ORDERS_PK,
  ALLOWED_ORIGINS,
  getSupabase,
  setCorsHeaders,
  handlePreflight,
  noCache,
  requireAdmin,
  requireMethod,
  jsonOk,
  jsonError,
  parseIntParam,
  toIntOrNull,
  toBoolOrNull,
  readBody,
};
