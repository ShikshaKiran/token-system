const TZ = "Asia/Kolkata";

export type StatusRow = {
  out_token_no: number;
  out_status: string;
  out_session_date: string; // YYYY-MM-DD
  out_start_time: string;   // HH:MM:SS
  out_end_time: string;
  out_now_serving: number | null;
  out_patients_seen: number;
  out_patients_ahead: number;
  out_est_wait_minutes: number;
};

export function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}

function nowMinutesIST(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

function fmtMinutes(total: number): string {
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const ap = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC", weekday: "short", day: "numeric", month: "short",
  }).format(new Date(iso + "T00:00:00Z"));
}

// Estimated clock time to meet the doctor (never earlier than session start).
function etaClock(estMinutes: number, startTime: string): string {
  return fmtMinutes(Math.max(nowMinutesIST() + estMinutes, toMin(startTime)));
}

// Shown on screen right after booking, and sent on WhatsApp once linked.
export function buildBookingMessage(clinicName: string, s: StatusRow): string {
  const sessionLine = `${fmtDate(s.out_session_date)} | ${fmtMinutes(toMin(s.out_start_time))} – ${fmtMinutes(toMin(s.out_end_time))}`;
  const today = s.out_session_date === todayIST();
  const lines = [
    `✅ Token booked — ${clinicName}`,
    `Your token number: ${s.out_token_no}`,
    `Session: ${sessionLine}`,
  ];
  if (today) {
    lines.push(
      `Patients seen so far: ${s.out_patients_seen}`,
      `Patients before you: ${s.out_patients_ahead}`,
      `Approx. time to meet the doctor: ${etaClock(s.out_est_wait_minutes, s.out_start_time)}`,
    );
  } else {
    lines.push("Your approximate time will be shared on the day of your visit.");
  }
  lines.push("", `आपका टोकन नंबर: ${s.out_token_no}`);
  if (today) {
    lines.push(
      `अब तक देखे गए मरीज़: ${s.out_patients_seen}`,
      `आपसे पहले मरीज़: ${s.out_patients_ahead}`,
      `डॉक्टर से मिलने का अनुमानित समय: ${etaClock(s.out_est_wait_minutes, s.out_start_time)}`,
    );
  } else {
    lines.push("आपका अनुमानित समय विज़िट वाले दिन बताया जाएगा।");
  }
  return lines.join("\n");
}

// Reply to "status" messages and the linking confirmation.
export function buildStatusMessage(clinicName: string, s: StatusRow, notifyBefore: number): string {
  const today = s.out_session_date === todayIST();
  const lines = [`🩺 ${clinicName}`, `Your token: ${s.out_token_no}`];
  if (s.out_status === "serving") {
    lines.push("It is your turn now. Please go to the doctor.", "अब आपकी बारी है।");
    return lines.join("\n");
  }
  if (today) {
    lines.push(
      `Now serving: ${s.out_now_serving ?? "-"}`,
      `Patients seen so far: ${s.out_patients_seen}`,
      `Patients before you: ${s.out_patients_ahead}`,
      `Approx. time: ${etaClock(s.out_est_wait_minutes, s.out_start_time)}`,
      `We will message you when ${notifyBefore} patients are left.`,
    );
  } else {
    lines.push(
      `Session: ${fmtDate(s.out_session_date)}, ${fmtMinutes(toMin(s.out_start_time))} – ${fmtMinutes(toMin(s.out_end_time))}`,
      "We will message you on the day of your visit.",
    );
  }
  return lines.join("\n");
}
