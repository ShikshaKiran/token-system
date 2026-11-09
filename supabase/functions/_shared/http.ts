export function corsHeaders() {
  // Set ALLOWED_ORIGIN to your booking site (e.g. https://book.yourclinicapp.in).
  return {
    "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Accepts 9876543210, +91 98765 43210, 09876543210, 919876543210 -> "9876543210"
export function normalizeIndianPhone(input: unknown): string | null {
  let n = String(input ?? "").replace(/\D/g, "");
  if (n.length === 12 && n.startsWith("91")) n = n.slice(2);
  else if (n.length === 11 && n.startsWith("0")) n = n.slice(1);
  return /^[6-9]\d{9}$/.test(n) ? n : null;
}

// Error codes raised by the SQL functions -> friendly message + HTTP status.
export const BOOKING_ERRORS: Record<string, { status: number; message: string }> = {
  session_not_found: { status: 404, message: "This clinic session was not found." },
  session_closed: { status: 409, message: "Booking is closed for this session." },
  session_in_past: { status: 409, message: "This session date has already passed." },
  session_over: { status: 409, message: "Today's session has already ended." },
  too_far_ahead: { status: 409, message: "You can only book a few days in advance." },
  session_full: { status: 409, message: "All tokens for this session are booked." },
  online_quota_full: {
    status: 409,
    message: "Online tokens are full for this session. Please visit the clinic.",
  },
  too_many_for_phone: {
    status: 409,
    message: "This phone number already has the maximum bookings for this session.",
  },
};
