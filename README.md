# token-system
for generating auto token

# ClinicQ

Token and queue system for clinics. Two separate sites share one Supabase database:

- `web/patient/` book a token, live status, cancel, WhatsApp click-to-chat
- `web/doctor/` login, queue dashboard (Next, Skip, walk-ins), session timing, medicine lists
- `supabase/migrations/` database schema, row-level security, queue functions
- `supabase/functions/` Edge Functions: `book`, `patient-api`, `notify`, `wa-webhook`

Status: written but not yet run against a live project. Test on a fresh Supabase project first.

## 1. Supabase
1. Create a new Supabase project (keep it separate from your other apps).
2. `supabase link --project-ref <ref>` then `supabase db push` (runs both migrations).
3. Authentication > Users > Add user: `drsharma@staff.clinicq.local` (the username plus `@staff.clinicq.local`), set a password, tick Auto Confirm.
4. Run `supabase/first_clinic.sql` in the SQL editor. It prints `clinic_id`.
5. Put the project URL, publishable key and `clinic_id` in `web/config.js`.

## 2. Edge Functions
```
supabase secrets set ALLOWED_ORIGIN=https://<your-github-username>.github.io \
  WA_ACCESS_TOKEN=... WA_APP_SECRET=... WA_VERIFY_TOKEN=<long random string> \
  SITE_URL=https://<your-github-username>.github.io/<repo>
supabase functions deploy
```
- Leave `TURNSTILE_SECRET` unset until the patient page sends a Turnstile token (not built yet). Until then the booking endpoint relies on the per-phone limit only, so add captcha and rate limiting before a public launch.
- WhatsApp: in Meta's console set the callback URL to `https://<ref>.supabase.co/functions/v1/wa-webhook`, subscribe to `messages`, then save the clinic's `whatsapp_number` and `wa_phone_number_id` on the clinic row (or from the doctor site for the number).
- Check Meta's docs for the current Graph API version (`WA_API_VERSION`, default `v21.0`).

## 3. GitHub
```
git init && git add . && git commit -m "ClinicQ"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
Then Settings > Pages > Source: GitHub Actions. The patient site is at `/patient/`, the doctor site at `/doctor/`.

## Never commit
Service-role key, WhatsApp tokens, `.env` files. Only the URL and publishable key in `web/config.js` are public by design.

## Known gaps
- Patient cancellations do not trigger "N left" alerts until the next doctor action.
- Alerts outside WhatsApp's free reply window need approved template messages (not built).
- No "your turn" WhatsApp message and no day-of reminder yet.
- Doctor accounts are created by the admin in the Supabase dashboard.
