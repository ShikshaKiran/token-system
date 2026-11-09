// Called by the doctor dashboard after Next / Skip / walk-in / timing change.
// Sends the "N patients left" alert (kind "queue") or the timing-change message (kind "timing")
// to patients who linked WhatsApp. Only sends free-form messages while the reply window is open.
// Alerts outside the window stay pending (template messages are a later step).
import { createClient } from "npm:@supabase/supabase-js@2";
import { adminClient } from "../_shared/supabase.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { sendText } from "../_shared/whatsapp.ts";

const hm = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Act as the signed-in staff member so RLS proves the session is theirs.
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: u } = await user.auth.getUser();
  if (!u?.user) return json({ message: "Not signed in." }, 401);

  const body = await req.json().catch(() => ({}));
  const { data: s } = await user.from("sessions").select("id,clinic_id,start_time,end_time")
    .eq("id", String(body.session_id ?? "")).maybeSingle();
  if (!s) return json({ message: "Session not found." }, 404);

  const db = adminClient();
  const { data: c } = await db.from("clinics").select("id,wa_phone_number_id").eq("id", s.clinic_id).single();
  if (!c?.wa_phone_number_id) return json({ sent: 0, note: "WhatsApp is not set up for this clinic." });

  let sent = 0, windowClosed = 0;
  const send = async (bookingId: string, waId: string | null, kind: string, text: string) => {
    if (!waId) return false;
    const { data: open } = await db.rpc("wa_window_open", { p_clinic_id: c.id, p_wa_id: waId });
    if (!open) { windowClosed++; return false; }
    const r = await sendText(c.wa_phone_number_id, waId, text);
    await db.from("message_log").insert({
      clinic_id: c.id, booking_id: bookingId, kind, status: r.ok ? "sent" : "failed",
      provider_message_id: r.id ?? null, error: r.error ?? null,
    });
    if (r.ok) sent++;
    return r.ok;
  };

  if (body.kind === "timing") {
    const { data: ws } = await db.from("bookings").select("id,wa_id").eq("session_id", s.id).eq("status", "waiting");
    for (const w of ws ?? []) {
      await send(w.id, w.wa_id, "timing_change", `🕒 Clinic timing changed: ${hm(s.start_time)} to ${hm(s.end_time)}.`);
    }
  } else {
    const { data: al } = await db.rpc("pending_ahead_alerts", { p_session_id: s.id });
    const ok: string[] = [];
    for (const a of al ?? []) {
      const n = a.out_patients_ahead;
      if (await send(a.out_booking_id, a.out_wa_id, "n_left",
        `⏰ Token ${a.out_token_no}: only ${n} patient${n === 1 ? "" : "s"} left before you. Approx. wait ${a.out_est_wait_minutes} min.`)) {
        ok.push(a.out_booking_id);
      }
    }
    if (ok.length) await db.rpc("mark_alert_sent", { p_booking_ids: ok });
  }
  return json({ sent, window_closed: windowClosed });
});
