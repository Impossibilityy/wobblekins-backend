// api/admin-update-product.js  — POST only.
// Body: { product_id, is_active?, is_featured?, stock_quantity?, price_cents?, admin_notes? }
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
  readBody,
  toIntOrNull,
  toBoolOrNull,
} = require("./_lib/admin-helpers");

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "POST")) return;
  if (!requireAdmin(req, res)) return;
  noCache(res);

  try {
    const body = readBody(req);
    const {
      product_id,
      is_active,
      is_featured,
      stock_quantity,
      price_cents,
      admin_notes,
    } = body;

    if (!product_id) return jsonError(res, 400, "product_id is required.");

    const update = {};

    if (is_active !== undefined) {
      const b = toBoolOrNull(is_active);
      if (b === null) return jsonError(res, 400, "is_active must be boolean.");
      update.is_active = b;
    }

    if (is_featured !== undefined) {
      const b = toBoolOrNull(is_featured);
      if (b === null) return jsonError(res, 400, "is_featured must be boolean.");
      update.is_featured = b;
    }

    if (stock_quantity !== undefined) {
      const n = toIntOrNull(stock_quantity);
      if (n === null || n < 0) {
        return jsonError(res, 400, "stock_quantity must be a number >= 0.");
      }
      update.stock_quantity = n;
    }

    if (price_cents !== undefined) {
      const n = toIntOrNull(price_cents);
      if (n === null || n < 0) {
        return jsonError(res, 400, "price_cents must be a number >= 0.");
      }
      update.price_cents = n;
    }

    if (admin_notes !== undefined) {
      update.admin_notes = admin_notes === null ? null : String(admin_notes);
    }

    if (Object.keys(update).length === 0) {
      return jsonError(res, 400, "Nothing to update.");
    }

    update.updated_at = new Date().toISOString();

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLES.products)
      .update(update)
      .eq("id", product_id)
      .select()
      .single();

    if (error) {
      console.error("[forge] admin-update-product:", error.message);
      return jsonError(res, 500, "Failed to update product.");
    }

    return jsonOk(res, { product: data });
  } catch (err) {
    console.error("[forge] admin-update-product fatal:", err);
    return jsonError(res, 500, "Failed to update product.");
  }
};
