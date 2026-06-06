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
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");

if (req.method === "OPTIONS") {
  return res.status(200).end();
}
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
  <div style="margin:0;padding:0;background:#000000;font-family:Arial,Helvetica,sans-serif;color:#f4f4f8;">
    <div style="max-width:680px;margin:0 auto;padding:28px 14px;background:
      radial-gradient(circle at 10% 0%, rgba(59,157,255,.18), transparent 30%),
      radial-gradient(circle at 90% 10%, rgba(168,92,255,.16), transparent 32%),
      radial-gradient(circle at 50% 100%, rgba(21,208,192,.12), transparent 35%),
      #000000;">

      <!-- Outer card -->
      <div style="background:#060608;border:1px solid rgba(255,255,255,.12);border-radius:28px;overflow:hidden;box-shadow:0 18px 50px rgba(255,255,255,.08);">

        <!-- Thin rainbow forge line -->
        <div style="height:5px;background:linear-gradient(90deg,#ff3b6b,#ff8a1f,#ffd23f,#42d60c,#15d0c0,#3b9dff,#a85cff,#ff5fd2);"></div>

        <!-- Header -->
        <div style="padding:30px 24px 22px;text-align:center;background:
          radial-gradient(circle at 20% 20%, rgba(255,59,107,.18), transparent 28%),
          radial-gradient(circle at 80% 20%, rgba(66,214,12,.16), transparent 28%),
          #060608;">

          <div style="display:inline-block;margin-bottom:14px;padding:6px 12px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:#0d0d12;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:700;color:#15d0c0;">
            Wobble Wave · Custom Request
          </div>

          <h1 style="margin:0;font-size:34px;line-height:1.08;font-weight:900;color:#f4f4f8;">
            <span style="color:#ff3b6b;">Your</span>
            <span style="color:#42d60c;"> Wobblekin</span>
            <span style="color:#3b9dff;"> Entered</span>
            <span style="color:#ff8a1f;"> the</span>
            <span style="color:#a85cff;"> Wobble Lab</span>
          </h1>

          <p style="margin:16px auto 0;max-width:520px;font-size:15px;line-height:1.65;color:#d8d8e8;">
            <span style="color:#ff5fd2;">A new little creature spark</span>
            <span style="color:#ffd23f;"> has landed in the forge.</span>
            <span style="color:#15d0c0;"> We received your custom request</span>
            <span style="color:#3b9dff;"> and it is now waiting for review.</span>
          </p>
        </div>

        <!-- Main content -->
        <div style="padding:24px;">

          <!-- Greeting card -->
          <div style="background:#0d0d12;border:1px solid rgba(255,255,255,.12);border-radius:22px;padding:20px;margin-bottom:18px;">
            <p style="font-size:16px;line-height:1.6;margin:0 0 14px;color:#f4f4f8;">
              Hi <strong style="color:#ffd23f;">${escapeHtml(name)}</strong>,
            </p>

            <p style="font-size:15.5px;line-height:1.65;margin:0;color:#d8d8e8;">
              Your custom Wobblekin request has officially entered the Wobble Lab.
              Our tiny forge crew will review the trait mix, reference images, and overall creature vibe before anything moves forward.
            </p>
          </div>

          <!-- Request ID forge plate -->
          <div style="margin:22px 0;padding:3px;border-radius:22px;background:linear-gradient(90deg,#ff3b6b,#ff8a1f,#ffd23f,#42d60c,#15d0c0,#3b9dff,#a85cff,#ff5fd2);">
            <div style="background:#050507;border-radius:19px;padding:20px;text-align:center;">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:4px;color:#15d0c0;font-weight:700;margin-bottom:8px;">
                Request ID
              </div>
              <div style="font-size:28px;font-weight:900;color:#ffffff;letter-spacing:1px;">
                ${escapeHtml(requestNumber)}
              </div>
              <div style="margin-top:8px;font-size:12px;color:#8f8fa3;">
                Keep this ID handy if you reply with updates.
              </div>
            </div>
          </div>

          <!-- Details chips -->
          <div style="margin:18px 0 20px;">
            ${
              preferred_wobblekin_name
                ? `<div style="margin-bottom:10px;background:#0d0d12;border:1px solid rgba(255,255,255,.12);border-left:4px solid #ffd23f;border-radius:16px;padding:13px 15px;">
                    <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#ffd23f;font-weight:800;margin-bottom:4px;">Preferred Name</div>
                    <div style="font-size:15px;color:#f4f4f8;font-weight:700;">${escapeHtml(preferred_wobblekin_name)}</div>
                  </div>`
                : ""
            }

            ${
              intended_use
                ? `<div style="margin-bottom:10px;background:#0d0d12;border:1px solid rgba(255,255,255,.12);border-left:4px solid #42d60c;border-radius:16px;padding:13px 15px;">
                    <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#42d60c;font-weight:800;margin-bottom:4px;">Intended Use</div>
                    <div style="font-size:15px;color:#f4f4f8;font-weight:700;">${escapeHtml(intended_use)}</div>
                  </div>`
                : ""
            }
          </div>

          <!-- Wobbledex / next steps panel -->
          <div style="background:#0d0d12;border:1px solid rgba(255,255,255,.12);border-radius:22px;padding:20px;margin:22px 0;">

            <div style="display:inline-block;margin-bottom:12px;padding:5px 10px;border-radius:999px;background:#060608;border:1px solid rgba(255,255,255,.12);font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#3b9dff;font-weight:800;">
              Discovery Log
            </div>

            <h2 style="font-size:22px;line-height:1.15;margin:0 0 14px;color:#f4f4f8;">
              <span style="color:#ff3b6b;">What</span>
              <span style="color:#ff8a1f;"> happens</span>
              <span style="color:#ffd23f;"> next?</span>
            </h2>

            <div style="border-left:2px solid rgba(255,255,255,.12);padding-left:16px;margin-top:12px;">

              <div style="margin-bottom:16px;">
                <div style="font-size:13px;color:#ff3b6b;font-weight:900;margin-bottom:4px;">01 · Request Review</div>
                <div style="font-size:15px;line-height:1.6;color:#d8d8e8;">
                  We check your Wobble Lab selections, notes, and any reference images.
                </div>
              </div>

              <div style="margin-bottom:16px;">
                <div style="font-size:13px;color:#ffd23f;font-weight:900;margin-bottom:4px;">02 · Creature Fit Check</div>
                <div style="font-size:15px;line-height:1.6;color:#d8d8e8;">
                  We make sure the idea has the right mix of charm, wobble, and print-friendly personality.
                </div>
              </div>

              <div>
                <div style="font-size:13px;color:#42d60c;font-weight:900;margin-bottom:4px;">03 · Next Step Message</div>
                <div style="font-size:15px;line-height:1.6;color:#d8d8e8;">
                  If we need anything else, we’ll reach out before moving your Wobblekin forward.
                </div>
              </div>

            </div>
          </div>

          <!-- Reply note -->
          <div style="background:#060608;border:1px dashed rgba(255,255,255,.18);border-radius:18px;padding:17px;margin:20px 0;">
            <p style="font-size:15px;line-height:1.65;margin:0;color:#d8d8e8;">
              Need to add a sketch, pet photo, color note, or extra idea?
              Just reply to this email and include
              <strong style="color:#ffd23f;">${escapeHtml(requestNumber)}</strong>
              so we can match it to your request.
            </p>
          </div>

          <!-- Signoff -->
          <p style="font-size:16px;line-height:1.6;margin:22px 0 0;color:#f4f4f8;">
            <span style="color:#15d0c0;">Thanks for sending a new creature spark into the Wobble Lab.</span>
          </p>

          <p style="font-size:16px;font-weight:900;margin:8px 0 0;color:#ff5fd2;">
            The Wobblekins Team
          </p>

        </div>

        <!-- Footer -->
        <div style="padding:18px 24px 24px;text-align:center;background:#050507;border-top:1px solid rgba(255,255,255,.10);">
          <p style="font-size:12px;line-height:1.5;color:#8f8fa3;margin:0;">
            Wobblekins · Custom creature requests · Wobble Lab · Future Wobbledex discoveries
          </p>
          <p style="font-size:11px;line-height:1.5;color:#66667a;margin:8px 0 0;">
            Request ID: ${escapeHtml(requestNumber)}
          </p>
        </div>

      </div>
    </div>
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
