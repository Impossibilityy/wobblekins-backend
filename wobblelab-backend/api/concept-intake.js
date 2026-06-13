// api/concept-intake.js
// =============================================================================
// Forge Console — Creative Pipeline INTAKE (agent / Zapier -> Supabase staging)
//
// This is the ONLY endpoint the Creative Pipeline Agent (via Zapier) talks to.
// It writes drafts into wobblekin_concept_queue with status "needs_review".
// It can NEVER create live products or Wobbledex entries — it only stages.
//
// -----------------------------------------------------------------------------
// >>> ZAPIER / AGENT SETUP <<<
// In Zapier, add a "Webhooks by Zapier -> POST" (or "Custom Request") step:
//
//   URL:     https://wobblekins-backend.vercel.app/api/concept-intake
//   Method:  POST
//   Headers:
//     Content-Type:     application/json
//     x-webhook-secret:  <value of CONCEPT_INTAKE_SECRET from Vercel env vars>
//   Data (JSON body) — map your agent output to these keys:
//     {
//       "name": "", "slug": "", "rarity": "", "species_class": "",
//       "traits": {}, "personality": "", "temperament": "",
//       "visual_description": "", "adoption_blurb": "", "wobbledex_lore": "",
//       "product_description": "", "short_social_caption": "",
//       "image_prompt": "", "model_prompt": "", "print_notes": "",
//       "safety_notes": "", "raw_agent_output": {}
//     }
//
// "name" is the only required field. "slug" is auto-derived from name if blank.
// "traits" and "raw_agent_output" must be JSON objects (sent as objects, not
// strings) — though strings that parse as JSON are also accepted.
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const TABLE = "wobblekin_concept_queue";

// Only these keys are ever read off the payload and written to the row.
// NOTE: status / approved / review_notes are deliberately NOT here — the agent
// cannot self-approve or set review notes. The server forces those values.
const TEXT_FIELDS = [
  "name", "slug", "rarity", "species_class", "personality", "temperament",
  "visual_description", "adoption_blurb", "wobbledex_lore", "product_description",
  "short_social_caption", "image_prompt", "model_prompt", "print_notes", "safety_notes",
];
const JSON_FIELDS = ["traits", "raw_agent_output"];

// --- Supabase (service role, server-side only) -------------------------------
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

// --- helpers -----------------------------------------------------------------
function sendJson(res, status, payload) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(payload);
}
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}
function asString(v) {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}
function asObject(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
  }
  return {};
}
function slugify(s) {
  return String(s || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// --- handler -----------------------------------------------------------------
export default async function handler(req, res) {
  // This is a server-to-server webhook (Zapier/agent), so no browser CORS is
  // needed. Answer OPTIONS harmlessly in case a tester sends one.
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Use POST." });

  // 1) Shared-secret auth so random people can't insert records.
  const provided = req.headers["x-webhook-secret"];
  const expected = process.env.CONCEPT_INTAKE_SECRET;
  if (!expected) {
    console.error("[forge] CONCEPT_INTAKE_SECRET is not set on the server.");
    return sendJson(res, 500, { ok: false, error: "Server not configured." });
  }
  if (!provided || provided !== expected) {
    return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const body = readBody(req);

    // 2) Validate required fields.
    const name = asString(body.name).trim();
    if (!name) return sendJson(res, 400, { ok: false, error: "Field 'name' is required." });

    // 3) Build a whitelist-only record. Unknown keys are ignored.
    const record = {};
    for (const f of TEXT_FIELDS) record[f] = asString(body[f]);
    for (const f of JSON_FIELDS) record[f] = asObject(body[f]);

    record.name = name;
    if (!record.slug) record.slug = slugify(name);

    // 4) Server-controlled fields — agent can never set these.
    record.status = "needs_review";
    record.approved = false;

    // 5) Insert into the staging queue.
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE).insert(record).select("id, created_at, status, name, slug").single();

    if (error) {
      console.error("[forge] concept-intake insert:", error.message);
      return sendJson(res, 500, { ok: false, error: "Failed to stage concept." });
    }

    console.log(`[forge] concept staged: ${data.id} (${data.slug})`);
    return sendJson(res, 200, { ok: true, concept: data });
  } catch (err) {
    console.error("[forge] concept-intake fatal:", err);
    return sendJson(res, 500, { ok: false, error: "Intake failed." });
  }
}
