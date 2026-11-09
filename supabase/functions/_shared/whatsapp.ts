// WhatsApp Cloud API helpers. Check Meta's docs for the current Graph API
// version and set WA_API_VERSION accordingly.
export async function sendText(phoneNumberId: string, to: string, body: string) {
  const token = Deno.env.get("WA_ACCESS_TOKEN");
  const version = Deno.env.get("WA_API_VERSION") ?? "v21.0";
  if (!token) return { ok: false, id: undefined, error: "WA_ACCESS_TOKEN not set" };

  const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body, preview_url: false },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    id: data?.messages?.[0]?.id as string | undefined,
    error: res.ok ? undefined : JSON.stringify(data?.error ?? data),
  };
}

// wa.me link that opens the clinic's WhatsApp with the booking code pre-filled.
export function waMeLink(clinicNumber: string | null | undefined, code: string): string | null {
  let n = String(clinicNumber ?? "").replace(/\D/g, "");
  if (n.length === 10) n = "91" + n;
  if (n.length < 11) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(`Booking code ${code}`)}`;
}
