// Safe to commit: the Supabase URL and the publishable (anon) key are public by design.
// NEVER put the service-role key or any WhatsApp token in this repo.
window.CLINICQ = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-PUBLISHABLE-KEY',
  CLINIC_ID: 'YOUR-CLINIC-UUID'   // printed by supabase/first_clinic.sql
};
