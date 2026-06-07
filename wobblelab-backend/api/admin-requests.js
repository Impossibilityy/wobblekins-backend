// api/admin-requests.js  — GET only. Recent Wobble Lab requests.
// Optional query params: status, limit, offset
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
} = require("./_lib/admin-helpers");

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "GET")) return;
  if (!requireAdmin(req, res)) return;
  noCache(res);

  try {
    const supabase = getSupabase();
    const { status } = req.query || {};
    const limit = parseIntParam(req.query?.limit, 100, { min: 1, max: 500 });
    const offset = parseIntParam(req.query?.offset, 0, { min: 0, max: 100000 });

    let q = supabase
      .from(TABLES.requests)
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) q = q.eq("status", status);

    const { data, error } = await q;
    if (error) {
      console.error("[forge] admin-requests select:", error.message);
      return jsonError(res, 500, "Failed to load requests.");
    }

    return jsonOk(res, { requests: data || [], limit, offset });
  } catch (err) {
    console.error("[forge] admin-requests fatal:", err);
    return jsonError(res, 500, "Failed to load requests.");
  }
};
