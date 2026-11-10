# RentCreeb API

Express 5 + TypeScript backend for the RentCreeb React Native app.
**Supabase** (Postgres + Auth + Realtime) holds text data only. **Bunny.net** holds all images/videos/documents.

| Concern | Choice |
|---|---|
| Auth | Supabase Auth (email/password, Google/Apple via `signInWithIdToken` in the app). Express verifies the Supabase JWT |
| NIN + selfie | Dojah |
| SMS OTP | Africa's Talking |
| Payments / escrow / payouts | Paystack (REST, no SDK) |
| Media | Bunny Storage — public zone + private token-protected zone for IDs/certificates |
| Chat | Messages written through the API; app subscribes to Supabase Realtime for live updates |
| Push | Expo push (`expo-server-sdk`) |
| Email | Resend (receipts); Supabase sends password-reset emails (point its SMTP at Resend) |
| Validation / logging / security | zod, pino, helmet, express-rate-limit |

## Setup

```bash
npm install
cp .env.example .env        # fill in values
# Supabase SQL editor (or `supabase db push`): run supabase/migrations/001_schema.sql
npm run dev
```

1. **Supabase**: create a project. Auth → Providers: enable Email, Google, Apple. Auth → URL config: add your app deep link (`rentcreeb://reset-password`) to redirect URLs. Auth → SMTP: connect Resend.
2. **Make an admin**: sign up normally, then `update profiles set role='admin' where email='you@…';`
3. **Paystack**: set webhook URL to `https://<your-api>/webhooks/paystack` (events: `charge.success`, `transfer.success`, `transfer.failed`, `transfer.reversed`).
4. **Bunny**: create two storage zones + pull zones. On the private pull zone enable *Token Authentication* and copy its key to `BUNNY_PRIVATE_TOKEN_KEY`.
5. **Dojah**: use sandbox keys first. Check the response mapping in `src/lib/dojah.ts` against your plan.

## How the flows map to endpoints (`/api/v1`)

**Auth & onboarding** — `POST /auth/register` → `POST /auth/phone/verify-otp` → `POST /verification/nin` (multipart: `nin`, `consent`, `selfie`). Also `/auth/login` (email or phone), `/refresh`, `/logout`, `/forgot-password`, `/reset-password` (send the recovery token as Bearer). Social sign-in: sign in with supabase-js in the app, then `PATCH /users/me {role, onboardingCompleted:true}`.

**Access levels**: `unverified` (browse) → `partially_verified` (phone OTP) → `verified` (NIN + selfie). Book / pay / review / list require `verified` (error code `VERIFICATION_REQUIRED`). 3 failed NIN attempts → `VERIFICATION_LOCKED`; `POST /verification/manual-request` then admin `POST /admin/users/:id/verify`.

**Tenant** — `GET /properties` (q, area, type, minPrice, maxPrice, beds, baths, sort) · `GET /properties/:id` (+agent, review summary, similar) · `/properties/:id/nearby` · save/unsave · `POST /bookings` → Paystack → webhook → OTP SMS to tenant+host → `POST /bookings/:id/confirm` (chat unlocks, inspection code SMS’d) → host `POST /bookings/:id/validate-inspection` (escrow released to host wallet) · `POST /bookings/:id/cancel` (refund minus charge inside the cutoff window) · `POST /reviews` · `POST /reports` · `GET /dashboard/tenant` · `/rentsave` · `/maintenance` (+ `GET /maintenance/:id` repair tracking) · `/payments` history, `/payments/:id/receipt.pdf`.

**Agent** — `GET /subscriptions/plans`, `POST /subscriptions/checkout` · `POST /properties` (pending admin approval; rejected → `PATCH` resubmits) · `GET /dashboard/agent`, `/dashboard/agent/analytics` · `/reviews/received`, `/reviews/:id/reply` · `/conversations`.

**Landlord / estate manager** — `POST /properties {publish:false}` for private managed units · `POST /tenancies` · `GET /dashboard/landlord`, `/dashboard/landlord/reports` · `POST /maintenance/:id/post-job` · `/jobs/:id/quotes` → `POST /jobs/quotes/:quoteId/accept` (Paystack escrow) · approve diagnosis `POST /jobs/:id/report/approve|reject`.

**Artisan** — `PUT /artisan/profile` → `POST /uploads?folder=artisan-docs` + `POST /artisan/documents` → `POST /verification/nin` → `POST /artisan/submit` (admin approves within 48h) · `GET /jobs/alerts` · `POST /jobs/:id/quotes` · `/start` → `/report` → `/begin-repair` → `/complete` · tenant/landlord `POST /jobs/:id/confirm-completion` releases escrow (5% fee) · `GET /dashboard/artisan` · `/wallet` (bank account + withdraw).

**Shared** — `/notifications`, `/users/me`, `/uploads`, `/wallet`, `/admin/*`.

Error shape: `{ "error": { "code", "message", "details?" } }`. Money is always **kobo** (integers).

## Decisions I made that you should confirm

- **Two-stage booking OTP.** The flow doc says OTP is sent to tenant + agent after payment and the tenant enters it (→ confirmed); it also lists "OTP validation for inspection" for agents. I implemented both: a *confirm* code (tenant enters it) and a separate *inspection* code (tenant reads it to the agent at the property; this triggers escrow release).
- **Agents pay a subscription; landlords/estate managers list free.**
- **Chat unlocks after booking confirmation** (per the v2 flow), even though the mockup shows "Message Agent" on the listing page. Change by creating the conversation earlier in `bookings.routes.ts`.
- **Escrow.** Inspection fee: 10% platform fee, rest to host wallet on validation. Job payment: held until tenant/landlord confirms, then 5% fee. Funds sit in your Paystack balance; wallets are a ledger. Rent goes straight to the landlord wallet. Plan prices in the migration are placeholders.
- **NIN is never stored** — only a salted hash + last 3 digits. Selfies are forwarded to Dojah and discarded.
- Nearby places are entered per property (`POST /properties/:id/nearby`). Swap in Google Places later if you want auto-fill.

## Not built / next steps

- Revised final amount on job completion (the "changes require landlord approval" screen) — only same-as-quote completion is handled.
- RentSave payout to landlord (contributions accumulate; no disbursement endpoint yet).
- Video transcoding: videos go to Bunny Storage as-is. For adaptive streaming, move video to Bunny Stream.
- Generate typed DB types: `npx supabase gen types typescript` and pass to `createClient<Database>`.
- Scale: JWT is verified with `auth.getUser` (one round-trip per request). Switch to local JWKS verification (`jose`) when traffic grows. Cron jobs run in-process — run on one instance only.
- No tests yet. I couldn't run `npm install` in my environment, so the project is not compiled; run `npm run typecheck` first and expect to fix small typing issues.
