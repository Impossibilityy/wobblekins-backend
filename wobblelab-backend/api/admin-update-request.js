// api/admin-update-request.js  — POST only.
// Body: { request_id, status?, admin_notes? }
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
} = require("./_lib/admin-helpers");

const ALLOWED_STATUS = [
  "new",
  "reviewing",
  "needs_info",
  "approved",
  "in_design",
  "printing",
  "completed",
  "declined",
];

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "POST")) return;
  if (!requireAdmin(req, res)) return;
  noCache(res);

  try {
    const body = readBody(req);
    const { request_id, status, admin_notes } = body;

    if (!request_id) return jsonError(res, 400, "request_id is required.");

    const update = {};

    if (status !== undefined) {
      if (!ALLOWED_STATUS.includes(status)) {
        return jsonError(res, 400, "Invalid status.");
      }
      update.status = status;
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
      .from(TABLES.requests)
      .update(update)
      .eq("id", request_id)
      .select()
      .single();

    if (error) {
      console.error("[forge] admin-update-request:", error.message);
      return jsonError(res, 500, "Failed to update request.");
    }

    return jsonOk(res, { request: data });
  } catch (err) {
    console.error("[forge] admin-update-request fatal:", err);
    return jsonError(res, 500, "Failed to update request.");
  }
};
