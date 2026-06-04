-- =====================================================================
--  WOBBLELAB — Supabase schema (Phase 1)
--  Run this in:  Supabase Dashboard → SQL Editor → New query → Run
--  Safe to re-run (idempotent).
-- =====================================================================

-- gen_random_uuid() lives in pgcrypto (already available on Supabase,
-- but enable it explicitly so this file is portable).
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Sequence that powers the human-readable request number (WOB-000001).
-- Using a sequence makes numbering atomic and race-condition free.
-- ---------------------------------------------------------------------
create sequence if not exists wobblekin_request_seq start 1;

-- ---------------------------------------------------------------------
-- Main table
-- ---------------------------------------------------------------------
create table if not exists public.wobblekin_requests (
  id                        uuid primary key default gen_random_uuid(),

  -- Auto-generated, unique, human-readable id e.g. WOB-000042.
  -- The default pads the sequence value to 6 digits.
  request_number            text unique not null
                              default ('WOB-' || lpad(nextval('wobblekin_request_seq')::text, 6, '0')),

  -- Customer contact fields
  name                      text not null,
  email                     text not null,
  phone                     text,

  -- Design / request fields
  preferred_wobblekin_name  text,
  intended_use              text,
  selected_traits           jsonb default '{}'::jsonb,   -- structured trait selections
  full_request              text,                        -- the widget's formatted summary
  message                   text,                        -- customer notes

  -- Reference images (array of public or signed URLs)
  image_urls                jsonb default '[]'::jsonb,

  -- Workflow status
  status                    text not null default 'New',

  created_at                timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Constrain status to the supported workflow values.
-- (Wrapped in a DO block so re-running doesn't error on "already exists".)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wobblekin_status_check'
  ) then
    alter table public.wobblekin_requests
      add constraint wobblekin_status_check
      check (status in (
        'New','Reviewing','Need More Info','Approved',
        'Modeling','Printing','Completed','Archived'
      ));
  end if;
end$$;

-- ---------------------------------------------------------------------
-- Helpful indexes for the future admin panel
-- ---------------------------------------------------------------------
create index if not exists wobblekin_requests_created_idx
  on public.wobblekin_requests (created_at desc);
create index if not exists wobblekin_requests_status_idx
  on public.wobblekin_requests (status);

-- ---------------------------------------------------------------------
-- Row Level Security
--  Enable RLS and add NO policies. This blocks the public/anon key from
--  reading or writing the table directly. Your Vercel API uses the
--  SERVICE ROLE key, which BYPASSES RLS — so only your server can touch
--  this data. This is the key to keeping submissions secure.
-- ---------------------------------------------------------------------
alter table public.wobblekin_requests enable row level security;

-- =====================================================================
--  STORAGE BUCKET (Phase 1, continued)
--  You can create the bucket here, OR in the Dashboard (see README).
--  public = true  -> image URLs work in your email/admin without signing.
--  Switch to false later for private + signed URLs (see README §Security).
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('wobblekin-references', 'wobblekin-references', true)
on conflict (id) do nothing;

-- Allow public READ of objects in this bucket (because public = true).
-- Uploads happen via the service role from your API, which bypasses these
-- policies, so we do NOT add any public INSERT policy.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'wobblekin_public_read'
  ) then
    create policy "wobblekin_public_read"
      on storage.objects for select
      to public
      using ( bucket_id = 'wobblekin-references' );
  end if;
end$$;
