-- RentCreeb schema. Text data only: media lives on Bunny.net, we store URLs/paths.
-- All money is stored in KOBO (bigint). The Express API uses the service-role key.
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ───────────────────────── Users ─────────────────────────
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'tenant'
    check (role in ('tenant','landlord','estate_manager','artisan','agent','admin')),
  first_name text, last_name text,
  email text,
  phone text unique,
  avatar_url text, bio text,
  phone_verified boolean not null default false,
  nin_verified boolean not null default false,
  verification_status text generated always as (
    case when nin_verified then 'verified'
         when phone_verified then 'partially_verified'
         else 'unverified' end) stored,
  onboarding_completed boolean not null default false,
  expo_push_token text,
  rating_avg numeric(3,2) not null default 0,
  rating_count int not null default 0,
  is_suspended boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table wallets (
  user_id uuid primary key references profiles(id) on delete cascade,
  available_kobo bigint not null default 0 check (available_kobo >= 0),
  updated_at timestamptz not null default now()
);

create table wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  direction text not null check (direction in ('credit','debit')),
  amount_kobo bigint not null check (amount_kobo > 0),
  kind text not null, -- escrow_release | rent | withdrawal | withdrawal_reversal
  description text,
  reference text unique,
  created_at timestamptz not null default now()
);
create index on wallet_transactions(user_id, created_at desc);

create table bank_accounts (
  user_id uuid primary key references profiles(id) on delete cascade,
  bank_code text not null, bank_name text, account_number text not null,
  account_name text not null, paystack_recipient_code text not null,
  created_at timestamptz not null default now()
);

create table withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  amount_kobo bigint not null, reference text unique not null,
  status text not null default 'pending' check (status in ('pending','success','failed','reversed')),
  created_at timestamptz not null default now()
);

create table verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  nin_hash text not null, nin_last3 text not null,
  status text not null check (status in ('success','failed','manual_review')),
  confidence numeric, failure_reason text, metadata jsonb default '{}',
  created_at timestamptz not null default now()
);
create index on verifications(user_id, created_at desc);
-- one NIN can only be attached to one verified account
create unique index one_nin_one_account on verifications(nin_hash) where status = 'success';

-- ───────────────────────── Artisans ─────────────────────────
create table artisan_profiles (
  user_id uuid primary key references profiles(id) on delete cascade,
  skill_category text, additional_skills text[] default '{}',
  service_areas text[] default '{}', years_experience int default 0,
  state text, lga text, home_address text, bio text,
  available boolean not null default true, availability_hours text,
  review_status text not null default 'draft' check (review_status in ('draft','pending','approved','rejected')),
  review_note text, terms_accepted_at timestamptz,
  submitted_at timestamptz, approved_at timestamptz,
  created_at timestamptz not null default now()
);
create table artisan_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  doc_type text not null check (doc_type in ('gov_id','trade_certificate','other')),
  storage_path text not null, original_name text,
  created_at timestamptz not null default now()
);
create table artisan_portfolio (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  url text not null, caption text, created_at timestamptz not null default now()
);
create table artisan_references (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null, phone text not null
);

-- ───────────────────────── Subscriptions (agents) ─────────────────────────
create table subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null, price_kobo bigint not null, interval_days int not null default 30,
  listing_limit int, -- null = unlimited
  active boolean not null default true
);
insert into subscription_plans(name, price_kobo, interval_days, listing_limit) values
  ('Starter', 1500000, 30, 5), ('Pro', 3500000, 30, 25), ('Elite', 7500000, 30, null);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references profiles(id),
  plan_id uuid not null references subscription_plans(id),
  status text not null default 'pending' check (status in ('pending','active','expired','cancelled')),
  starts_at timestamptz, expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index on subscriptions(agent_id, status);

-- ───────────────────────── Properties ─────────────────────────
create table properties (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id),
  title text not null, description text,
  address text not null, area text, city text default 'Lagos', state text default 'Lagos',
  lat double precision, lng double precision,
  price_kobo bigint not null check (price_kobo >= 0),
  price_period text not null default 'year' check (price_period in ('year','month')),
  property_type text not null default 'apartment',
  bedrooms int default 0, bathrooms int default 0, size_sqm numeric,
  parking boolean default false, amenities text[] default '{}',
  inspection_fee_kobo bigint,
  status text not null default 'pending'
    check (status in ('unlisted','pending','approved','rejected','rented','archived')),
  rejection_reason text, is_verified boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on properties(status, area);
create index on properties(price_kobo);
create index on properties using gin ((title || ' ' || address) gin_trgm_ops);

create table property_media (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  url text not null, media_type text not null default 'image' check (media_type in ('image','video')),
  position int not null default 0
);
create table nearby_places (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  category text not null check (category in ('education','healthcare','transport','markets','religious','security','utilities')),
  name text not null, distance_km numeric(5,2), rating numeric(2,1)
);
create table saved_properties (
  user_id uuid references profiles(id) on delete cascade,
  property_id uuid references properties(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, property_id)
);

-- ───────────────────────── Bookings / payments / escrow ─────────────────────────
create table bookings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  tenant_id uuid not null references profiles(id),
  host_id uuid not null references profiles(id), -- agent/landlord who owns the listing
  scheduled_at timestamptz not null,
  status text not null default 'pending_payment' check (status in
    ('pending_payment','paid','confirmed','completed','cancelled','refunded','expired','declined')),
  amount_kobo bigint not null, fee_kobo bigint not null default 0, refund_kobo bigint not null default 0,
  cancelled_reason text, confirmed_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index one_active_booking on bookings(tenant_id, property_id)
  where status in ('pending_payment','paid','confirmed');
create index on bookings(host_id, status);
create index on bookings(tenant_id, status);

create table payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  purpose text not null check (purpose in ('inspection','subscription','rent','rentsave','job_escrow')),
  reference text unique not null,
  amount_kobo bigint not null,
  status text not null default 'pending' check (status in ('pending','success','failed','refunded')),
  channel text, access_code text,
  booking_id uuid references bookings(id), subscription_id uuid references subscriptions(id),
  job_id uuid, quote_id uuid, tenancy_id uuid, rent_payment_id uuid, rentsave_plan_id uuid,
  paid_at timestamptz, created_at timestamptz not null default now()
);
create index on payments(user_id, created_at desc);

create table escrows (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('inspection','job')),
  payment_id uuid not null references payments(id),
  booking_id uuid references bookings(id), job_id uuid,
  payer_id uuid not null references profiles(id), payee_id uuid not null references profiles(id),
  amount_kobo bigint not null, fee_kobo bigint not null default 0,
  status text not null default 'held' check (status in ('held','released','refunded')),
  created_at timestamptz not null default now(), released_at timestamptz
);

create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('phone_verify','booking_confirm','booking_inspection')),
  user_id uuid references profiles(id) on delete cascade,
  booking_id uuid references bookings(id) on delete cascade,
  phone text, code_hash text not null, attempts int not null default 0,
  expires_at timestamptz not null, consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on otp_codes(purpose, user_id, booking_id, created_at desc);

-- ───────────────────────── Chat ─────────────────────────
create table conversations (
  id uuid primary key default gen_random_uuid(),
  context_type text not null check (context_type in ('booking','job')),
  context_id uuid not null,
  participant_a uuid not null references profiles(id),
  participant_b uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  unique (context_type, context_id)
);
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null references profiles(id),
  body text, attachment_url text,
  read_at timestamptz, created_at timestamptz not null default now()
);
create index on messages(conversation_id, created_at desc);

-- ───────────────────────── Reviews / reports ─────────────────────────
create table reviews (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  booking_id uuid unique references bookings(id),
  agent_id uuid not null references profiles(id),
  reviewer_id uuid not null references profiles(id),
  rating int not null check (rating between 1 and 5), comment text,
  helpful_count int not null default 0, flag_count int not null default 0,
  hidden boolean not null default false,
  reply text, replied_at timestamptz,
  created_at timestamptz not null default now()
);
create index on reviews(property_id, created_at desc);
create index on reviews(agent_id);
create table review_helpful (review_id uuid references reviews(id) on delete cascade, user_id uuid references profiles(id) on delete cascade, primary key(review_id, user_id));
create table review_flags (review_id uuid references reviews(id) on delete cascade, user_id uuid references profiles(id) on delete cascade, reason text, primary key(review_id, user_id));

create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id),
  agent_id uuid not null references profiles(id),
  booking_id uuid references bookings(id),
  reason text not null, details text,
  status text not null default 'open' check (status in ('open','investigating','resolved','dismissed')),
  admin_note text, created_at timestamptz not null default now()
);

-- ───────────────────────── Tenancy / RentSave / Maintenance ─────────────────────────
create table tenancies (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  landlord_id uuid not null references profiles(id),
  tenant_id uuid not null references profiles(id),
  unit_label text, lease_start date not null, lease_end date,
  rent_kobo bigint not null,
  frequency text not null default 'yearly' check (frequency in ('monthly','quarterly','yearly')),
  next_due_date date,
  status text not null default 'active' check (status in ('active','ended')),
  created_at timestamptz not null default now()
);
create table rent_payments (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  amount_kobo bigint not null, due_date date not null,
  status text not null default 'due' check (status in ('due','paid','overdue')),
  payment_id uuid references payments(id), paid_at timestamptz,
  created_at timestamptz not null default now()
);
create table rentsave_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references profiles(id) on delete cascade,
  tenancy_id uuid references tenancies(id),
  name text not null default 'Rent Savings',
  target_kobo bigint not null, contribution_kobo bigint not null,
  frequency text not null check (frequency in ('daily','weekly','monthly')),
  target_date date, saved_kobo bigint not null default 0,
  status text not null default 'active' check (status in ('active','paused','completed')),
  created_at timestamptz not null default now()
);

create table maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid references tenancies(id),
  property_id uuid not null references properties(id),
  tenant_id uuid not null references profiles(id),
  landlord_id uuid not null references profiles(id),
  category text not null, description text not null,
  urgency text not null default 'standard' check (urgency in ('standard','urgent')),
  status text not null default 'open' check (status in ('open','job_posted','in_progress','completed','rejected','cancelled')),
  rejection_reason text, created_at timestamptz not null default now()
);
create table maintenance_media (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references maintenance_requests(id) on delete cascade,
  url text not null
);

-- ───────────────────────── Artisan jobs ─────────────────────────
create table jobs (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id),
  landlord_id uuid not null references profiles(id),
  tenant_id uuid references profiles(id),
  maintenance_request_id uuid references maintenance_requests(id),
  title text not null, category text not null, description text not null,
  urgency text not null default 'standard' check (urgency in ('standard','urgent')),
  budget_min_kobo bigint not null, budget_max_kobo bigint not null,
  access_notes text,
  status text not null default 'open' check (status in
    ('open','assigned','diagnosing','awaiting_approval','approved','in_progress','awaiting_confirmation','completed','cancelled')),
  artisan_id uuid references profiles(id), accepted_quote_id uuid,
  started_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on jobs(status, category);
create table job_media (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  kind text not null check (kind in ('issue','before','after')), url text not null
);
create table job_quotes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  artisan_id uuid not null references profiles(id),
  amount_kobo bigint not null, breakdown jsonb default '[]', eta text, notes text,
  status text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn')),
  created_at timestamptz not null default now(),
  unique (job_id, artisan_id)
);
create table job_declines (job_id uuid references jobs(id) on delete cascade, artisan_id uuid references profiles(id) on delete cascade, primary key(job_id, artisan_id));
create table job_reports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  artisan_id uuid not null references profiles(id),
  diagnosis text not null, materials jsonb not null default '[]',
  labor_kobo bigint not null default 0, total_kobo bigint not null,
  est_completion timestamptz, exceeds_quote boolean not null default false,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_note text, created_at timestamptz not null default now()
);
create table job_reviews (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  reviewer_id uuid not null references profiles(id),
  reviewee_id uuid not null references profiles(id),
  rating int not null check (rating between 1 and 5), comment text,
  reply text, replied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (job_id, reviewer_id)
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  type text not null, title text not null, body text,
  data jsonb not null default '{}', read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on notifications(user_id, created_at desc);

-- ───────────────────────── Functions ─────────────────────────
-- New auth user -> profile + wallet. Only whitelisted roles can be self-assigned.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := new.raw_user_meta_data->>'role';
begin
  insert into profiles(id, email, first_name, last_name, phone, role)
  values (new.id, new.email, new.raw_user_meta_data->>'first_name', new.raw_user_meta_data->>'last_name',
          nullif(new.raw_user_meta_data->>'phone',''),
          case when r in ('tenant','landlord','estate_manager','artisan','agent') then r else 'tenant' end);
  insert into wallets(user_id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Idempotent wallet credit (reference must be unique). Returns false if already applied.
create or replace function wallet_credit(p_user uuid, p_amount bigint, p_kind text, p_desc text, p_ref text)
returns boolean language plpgsql as $$
declare n int;
begin
  insert into wallet_transactions(user_id, direction, amount_kobo, kind, description, reference)
  values (p_user, 'credit', p_amount, p_kind, p_desc, p_ref) on conflict (reference) do nothing;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  update wallets set available_kobo = available_kobo + p_amount, updated_at = now() where user_id = p_user;
  return true;
end $$;

create or replace function wallet_debit(p_user uuid, p_amount bigint, p_kind text, p_desc text, p_ref text)
returns void language plpgsql as $$
begin
  update wallets set available_kobo = available_kobo - p_amount, updated_at = now()
   where user_id = p_user and available_kobo >= p_amount;
  if not found then raise exception 'INSUFFICIENT_FUNDS'; end if;
  insert into wallet_transactions(user_id, direction, amount_kobo, kind, description, reference)
  values (p_user, 'debit', p_amount, p_kind, p_desc, p_ref);
end $$;

create or replace function rentsave_add(p_plan uuid, p_amount bigint) returns void language sql as $$
  update rentsave_plans set saved_kobo = saved_kobo + p_amount,
    status = case when saved_kobo + p_amount >= target_kobo then 'completed' else status end
  where id = p_plan;
$$;

create or replace function refresh_rating(p_user uuid) returns void language sql as $$
  update profiles p set rating_avg = coalesce(s.a, 0), rating_count = coalesce(s.c, 0)
  from (select round(avg(rating)::numeric, 2) a, count(*) c from (
          select rating from reviews where agent_id = p_user and not hidden
          union all select rating from job_reviews where reviewee_id = p_user) x) s
  where p.id = p_user;
$$;
create or replace function trg_reviews_rating() returns trigger language plpgsql as $$
begin perform refresh_rating(coalesce(new.agent_id, old.agent_id)); return null; end $$;
create trigger reviews_rating after insert or update or delete on reviews
  for each row execute function trg_reviews_rating();
create or replace function trg_job_reviews_rating() returns trigger language plpgsql as $$
begin perform refresh_rating(coalesce(new.reviewee_id, old.reviewee_id)); return null; end $$;
create trigger job_reviews_rating after insert or update or delete on job_reviews
  for each row execute function trg_job_reviews_rating();

-- ───────────────────────── RLS ─────────────────────────
-- The API uses the service-role key (bypasses RLS). Everything else is denied by default.
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- Exceptions so the mobile app can subscribe to Supabase Realtime directly (read-only).
create policy "participants read messages" on messages for select using (
  exists (select 1 from conversations c where c.id = conversation_id
          and auth.uid() in (c.participant_a, c.participant_b)));
create policy "own notifications" on notifications for select using (user_id = auth.uid());
alter publication supabase_realtime add table messages, notifications;

-- FKs added after the fact (tables defined later than escrows/payments) so PostgREST can embed them.
alter table escrows add constraint escrows_job_id_fkey foreign key (job_id) references jobs(id);
alter table payments add constraint payments_job_id_fkey foreign key (job_id) references jobs(id);
alter table payments add constraint payments_quote_id_fkey foreign key (quote_id) references job_quotes(id);
alter table payments add constraint payments_tenancy_id_fkey foreign key (tenancy_id) references tenancies(id);
alter table payments add constraint payments_rent_payment_id_fkey foreign key (rent_payment_id) references rent_payments(id);
alter table payments add constraint payments_rentsave_plan_id_fkey foreign key (rentsave_plan_id) references rentsave_plans(id);
