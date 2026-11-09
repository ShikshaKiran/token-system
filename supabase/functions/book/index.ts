// POST /functions/v1/book
// Body: { session_id, name, phone, whatsapp?, address?, turnstile_token? }
// Public endpoint (patients have no login). Protect it with Cloudflare
// Turnstile (set TURNSTILE_SECRET) before going live.
import { adminClient } from "../_shared/supabase.ts";
import { BOOKING_ERRORS, corsHeaders, json, normalizeIndianPhone } from "../_shared/http.ts";
import { buildBookingMessage, StatusRow } from "../_shared/messages.ts";
import { waMeLink } from "../_shared/whatsapp.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function verifyTurnstile(token: unknown, ip: string | null): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET");
  if (!secret) return true; // dev only: set the secret before launch
  if (typeof token !== "string" || !token) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  return data?.success === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json", message: "Invalid request." }, 400);
  }

  // ---- validate input ----
  const sessionId = String(body.session_id ?? "");
  const name = String(body.name ?? "").trim();
  const phone = normalizeIndianPhone(body.phone);
  const whatsappRaw = String(body.whatsapp ?? "").trim();
  const whatsapp = whatsappRaw ? normalizeIndianPhone(whatsappRaw) : null;
  const address = String(body.address ?? "").trim();

  if (!UUID.test(sessionId)) return json({ error: "bad_session", message: "Invalid session." }, 400);
  if (name.length < 1 || name.length > 100) {
    return json({ error: "bad_name", message: "Please enter the patient's name." }, 400);
  }
  if (!phone) {
    return json({ error: "bad_phone", message: "Please enter a valid 10-digit mobile number." }, 400);
  }
  if (whatsappRaw && !whatsapp) {
    return json({ error: "bad_whatsapp", message: "WhatsApp number is not valid." }, 400);
  }
  if (address.length > 300) {
    return json({ error: "bad_address", message: "Address is too long." }, 400);
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
  if (!(await verifyTurnstile(body.turnstile_token, ip))) {
    return json({ error: "captcha_failed", message: "Please complete the verification and try again." }, 400);
  }

  // ---- create booking (token assigned inside the database, with a row lock) ----
  const db = adminClient();
  const { data, error } = await db.rpc("create_booking", {
    p_session_id: sessionId,
    p_name: name,
    p_phone: phone,
    p_whatsapp: whatsapp,
    p_address: address || null,
    p_source: "online",
  });

  if (error) {
    const known = BOOKING_ERRORS[error.message];
    if (known) return json({ error: error.message, message: known.message }, known.status);
    console.error("create_booking failed:", error);
    return json({ error: "server_error", message: "Something went wrong. Please try again." }, 500);
  }

  const created = data?.[0];
  if (!created) return json({ error: "server_error", message: "Booking failed." }, 500);
  const code: string = created.out_booking_code;

  // ---- live numbers for the confirmation message ----
  const [{ data: st }, { data: sess }] = await Promise.all([
    db.rpc("get_booking_status", { p_code: code }),
    db.from("sessions").select("clinics(name, whatsapp_number)").eq("id", sessionId).single(),
  ]);
  const status = st?.[0] as StatusRow | undefined;
  const clinic = Array.isArray(sess?.clinics) ? sess?.clinics[0] : sess?.clinics;
  const clinicName: string = clinic?.name ?? "Clinic";

  const siteUrl = Deno.env.get("SITE_URL");
  return json({
    booking_code: code,
    token_no: created.out_token_no,
    session_date: created.out_session_date,
    start_time: created.out_start_time,
    end_time: created.out_end_time,
    est_wait_minutes: created.out_est_wait_minutes,
    // Show this on the confirmation screen:
    message: status ? buildBookingMessage(clinicName, status) : `Your token number: ${created.out_token_no}`,
    // Button: "Get live updates on WhatsApp" (click-to-chat; opens the 24h window)
    whatsapp_link: waMeLink(clinic?.whatsapp_number, code),
    status_url: siteUrl ? `${siteUrl.replace(/\/$/, "")}/s/${code}` : null,
  });
});
