// WhatsApp Cloud API webhook.
//  GET  -> Meta's verification handshake
//  POST -> inbound messages. If the text has a booking code (BK-XXXXXXXX) the
//          patient's WhatsApp id is linked to the booking and a status message
//          is sent back (this also opens the free reply window).
import { adminClient } from "../_shared/supabase.ts";
import { buildStatusMessage, StatusRow } from "../_shared/messages.ts";
import { sendText } from "../_shared/whatsapp.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const CODE_RE = /BK-[0-9A-F]{8}/i;

// ---- signature check: X-Hub-Signature-256 = "sha256=" + HMAC(appSecret, rawBody) ----
async function validSignature(raw: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get("WA_APP_SECRET");
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const expected = Array.from(mac).map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

type Db = ReturnType<typeof adminClient>;
type Clinic = { id: string; name: string; notify_before: number; wa_phone_number_id: string };

async function reply(db: Db, clinic: Clinic, waId: string, bookingId: string | null, kind: string, text: string) {
  const r = await sendText(clinic.wa_phone_number_id, waId, text);
  await db.from("message_log").insert({
    clinic_id: clinic.id,
    booking_id: bookingId,
    kind,
    status: r.ok ? "sent" : "failed",
    provider_message_id: r.id ?? null,
    error: r.error ?? null,
  });
}

async function statusFor(db: Db, code: string): Promise<StatusRow | null> {
  const { data } = await db.rpc("get_booking_status", { p_code: code });
  return (data?.[0] as StatusRow | undefined) ?? null;
}

async function handleMessage(db: Db, clinic: Clinic, msg: any) {
  const waId: string = msg.from;
  const text: string =
    msg.text?.body ?? msg.button?.text ?? msg.button?.payload ?? msg.interactive?.button_reply?.title ?? "";

  // Any inbound message opens/refreshes the reply window.
  await db.rpc("record_inbound", { p_clinic_id: clinic.id, p_wa_id: waId });

  const m = text.match(CODE_RE);
  if (m) {
    const code = m[0].toUpperCase();
    const { data: linked } = await db.rpc("link_whatsapp", { p_code: code, p_wa_id: waId });
    const row = linked?.[0];
    if (!row) {
      await reply(db, clinic, waId, null, "link_failed",
        "We could not find that booking code, or it is linked to another number. Please check it or book again.\n\nयह बुकिंग कोड नहीं मिला। कृपया दोबारा जाँचें।");
      return;
    }
    const st = await statusFor(db, code);
    if (st) {
      await reply(db, clinic, waId, row.out_booking_id, "confirmation",
        "✅ WhatsApp updates are on.\n" + buildStatusMessage(clinic.name, st, clinic.notify_before));
    }
    return;
  }

  // No code: if this number has an active booking, send its status.
  const { data: b } = await db.from("bookings")
    .select("id, booking_code")
    .eq("clinic_id", clinic.id).eq("wa_id", waId)
    .in("status", ["waiting", "serving"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();

  if (b) {
    const st = await statusFor(db, b.booking_code);
    if (st) {
      await reply(db, clinic, waId, b.id, "status_reply", buildStatusMessage(clinic.name, st, clinic.notify_before));
      return;
    }
  }
  await reply(db, clinic, waId, null, "help",
    "To get your token updates, send your booking code (like BK-1234ABCD).\n\nटोकन की जानकारी के लिए अपना बुकिंग कोड भेजें।");
}

async function processPayload(payload: any) {
  const db = adminClient();
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
      if (!phoneNumberId || !value?.messages?.length) continue; // delivery/read statuses etc.

      const { data: clinic } = await db.from("clinics")
        .select("id, name, notify_before, wa_phone_number_id")
        .eq("wa_phone_number_id", phoneNumberId).maybeSingle();
      if (!clinic) { console.warn("No clinic for phone_number_id", phoneNumberId); continue; }

      for (const msg of value.messages) {
        try {
          await handleMessage(db, clinic as Clinic, msg);
        } catch (e) {
          console.error("handleMessage failed:", e);
        }
      }
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    const u = new URL(req.url);
    if (
      u.searchParams.get("hub.mode") === "subscribe" &&
      u.searchParams.get("hub.verify_token") === Deno.env.get("WA_VERIFY_TOKEN")
    ) {
      return new Response(u.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }

  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  // Reply 200 quickly (Meta retries slow/failed webhooks); do the work in the background.
  EdgeRuntime.waitUntil(processPayload(payload));
  return new Response("ok", { status: 200 });
});
