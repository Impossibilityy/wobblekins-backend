// api/admin-orders.js  — GET only. Recent orders with nested order items.
// Optional query params: status, fulfillment_status, limit, offset
const {
  TABLES,
  ORDER_ITEMS_FK,
  ORDERS_PK,
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
    const { status, fulfillment_status } = req.query || {};
    const limit = parseIntParam(req.query?.limit, 100, { min: 1, max: 500 });
    const offset = parseIntParam(req.query?.offset, 0, { min: 0, max: 100000 });

    // 1) Fetch the orders page.
    let q = supabase
      .from(TABLES.orders)
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) q = q.eq("status", status);
    if (fulfillment_status) q = q.eq("fulfillment_status", fulfillment_status);

    const { data: orders, error } = await q;
    if (error) {
      console.error("[forge] admin-orders select:", error.message);
      return jsonError(res, 500, "Failed to load orders.");
    }

    const safeOrders = orders || [];

    // 2) Fetch matching order items in one query, then group in JS.
    //    Done separately so we don't depend on a Supabase FK relationship.
    const orderIds = safeOrders.map((o) => o[ORDERS_PK]).filter(Boolean);
    let itemsByOrder = {};

    if (orderIds.length) {
      const { data: items, error: itemsErr } = await supabase
        .from(TABLES.orderItems)
        .select("*")
        .in(ORDER_ITEMS_FK, orderIds);

      if (itemsErr) {
        // Non-fatal: still return orders, just without items.
        console.error("[forge] admin-orders items:", itemsErr.message);
      } else {
        for (const it of items || []) {
          const key = it[ORDER_ITEMS_FK];
          (itemsByOrder[key] = itemsByOrder[key] || []).push(it);
        }
      }
    }

    const withItems = safeOrders.map((o) => ({
      ...o,
      items: itemsByOrder[o[ORDERS_PK]] || [],
    }));

    return jsonOk(res, { orders: withItems, limit, offset });
  } catch (err) {
    console.error("[forge] admin-orders fatal:", err);
    return jsonError(res, 500, "Failed to load orders.");
  }
};
