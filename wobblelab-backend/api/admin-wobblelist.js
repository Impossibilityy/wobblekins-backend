// api/admin-wobblelist.js  — GET only. Wobblelist subscribers.
// Optional query params: interest, unsubscribed, limit, offset
const {
  TABLES,
  getSupabase,
  setCorsHeaders,
  handlePreflight,
  noCache,
  requireAdmin,
  requireMethod,
  jsonOk,
  jsonError,
  parseIntParam,
  toBoolOrNull,
} = require("./_lib/admin-helpers");

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "GET")) return;
  if (!requireAdmin(req, res)) return;
  noCache(res);

  try {
    const supabase = getSupabase();
    const { interest } = req.query || {};
    const unsubscribed = toBoolOrNull(req.query?.unsubscribed);
    const limit = parseIntParam(req.query?.limit, 500, { min: 1, max: 500 });
    const offset = parseIntParam(req.query?.offset, 0, { min: 0, max: 100000 });

    let q = supabase
      .from(TABLES.subscribers)
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (interest) q = q.eq("interest", interest);
    if (unsubscribed !== null) q = q.eq("unsubscribed", unsubscribed);

    const { data, error } = await q;
    if (error) {
      console.error("[forge] admin-wobblelist select:", error.message);
      return jsonError(res, 500, "Failed to load subscribers.");
    }

    return jsonOk(res, { subscribers: data || [], limit, offset });
  } catch (err) {
    console.error("[forge] admin-wobblelist fatal:", err);
    return jsonError(res, 500, "Failed to load subscribers.");
  }
};
