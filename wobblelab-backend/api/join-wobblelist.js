import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// --- Config -----------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const FROM_EMAIL = 'Wobblekins <requests@wobblekins.com>';

const ALLOWED_ORIGINS = [
  'https://wobblekins.com',
  'https://www.wobblekins.com',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INTEREST_LABELS = {
  all_updates: 'All updates',
  next_drop: 'The next wave drop',
  mystery_packs: 'Mystery packs',
  custom_requests: 'Wobble Lab custom requests',
  early_access: 'Early access',
  wobbledex: 'Wobbledex discoveries',
};

// --- CORS -------------------------------------------------------------------

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://wobblekins.com');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// --- Handler ----------------------------------------------------------------

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  // Vercel parses JSON bodies automatically, but guard for string bodies.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const email = (body.email || '').toString().trim().toLowerCase();
  const name = (body.name || '').toString().trim() || null;
  const interest = (body.interest || '').toString().trim() || null;
  const source = (body.source || 'website').toString().trim() || 'website';

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Wobblelist: missing Supabase env vars.');
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    // Check if already on the list (for friendly messaging only).
    const { data: existing, error: selErr } = await supabase
      .from('wobblelist_subscribers')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (selErr) console.error('Wobblelist select error:', selErr);

    const alreadyJoined = !!existing;

    // Upsert by email. Rejoining clears unsubscribed and re-affirms consent.
    const row = {
      email,
      source,
      consent: true,
      unsubscribed: false,
    };
    if (name) row.name = name;
    if (interest) row.interest = interest;

    const { error: upsertErr } = await supabase
      .from('wobblelist_subscribers')
      .upsert(row, { onConflict: 'email' });

    if (upsertErr) {
      console.error('Wobblelist upsert error:', upsertErr);
      return res.status(500).json({ ok: false, error: 'Could not save your spot. Please try again.' });
    }

    // Send confirmation email. Do NOT fail the request if the email fails —
    // the subscriber is already saved.
    if (RESEND_API_KEY) {
      try {
        const resend = new Resend(RESEND_API_KEY);
        await resend.emails.send({
          from: FROM_EMAIL,
          to: email,
          subject: 'Wobblelist confirmed — your spark signal is live',
          html: buildConfirmationEmail({ name, interest }),
        });
      } catch (mailErr) {
        console.error('Wobblelist email error:', mailErr);
      }
    } else {
      console.error('Wobblelist: RESEND_API_KEY missing, skipped email.');
    }

    return res.status(200).json({
      ok: true,
      alreadyJoined,
      message: alreadyJoined
        ? "You're already on the Wobblelist. We'll send a spark signal before the next wave drops."
        : "You're on the Wobblelist. We'll send a spark signal before the next wave drops.",
    });
  } catch (err) {
    console.error('Wobblelist handler error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
}

// --- Confirmation email (inline styles, no JS, mobile-friendly) -------------

function buildConfirmationEmail({ name, interest }) {
  const greeting = name ? `Hey ${escapeHtml(name)},` : 'Hey Wobble friend,';
  const interestLabel =
    interest && INTEREST_LABELS[interest] ? INTEREST_LABELS[interest] : null;

  const rainbow = [
    '#ff3b6b', '#ff8a1f', '#ffd23f', '#42d60c',
    '#15d0c0', '#3b9dff', '#a85cff', '#ff5fd2',
  ];
  const rainbowBar = rainbow
    .map(c => `<td height="6" style="height:6px;line-height:6px;font-size:0;background-color:${c};">&nbsp;</td>`)
    .join('');

  const font = "'Outfit', Arial, Helvetica, sans-serif";

  const interestRow = interestLabel
    ? `<tr><td style="padding:14px 0 0;color:#b9b9c6;font-size:14px;line-height:22px;font-family:${font};">
         You told us you're most curious about
         <span style="color:#15d0c0;font-weight:700;">${escapeHtml(interestLabel)}</span> — noted.
       </td></tr>`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wobblelist confirmed</title>
</head>
<body style="margin:0;padding:0;background-color:#000000;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">You're on the Wobblelist — the Wobble Lab logged your spark signal.</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000;padding:24px 12px;">
<tr><td align="center">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#060608;border:1px solid rgba(255,255,255,0.12);border-radius:16px;overflow:hidden;">

    <!-- Rainbow top bar -->
    <tr><td style="padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${rainbowBar}</tr></table>
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:32px 28px 28px;">

      <p style="margin:0 0 6px;font-family:${font};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#a85cff;font-weight:700;">
        Wobblelist Confirmed
      </p>

      <h1 style="margin:0 0 16px;font-family:${font};font-size:26px;line-height:32px;color:#f4f4f8;font-weight:800;">
        You're on the Wobblelist
      </h1>

      <p style="margin:0 0 14px;font-family:${font};font-size:15px;line-height:24px;color:#d6d6e0;">
        ${greeting}
      </p>

      <p style="margin:0 0 18px;font-family:${font};font-size:15px;line-height:24px;color:#b9b9c6;">
        The Wobble Lab has logged your spark signal. You'll be among the first to hear
        before the next Wobblekin wave drops.
      </p>

      <!-- Raised card -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0d0d12;border:1px solid rgba(255,255,255,0.12);border-radius:12px;">
        <tr><td style="padding:18px 20px;">
          <p style="margin:0 0 12px;font-family:${font};font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#f4f4f8;font-weight:700;">
            What you'll get the signal for
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${font};font-size:14px;line-height:26px;color:#d6d6e0;">
            <tr><td style="color:#ff3b6b;width:18px;">&bull;</td><td>Limited adoptions</td></tr>
            <tr><td style="color:#ff8a1f;width:18px;">&bull;</td><td>Mystery packs</td></tr>
            <tr><td style="color:#15d0c0;width:18px;">&bull;</td><td>Wobble Lab openings</td></tr>
            <tr><td style="color:#3b9dff;width:18px;">&bull;</td><td>Wobbledex discoveries</td></tr>
          </table>
          ${interestRow}
        </td></tr>
      </table>

      <p style="margin:22px 0 0;font-family:${font};font-size:15px;line-height:24px;color:#b9b9c6;">
        Stay close to the signal.<br>
        <span style="color:#f4f4f8;font-weight:700;">— The Wobble Lab</span>
      </p>

    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:18px 28px 26px;border-top:1px solid rgba(255,255,255,0.12);">
      <p style="margin:0;font-family:${font};font-size:12px;line-height:20px;color:#6f6f80;">
        You're getting this because you joined the Wobblelist at wobblekins.com.
        Want out? Reply to this email and we'll pull your signal.
      </p>
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}