// Public read endpoints for the patient site: list open sessions, booking status, cancel.
import { adminClient } from "../_shared/supabase.ts";
import { corsHeaders, json } from "../_shared/http.ts";

const IST = "Asia/Kolkata";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
const nowHM = () =>
  new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ message: "Invalid request." }, 400); }
  const db = adminClient();

  if (b.action === "sessions") {
    const { data: c } = await db.from("clinics").select("id,name,advance_days").eq("id", String(b.clinic_id ?? "")).maybeSingle();
    if (!c) return json({ message: "Clinic not found." }, 404);
    const d0 = today();
    const last = new Date(Date.parse(d0) + c.advance_days * 86400000).toISOString().slice(0, 10);
    const { data: ss } = await db.from("sessions")
      .select("id,session_date,start_time,end_time,online_quota,staff(full_name)")
      .eq("clinic_id", c.id).in("status", ["scheduled", "open"])
      .gte("session_date", d0).lte("session_date", last)
      .order("session_date").order("start_time");
    const live = (ss ?? []).filter((s: any) => s.session_date > d0 || s.end_time.slice(0, 5) > nowHM());
    const ids = live.map((s: any) => s.id);
    const { data: bk } = ids.length
      ? await db.from("bookings").select("session_id").in("session_id", ids).eq("source", "online").neq("status", "cancelled")
      : { data: [] as any[] };
    const used: Record<string, number> = {};
    (bk ?? []).forEach((x: any) => { used[x.session_id] = (used[x.session_id] ?? 0) + 1; });
    return json({
      clinic_name: c.name,
      sessions: live.map((s: any) => ({
        id: s.id, session_date: s.session_date, start_time: s.start_time, end_time: s.end_time,
        doctor_name: (Array.isArray(s.staff) ? s.staff[0] : s.staff)?.full_name ?? "Doctor",
        left: s.online_quota - (used[s.id] ?? 0),
      })),
    });
  }

  const code = String(b.code ?? "").trim().toUpperCase();
  if (b.action === "status") {
    const { data } = await db.rpc("get_booking_status", { p_code: code });
    const status = data?.[0] ?? null;
    let clinic_name: string | null = null;
    if (status) {
      const { data: x } = await db.from("bookings").select("clinics(name)").eq("booking_code", code).maybeSingle();
      clinic_name = (Array.isArray((x as any)?.clinics) ? (x as any).clinics[0] : (x as any)?.clinics)?.name ?? null;
    }
    return json({ status, clinic_name });
  }
  if (b.action === "cancel") {
    const { data } = await db.rpc("cancel_booking_by_code", { p_code: code });
    return json({ ok: data === true });
  }
  return json({ message: "Unknown action." }, 400);
});
