// =====================================================================
//  GET /api/requests                          (optional, Phase 3 bonus)
//  A *very* basic protected internal view. Returns the latest requests
//  as JSON so you can check submissions without a full dashboard yet.
//
//  Protect it with a Bearer token (ADMIN_TOKEN env var):
//     curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
//          https://YOUR-PROJECT.vercel.app/api/requests
//
//  This is intentionally minimal. The real admin panel comes later
//  (see README §Phase 6).
// =====================================================================

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  // --- Auth: require the admin bearer token -----------------------------
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    // ?status=New  and  ?limit=50  are optional filters.
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    let query = supabase
      .from("wobblekin_requests")
      .select(
        "id, request_number, name, email, phone, preferred_wobblekin_name, intended_use, status, image_urls, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    if (req.query.status) query = query.eq("status", req.query.status);

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({ ok: true, count: data.length, requests: data });
  } catch (err) {
    console.error("requests list error:", err.message);
    return res.status(500).json({ ok: false, error: "Could not load requests." });
  }
}
