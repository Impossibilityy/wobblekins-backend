// api/admin-update-order.js  — POST only.
// Body: { order_id, fulfillment_status?, admin_notes? }
const {
  TABLES,
  ORDERS_PK,
  getSupabase,
  setCorsHeaders,
  handlePreflight,
  noCache,
  requireAdmin,
  requireMethod,
  jsonOk,
  jsonError,
  readBody,
} = require("./_lib/admin-helpers");

const ALLOWED_FULFILLMENT = [
  "new",
  "reviewing",
  "printing",
  "packed",
  "shipped",
  "fulfilled",
  "cancelled",
];

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "POST")) return;
  if (!requireAdmin(req, res)) return;
  noCache(res);

  try {
    const body = readBody(req);
    const { order_id, fulfillment_status, admin_notes } = body;

    if (!order_id) return jsonError(res, 400, "order_id is required.");

    // Build a whitelist-only update object — never trust arbitrary keys.
    const update = {};

    if (fulfillment_status !== undefined) {
      if (!ALLOWED_FULFILLMENT.includes(fulfillment_status)) {
        return jsonError(res, 400, "Invalid fulfillment_status.");
      }
      update.fulfillment_status = fulfillment_status;
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
      .from(TABLES.orders)
      .update(update)
      .eq(ORDERS_PK, order_id)
      .select()
      .single();

    if (error) {
      console.error("[forge] admin-update-order:", error.message);
      return jsonError(res, 500, "Failed to update order.");
    }

    // NOTE (future): customer "order update" emails would be triggered here,
    // after a successful status change. Intentionally not implemented in Phase 1.
    return jsonOk(res, { order: data });
  } catch (err) {
    console.error("[forge] admin-update-order fatal:", err);
    return jsonError(res, 500, "Failed to update order.");
  }
};
