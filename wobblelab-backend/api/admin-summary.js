// api/admin-summary.js  — GET only. Returns dashboard counts + latest 5 of each.
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
} = require("./_lib/admin-helpers");

// Count rows matching an optional equality filter. Returns a number, or null on
// error (so one bad column never blanks the whole Overview tab).
async function safeCount(supabase, table, filter) {
  try {
    let q = supabase.from(table).select("*", { count: "exact", head: true });
    if (filter) q = q.eq(filter.col, filter.val);
    const { count, error } = await q;
    if (error) {
      console.error(`[forge] count(${table})`, filter || "", error.message);
      return null;
    }
    return count ?? 0;
  } catch (err) {
    console.error(`[forge] count(${table}) threw`, err.message);
    return null;
  }
}

async function latest(supabase, table, columns) {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) {
    console.error(`[forge] latest(${table})`, error.message);
    return [];
  }
  return data || [];
}

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "GET")) return;
  if (!requireAdmin(req, res)) return;
  noCache(res);

  try {
    const supabase = getSupabase();

    const [
      ordersTotal,
      ordersPaid,
      ordersPending,
      ordersUnfulfilled,
      requestsTotal,
      requestsNew,
      subscribersTotal,
      productsActive,
      latestOrders,
      latestRequests,
    ] = await Promise.all([
      safeCount(supabase, TABLES.orders),
      safeCount(supabase, TABLES.orders, { col: "status", val: "paid" }),
      safeCount(supabase, TABLES.orders, { col: "status", val: "pending" }),
      safeCount(supabase, TABLES.orders, {
        col: "fulfillment_status",
        val: "new",
      }),
      safeCount(supabase, TABLES.requests),
      safeCount(supabase, TABLES.requests, { col: "status", val: "new" }),
      safeCount(supabase, TABLES.subscribers),
      safeCount(supabase, TABLES.products, { col: "is_active", val: true }),
      latest(
        supabase,
        TABLES.orders,
        "id, created_at, customer_name, customer_email, status, fulfillment_status, amount_total"
      ),
      latest(
        supabase,
        TABLES.requests,
        "id, created_at, customer_name, email, status"
      ),
    ]);

    return jsonOk(res, {
      counts: {
        ordersTotal,
        ordersPaid,
        ordersPending,
        ordersUnfulfilled,
        requestsTotal,
        requestsNew,
        subscribersTotal,
        productsActive,
      },
      latestOrders,
      latestRequests,
    });
  } catch (err) {
    console.error("[forge] admin-summary fatal:", err);
    return jsonError(res, 500, "Failed to load summary.");
  }
};
