# ClinicQ

Two separate websites that share one Supabase database, like a public site and an admin dashboard:

- `patient-site/` the **public website** patients see: clinic and doctor information, services, timings, a notice banner, and token booking with live status. Everything except booking comes from content the doctor edits.
- `doctor-site/` the **doctor dashboard** (login required): queue, Next/Skip, walk-ins, session timing, close/reopen booking, medicine lists, and a **Public website** form that changes what the patient site shows.
- `supabase/` database migrations (schema, security rules, queue functions, site content) and Edge Functions: `book`, `patient-api`, `notify`, `wa-webhook`.

Status: written but not yet run against a live project. Test on a fresh Supabase project first.

## 1. Supabase
1. Create a new Supabase project (keep it separate from your other apps).
2. `supabase link --project-ref <ref>`, then `supabase db push` (runs all five migrations).
3. Authentication > Users > Add user: `drsharma@staff.clinicq.local` (username plus `@staff.clinicq.local`), set a password, tick Auto Confirm.
4. Run `supabase/first_clinic.sql` in the SQL editor. It prints `clinic_id`.
5. Fill `patient-site/config.js` (URL, publishable key, clinic id) and `doctor-site/config.js` (URL, publishable key).

## 2. Edge Functions
```
supabase secrets set ALLOWED_ORIGIN=https://<your-public-patient-site> \
  SITE_URL=https://<your-public-patient-site> \
  WA_ACCESS_TOKEN=... WA_APP_SECRET=... WA_VERIFY_TOKEN=<long random string>
supabase functions deploy
```
- `ALLOWED_ORIGIN` is the patient site only. The doctor site calls `notify`, which checks the doctor's login instead.
- Leave `TURNSTILE_SECRET` unset until the patient page sends a captcha token (not built yet). Add captcha and rate limiting before a public launch.
- WhatsApp: set Meta's callback URL to `https://<ref>.supabase.co/functions/v1/wa-webhook`, subscribe to `messages`, then save the clinic's `whatsapp_number` and `wa_phone_number_id`. Check Meta's docs for the current Graph API version (`WA_API_VERSION`).

## 3. Push to GitHub and deploy two sites
```
git init && git add . && git commit -m "ClinicQ"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
Deploy the same repo as **two separate sites** on Netlify, Vercel or Cloudflare Pages:
- Site 1 (public): base directory `patient-site`. Build command `node build.mjs`, publish directory `dist` (already set in `netlify.toml` and `vercel.json`). This pre-renders the clinic details into the HTML so Google can read them.
- Site 2 (doctor): base directory `doctor-site`, no build command. It carries a `noindex` tag so search engines skip it.

Then put the public site's address into `doctor-site/config.js` as `PUBLIC_SITE_URL` (optional "View public site" link).

## 4. Keep the search-engine copy fresh (optional but recommended)
Visitors always see live content, because the page loads the latest data in the browser. The pre-rendered copy that Google reads is rebuilt on each deploy. To rebuild it automatically when the doctor saves changes:
1. In Netlify (or Vercel): create a build/deploy hook for the public site and copy its URL.
2. `supabase secrets set SITE_DEPLOY_HOOK=<that url>` then `supabase functions deploy publish-site`.
3. Set `SITE_URL` (your public site address) in the site's environment variables if your host does not provide it automatically. It is used for the canonical link and `sitemap.xml`.
4. Submit the public site in Google Search Console.

## Never commit
Service-role key, WhatsApp tokens, `.env` files. Only the URL and publishable key in each `config.js` are public by design.

## Known gaps
- Doctor accounts and the first clinic are created by the admin (steps above).
- Images: the doctor uploads a clinic logo and doctor photo on the doctor site (JPG, PNG or WebP, up to 2 MB; resized in the browser). They are stored in a public Supabase Storage bucket named `site-assets`. Use plain photos only; anyone with the link can view them.
- "N left" alerts only go out while WhatsApp's free reply window is open; template messages are not built.
- Patient cancellations do not trigger alerts until the next doctor action.
