# Wobblelab Backend (MVP)

The backend foundation for Wobblekin custom requests. Your existing custom
HTML/CSS/JS widget stays the form experience; this adds the plumbing behind
the **Send Wobblekin Request** button:

> customer submits → Vercel API validates → images go to Supabase Storage →
> request saved in Supabase (auto id `WOB-000001`) → summary emailed to you via
> Resend → widget shows a styled success message.

Stack: **Hostinger** (frontend) · **Vercel** (serverless API) · **Supabase**
(Postgres + Storage) · **Resend** (email).

```
wobblelab-backend/
├── api/
│   ├── submit-request.js      # main endpoint (POST) — the whole flow
│   └── requests.js            # optional, token-protected list of requests
├── frontend/
│   └── wobblelab-integration.js  # paste into Hostinger after the widget
├── sql/
│   └── schema.sql             # run once in Supabase SQL editor
├── .env.example               # every env var, documented
├── .gitignore
├── package.json
└── vercel.json
```

---

## Phase 1 — Supabase setup

1. Create a project at <https://supabase.com> (free tier is fine). Pick a region
   close to you and save the database password.
2. Left sidebar → **SQL Editor** → **New query**. Paste the entire contents of
   [`sql/schema.sql`](sql/schema.sql) and click **Run**. This creates:
   - the `wobblekin_requests` table (with your fields),
   - a sequence + default so `request_number` auto-fills as `WOB-000001`,
   - a `status` check constraint for the 8 workflow states,
   - indexes on `created_at` and `status`,
   - **RLS enabled with no policies** (locks out the public/anon key),
   - the **`wobblekin-references` Storage bucket** (public) + a public-read policy.
3. Confirm the bucket: left sidebar → **Storage**. You should see
   `wobblekin-references`. (If you prefer the UI: **New bucket** → name it
   `wobblekin-references` → toggle **Public** on → Create. The SQL already does
   this, so you can skip it.)
4. Grab your keys: **Project Settings → API** (or **Data API**):
   - **Project URL** → `SUPABASE_URL`
   - **service_role** secret → `SUPABASE_SERVICE_ROLE_KEY` (server-only!)

**Statuses supported:** `New`, `Reviewing`, `Need More Info`, `Approved`,
`Modeling`, `Printing`, `Completed`, `Archived` (enforced by the DB).

---

## Phase 2 — Environment variables

Set these in **Vercel → your project → Settings → Environment Variables**
(and copy `.env.example` → `.env` for local testing). All are **server-side**;
none are ever sent to the browser.

| Variable | Where it comes from |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` secret (NOT `anon`) |
| `SUPABASE_STORAGE_BUCKET` | The bucket name: `wobblekin-references` |
| `RESEND_API_KEY` | resend.com → API Keys → Create API Key |
| `WOBBLEKINS_RECEIVER_EMAIL` | Your inbox (where request emails arrive) |
| `WOBBLEKINS_FROM_EMAIL` | A from-address on a Resend-verified domain, e.g. `Wobblelab <requests@yourdomain.com>` (use `onboarding@resend.dev` for first tests) |
| `ALLOWED_ORIGIN` | Your Hostinger site origin, e.g. `https://yourdomain.com` (`*` while testing) |
| `ADMIN_TOKEN` | *(optional)* long random string to protect `/api/requests` |

**Resend domain:** to send from your own domain, add it in resend.com →
**Domains**, then create the DNS records Resend shows you inside Hostinger
(**Hostinger → Domains → DNS / Nameservers**). Until then, use
`onboarding@resend.dev` as `WOBBLEKINS_FROM_EMAIL` — note it only delivers to the
email on your Resend account.

---

## Phase 3 — The API

[`api/submit-request.js`](api/submit-request.js) is a Node serverless function
(not Edge). It: guards method + CORS, parses `multipart/form-data` with
`formidable`, validates `name`/`email`, uploads images to Storage, inserts the
row (DB generates the request number), emails you via Resend, and returns:

```json
{ "ok": true, "request_number": "WOB-000001", "image_urls": ["https://…"] }
```

Errors return `{ "ok": false, "error": "friendly message" }` with a 4xx/5xx code.
Email failures are logged but do **not** fail the customer (the request is
already saved).

Endpoint URL after deploy: `https://YOUR-PROJECT.vercel.app/api/submit-request`.

Optional [`api/requests.js`](api/requests.js) returns the latest requests as
JSON, protected by `Authorization: Bearer <ADMIN_TOKEN>` — a minimal stand-in
until the real admin panel.

---

## Phase 4 — Frontend integration

1. Open [`frontend/wobblelab-integration.js`](frontend/wobblelab-integration.js).
2. Set `CONFIG.endpoint` to your deployed URL.
3. In Hostinger, paste it inside a `<script>` tag in the **same** custom
   HTML/embed block, **right after** the widget markup:

   ```html
   <!-- (your #wobblekins-request-builder widget markup above) -->
   <script>
     /* paste the entire contents of wobblelab-integration.js here */
   </script>
   ```

It intercepts the widget's **Submit Request** button, gathers all fields +
the live trait selections + the uploaded images, POSTs with `fetch()` (no
redirect), shows the loading/success/error text in the widget's status area,
and displays:

> Your Wobblekin request has entered the Wobble Lab! Request ID: WOB-000001

The widget was updated so uploaded images are kept as real files and mirrored
into the file input, so they upload correctly. If your markup uses different
ids, edit the `CONFIG` selectors at the top of the file.

---

## Phase 5 — Security & launch notes

- **Never expose the service role key on the frontend.** It bypasses RLS and can
  read/write everything. It lives only in Vercel env vars and is used only in the
  API. The browser never sees it.
- **Why the frontend calls *your* Vercel API, not Supabase directly:** direct
  client access would require shipping a Supabase key to the browser and writing
  RLS insert policies for the anon role — which makes the table publicly
  writable and easy to spam/abuse. Routing through your API means you control
  validation, file checks, rate of writes, and the email step in one trusted
  place. RLS is left policy-less on purpose: only the service role (server) can
  touch the data.
- **CORS (Hostinger → Vercel):** the API sets `Access-Control-Allow-Origin`
  from `ALLOWED_ORIGIN` and answers `OPTIONS` preflights. Set it to your exact
  Hostinger origin for production; `*` is fine only while testing. A normal
  `FormData` POST is a CORS-"simple" request, so usually no preflight even fires.
- **File limits & types:** images are validated **twice** (browser + server).
  Allowed: `jpg`, `jpeg`, `png`, `webp`. Limits in `submit-request.js`:
  `MAX_FILE_BYTES = 5 MB` each, `MAX_FILES = 6`. Adjust those constants as needed.
- **Public vs private images:** the bucket is **public** for MVP simplicity, so
  image URLs work directly in your email. To make images private: set the bucket
  to non-public, drop the public-read policy, and generate signed URLs on demand
  with `supabase.storage.from(bucket).createSignedUrl(path, 3600)` (store the
  storage *path* instead of the public URL).

---

## Phase 6 — Future expansion

This MVP is deliberately the foundation for:

- **Private admin panel** — replace `api/requests.js` with a small protected app
  (e.g. a separate Vercel/Next.js route behind Supabase Auth) to browse, filter,
  and update `status`. The table + indexes are already built for it.
- **Request status tracking** — the `status` column + 8-state constraint are
  ready; add an `UPDATE` endpoint and a customer-facing "check my request" lookup
  by `request_number`.
- **Customer confirmation emails** — send a second Resend email to the customer
  on submit (and on each status change), reusing the same summary template.
- **Adoption certificates** — generate a PDF from the saved request + traits when
  status hits `Completed`, store it in another bucket, link it in an email.
- **Wobbledex profiles** — give each completed Wobblekin a public page keyed by
  `request_number`/a slug, rendering its traits and final renders.
- **Payments / orders** — add Stripe Checkout before or after approval; store the
  order/payment id alongside the request and gate `Modeling`/`Printing` on paid.

---

## Install commands

```bash
# in the project folder
npm install
# (installs @supabase/supabase-js, formidable, resend)

# optional: run locally with the Vercel CLI
npm i -g vercel
vercel dev        # serves http://localhost:3000/api/submit-request
```

---

## Deployment steps (GitHub → Vercel)

1. **Push to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Wobblelab backend MVP"
   git branch -M main
   git remote add origin https://github.com/YOU/wobblelab-backend.git
   git push -u origin main
   ```
2. **Import to Vercel:** vercel.com → **Add New… → Project** → import the repo.
   Framework preset: **Other** (no build step needed). Click **Deploy**.
3. **Add env vars:** Project → **Settings → Environment Variables** → add every
   key from Phase 2 (Production + Preview). **Redeploy** so they take effect.
4. **Get your URL:** e.g. `https://wobblelab-backend.vercel.app`. Your endpoint is
   `…/api/submit-request`.
5. **Wire the widget:** set `CONFIG.endpoint` in the integration script and paste
   it into Hostinger after the widget. Set `ALLOWED_ORIGIN` to your Hostinger
   domain and redeploy.

---

## Testing checklist

- [ ] **SQL ran clean** — `wobblekin_requests` table + `wobblekin-references`
      bucket both exist in Supabase.
- [ ] **Env vars set** in Vercel (all of Phase 2) and a redeploy was done after.
- [ ] **Endpoint reachable** — open `…/api/submit-request` in a browser; you
      should get `405 Method not allowed` (that means it's live; it only accepts POST).
- [ ] **Happy path** — submit the widget with name + email only → success message
      with a `WOB-…` id, a new row in Supabase, and an email in your inbox.
- [ ] **Request numbers increment** — submit twice → `WOB-000001`, `WOB-000002`.
- [ ] **Images** — attach 1–3 jpg/png/webp → thumbnails show, files appear in the
      Storage bucket, and `image_urls` is populated in the row + email links work.
- [ ] **Validation** — submit with a blank/invalid email → friendly 400 error,
      nothing saved.
- [ ] **File guards** — try a >5 MB image or a 7th image → clear error, no crash.
- [ ] **No redirect** — the page never reloads/navigates on submit.
- [ ] **CORS** — works from your real Hostinger page (not just local). If blocked,
      check `ALLOWED_ORIGIN` matches your site origin exactly.
- [ ] **(Optional) admin view** —
      `curl -H "Authorization: Bearer <ADMIN_TOKEN>" …/api/requests` returns JSON;
      a wrong/missing token returns `401`.

---

### Quick curl smoke test

```bash
curl -X POST https://YOUR-PROJECT.vercel.app/api/submit-request \
  -F "name=Test Customer" \
  -F "email=test@example.com" \
  -F "intended_use=Personal collectible" \
  -F 'selected_traits={"creatureBase":"Fox-kin","accessory":["Bow"]}' \
  -F "full_request=Fox-kin with a bow" \
  -F "reference_images=@/path/to/photo.jpg"
# → {"ok":true,"request_number":"WOB-000001","image_urls":[...]}
```
