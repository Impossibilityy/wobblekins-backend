// =====================================================================
//  POST /api/submit-request                                  (Phase 3)
//  Receives a Wobblekin request from the custom Hostinger widget.
//
//  Flow:
//   1. CORS + method guard (POST only)
//   2. Parse multipart/form-data (fields + reference_images files)
//   3. Validate required fields (name, email)
//   4. Upload optional images to Supabase Storage
//   5. Insert the request into Supabase (DB generates WOB-000001)
//   6. Email a clean summary via Resend
//   7. Return JSON { ok, request_number, image_urls }
//
//  Runtime: Node (NOT Edge). @vercel/node does not parse multipart
//  bodies, so formidable reads the raw request stream directly.
// =====================================================================

import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import formidable from "formidable";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

// ---- Config ----------------------------------------------------------
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_BYTES = 5 * 1024 * 1024;   // 5 MB per file
const MAX_FILES = 6;                       // max images per request

// ---- Small helpers ---------------------------------------------------

// Allow the browser (Hostinger origin) to call this Vercel function.
function setCors(res) {
  const allowed = process.env.ALLOWED_ORIGIN || "*";
  // If multiple origins are configured, the calling origin is echoed back
  // only when it matches; otherwise we fall back to the first one.
  res.setHeader("Access-Control-Allow-Origin", allowed.split(",")[0].trim());
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// formidable v3 returns every field as an array — grab the first value.
function one(v) {
  if (Array.isArray(v)) return v.length ? v[0] : "";
  return v == null ? "" : v;
}

// Parse a value that may be a JSON string (selected_traits) or already an object.
function parseMaybeJson(v) {
  const s = one(v);
  if (!s) return {};
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch { return {}; }
}

function safeName(name) {
  return String(name || "image")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-80);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Turn the structured traits object into readable "Label: value" lines.
function traitsToLines(traits) {
  const labels = {
    creatureBase: "Creature Base", bodyShape: "Body Shape", element: "Element",
    surface: "Surface / Texture", headFeature: "Head Feature",
    earFeature: "Ear / Horn / Antenna", tailFeature: "Tail Feature",
    limbStyle: "Limb Style", backFeature: "Back Feature",
    bellyDetail: "Belly / Chest Detail", eyeStyle: "Eye Style",
    mouthExpr: "Mouth / Expression", accessory: "Accessory / Add-on",
    colorPalette: "Color Palette", personality: "Personality"
  };
  return Object.keys(traits || {})
    .map((k) => {
      const v = traits[k];
      const val = Array.isArray(v) ? v.join(", ") : v;
      if (!val) return null;
      const label = labels[k] || k;
      return { label, val };
    })
    .filter(Boolean);
}

// ---- Handler ---------------------------------------------------------
export default async function handler(req, res) {
  setCors(res);

  // CORS preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  // POST only
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  // Fail fast if the server is misconfigured.
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY"]) {
    if (!process.env[key]) {
      console.error("Missing env var:", key);
      return res.status(500).json({ ok: false, error: "Server is not configured." });
    }
  }

  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "wobblekin-references";

  // Service role client — server-only, bypasses RLS.
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // --- 2. Parse multipart/form-data ---------------------------------
    const form = formidable({
      multiples: true,
      maxFiles: MAX_FILES,
      maxFileSize: MAX_FILE_BYTES,
      maxTotalFileSize: MAX_FILES * MAX_FILE_BYTES,
      // Reject anything that isn't an allowed image up front.
      filter: ({ mimetype }) => !mimetype || ALLOWED_MIME.includes(mimetype),
    });

    const [fields, files] = await form.parse(req);

    // --- 3. Validate required fields ----------------------------------
    const name = one(fields.name).trim();
    const email = one(fields.email).trim();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (!name || !email || !emailOk) {
      return res.status(400).json({
        ok: false,
        error: "Please provide a valid name and email.",
      });
    }

    // Optional fields
    const phone = one(fields.phone).trim();
    const preferred_wobblekin_name =
      one(fields.preferred_wobblekin_name || fields.preferred_name).trim();
    const intended_use = one(fields.intended_use).trim();
    const full_request = one(fields.full_request || fields.request_summary).trim();
    const message = one(fields.message || fields.notes).trim();
    const selected_traits = parseMaybeJson(fields.selected_traits);

    // --- 4. Upload images to Supabase Storage -------------------------
    // reference_images may be a single file or an array.
    let uploads = files.reference_images || [];
    if (!Array.isArray(uploads)) uploads = [uploads];
    uploads = uploads.filter(Boolean).slice(0, MAX_FILES);

    const group = crypto.randomUUID();      // folder grouping this submission
    const image_urls = [];

    for (let i = 0; i < uploads.length; i++) {
      const f = uploads[i];
      const mimetype = f.mimetype || "application/octet-stream";

      // Defense in depth — re-check type & size on the server.
      if (!ALLOWED_MIME.includes(mimetype)) continue;
      if (f.size && f.size > MAX_FILE_BYTES) continue;

      try {
        const buffer = await readFile(f.filepath);
        const original = safeName(f.originalFilename || `image-${i + 1}`);
        const path = `${group}/${i + 1}-${original}`;

        const { error: upErr } = await supabase.storage
          .from(bucket)
          .upload(path, buffer, { contentType: mimetype, upsert: false });

        if (upErr) {
          console.error("Storage upload failed:", upErr.message);
          continue; // images are optional; keep going
        }

        const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
        if (pub?.publicUrl) image_urls.push(pub.publicUrl);
      } catch (e) {
        console.error("Image processing error:", e.message);
      }
    }

    // --- 5. Insert into Supabase (request_number generated by DB) -----
    const { data: inserted, error: dbErr } = await supabase
      .from("wobblekin_requests")
      .insert({
        name,
        email,
        phone: phone || null,
        preferred_wobblekin_name: preferred_wobblekin_name || null,
        intended_use: intended_use || null,
        selected_traits,
        full_request: full_request || null,
        message: message || null,
        image_urls,
        // status defaults to 'New' in the DB
      })
      .select("id, request_number, created_at")
      .single();

    if (dbErr || !inserted) {
      console.error("DB insert failed:", dbErr?.message);
      return res.status(500).json({
        ok: false,
        error: "We couldn't save your request. Please try again.",
      });
    }

    const requestNumber = inserted.request_number;

    // --- 6. Email the summary via Resend ------------------------------
    // Email failure should NOT fail the customer's submission (it's saved).
    try {
      const traitLines = traitsToLines(selected_traits);
      const traitsHtml = traitLines.length
        ? `<table style="border-collapse:collapse;font-size:14px">` +
          traitLines
            .map(
              (t) =>
                `<tr>
                   <td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap">${escapeHtml(t.label)}</td>
                   <td style="padding:4px 0;font-weight:600">${escapeHtml(t.val)}</td>
                 </tr>`
            )
            .join("") +
          `</table>`
        : `<p style="color:#888">No specific traits selected.</p>`;

      const imagesHtml = image_urls.length
        ? image_urls
            .map(
              (u, i) =>
                `<a href="${escapeHtml(u)}" style="color:#3b9dff">Reference image ${i + 1}</a>`
            )
            .join("<br>")
        : "None attached.";

      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto;color:#111">
          <h2 style="margin:0 0 4px">New Wobblekin Request</h2>
          <p style="margin:0 0 16px;font-size:18px;font-weight:700;color:#a85cff">${escapeHtml(requestNumber)}</p>

          <h3 style="margin:18px 0 6px">Customer</h3>
          <p style="margin:0;line-height:1.6">
            <strong>Name:</strong> ${escapeHtml(name)}<br>
            <strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a><br>
            ${phone ? `<strong>Phone:</strong> ${escapeHtml(phone)}<br>` : ""}
            ${preferred_wobblekin_name ? `<strong>Preferred name:</strong> ${escapeHtml(preferred_wobblekin_name)}<br>` : ""}
            ${intended_use ? `<strong>Intended use:</strong> ${escapeHtml(intended_use)}<br>` : ""}
          </p>

          <h3 style="margin:18px 0 6px">Trait selections</h3>
          ${traitsHtml}

          ${full_request ? `<h3 style="margin:18px 0 6px">Full request</h3>
            <pre style="white-space:pre-wrap;background:#f6f6f8;padding:12px;border-radius:8px;font-size:13px">${escapeHtml(full_request)}</pre>` : ""}

          ${message ? `<h3 style="margin:18px 0 6px">Message / notes</h3>
            <p style="white-space:pre-wrap">${escapeHtml(message)}</p>` : ""}

          <h3 style="margin:18px 0 6px">Reference images</h3>
          <p style="line-height:1.8">${imagesHtml}</p>

          <hr style="margin:22px 0;border:none;border-top:1px solid #eee">
          <p style="font-size:12px;color:#999">Submitted ${escapeHtml(inserted.created_at)} · Status: New</p>
        </div>`;

      const fromEmail = process.env.WOBBLEKINS_FROM_EMAIL;
const adminEmail = process.env.WOBBLEKINS_RECEIVER_EMAIL;

const adminSubject = `New Wobblekin Request ${requestNumber} — ${name}`;
const customerSubject = `Your Wobblekin request entered the Wobble Lab! ${requestNumber}`;

const customerHtml = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111;line-height:1.6;background:#ffffff;">
    <div style="padding:24px;border-radius:18px;border:1px solid #eee;background:linear-gradient(135deg,#fff,#f8f8ff);">
      
      <h1 style="margin:0 0 10px;font-size:26px;line-height:1.2;">
        Your Wobblekin request entered the Wobble Lab!
      </h1>

      <p style="font-size:16px;margin:0 0 18px;">
        Hi ${escapeHtml(name)},
      </p>

      <p style="font-size:16px;margin:0 0 16px;">
        Your custom Wobblekin request has officially made it into the lab queue.
        We received your creature details, and your request ID is:
      </p>

      <div style="font-size:22px;font-weight:800;letter-spacing:.04em;background:#111;color:#fff;padding:14px 18px;border-radius:14px;margin:18px 0;text-align:center;">
        ${escapeHtml(requestNumber)}
      </div>

      ${
        preferred_wobblekin_name
          ? `<p style="margin:0 0 8px;"><strong>Preferred Wobblekin name:</strong> ${escapeHtml(preferred_wobblekin_name)}</p>`
          : ""
      }

      ${
        intended_use
          ? `<p style="margin:0 0 18px;"><strong>Intended use:</strong> ${escapeHtml(intended_use)}</p>`
          : ""
      }

      <div style="background:#f6f6f6;border-radius:14px;padding:16px 18px;margin:20px 0;">
        <h2 style="font-size:18px;margin:0 0 10px;">What happens next?</h2>
        <p style="margin:0 0 8px;">1. We’ll review your request.</p>
        <p style="margin:0 0 8px;">2. We’ll check the trait mix, reference images, and overall creature idea.</p>
        <p style="margin:0;">3. We’ll reach out if we need more details before moving forward.</p>
      </div>

      <p style="font-size:16px;margin:18px 0;">
        Our tiny lab crew is checking for the right amount of charm, wobble,
        and personality. If you need to add anything, just reply to this email
        and include your request ID:
        <strong>${escapeHtml(requestNumber)}</strong>.
      </p>

      <p style="font-size:16px;margin:22px 0 0;">
        Thanks for sending a new little creature into the Wobble Lab.
      </p>

      <p style="font-size:16px;font-weight:700;margin:8px 0 0;">
        The Wobblekins Team
      </p>
    </div>

    <p style="font-size:12px;color:#777;text-align:center;margin:18px 0 0;">
      Wobblekins · Custom creature requests from the Wobble Lab
    </p>
  </div>
`;

const emailResults = await Promise.allSettled([
  resend.emails.send({
    from: fromEmail,
    to: adminEmail,
    replyTo: email,
    subject: adminSubject,
    html,
  }),

  resend.emails.send({
    from: fromEmail,
    to: email,
    replyTo: adminEmail,
    subject: customerSubject,
    html: customerHtml,
  }),
]);
      const customerHtml = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111;line-height:1.6;background:#ffffff;">
    <div style="padding:24px;border-radius:18px;border:1px solid #eee;background:linear-gradient(135deg,#fff,#f8f8ff);">
      
      <h1 style="margin:0 0 10px;font-size:26px;line-height:1.2;">
        Your Wobblekin request entered the Wobble Lab!
      </h1>

      <p style="font-size:16px;margin:0 0 18px;">
        Hi ${escapeHtml(name)},
      </p>

      <p style="font-size:16px;margin:0 0 16px;">
        Your custom Wobblekin request has officially made it into the lab queue.
        We received your creature details, and your request ID is:
      </p>

      <div style="font-size:22px;font-weight:800;letter-spacing:.04em;background:#111;color:#fff;padding:14px 18px;border-radius:14px;margin:18px 0;text-align:center;">
        ${escapeHtml(requestNumber)}
      </div>

      ${
        preferred_wobblekin_name
          ? `<p style="margin:0 0 8px;"><strong>Preferred Wobblekin name:</strong> ${escapeHtml(preferred_wobblekin_name)}</p>`
          : ""
      }

      ${
        intended_use
          ? `<p style="margin:0 0 18px;"><strong>Intended use:</strong> ${escapeHtml(intended_use)}</p>`
          : ""
      }

      <div style="background:#f6f6f6;border-radius:14px;padding:16px 18px;margin:20px 0;">
        <h2 style="font-size:18px;margin:0 0 10px;">What happens next?</h2>
        <p style="margin:0 0 8px;">1. We’ll review your request.</p>
        <p style="margin:0 0 8px;">2. We’ll check the trait mix, reference images, and overall creature idea.</p>
        <p style="margin:0;">3. We’ll reach out if we need more details before moving forward.</p>
      </div>

      <p style="font-size:16px;margin:18px 0;">
        Our tiny lab crew is checking for the right amount of charm, wobble,
        and personality. If you need to add anything, just reply to this email
        and include your request ID:
        <strong>${escapeHtml(requestNumber)}</strong>.
      </p>

      <p style="font-size:16px;margin:22px 0 0;">
        Thanks for sending a new little creature into the Wobble Lab.
      </p>

      <p style="font-size:16px;font-weight:700;margin:8px 0 0;">
        The Wobblekins Team
      </p>
    </div>

    <p style="font-size:12px;color:#777;text-align:center;margin:18px 0 0;">
      Wobblekins · Custom creature requests from the Wobble Lab
    </p>
  </div>
`;
    } catch (mailErr) {
      console.error("Resend email failed (request still saved):", mailErr.message);
    }

    // --- 7. Success ---------------------------------------------------
    return res.status(200).json({
      ok: true,
      request_number: requestNumber,
      image_urls,
    });
  } catch (err) {
    // formidable throws on oversized / too-many / disallowed files.
    console.error("submit-request error:", err);
    const msg = /maxFileSize|maxTotalFileSize/.test(String(err?.message))
      ? "One of your images is too large (5 MB max each)."
      : /maxFiles/.test(String(err?.message))
      ? `Please attach at most ${MAX_FILES} images.`
      : "Something went wrong processing your request.";
    return res.status(400).json({ ok: false, error: msg });
  }
}
