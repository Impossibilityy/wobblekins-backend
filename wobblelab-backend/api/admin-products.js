// api/admin-products.js  — GET only. All products (active + inactive).
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
    const limit = parseIntParam(req.query?.limit, 200, { min: 1, max: 500 });
    const offset = parseIntParam(req.query?.offset, 0, { min: 0, max: 100000 });

    const { data, error } = await supabase
      .from(TABLES.products)
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error("[forge] admin-products select:", error.message);
      return jsonError(res, 500, "Failed to load products.");
    }

    return jsonOk(res, { products: data || [], limit, offset });
  } catch (err) {
    console.error("[forge] admin-products fatal:", err);
    return jsonError(res, 500, "Failed to load products.");
  }
};
