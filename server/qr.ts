import { randomBytes } from "node:crypto";
import { ENV } from "./_core/env";
import { getQrByCode, run } from "./db";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePublicCode(length = 8) {
  const bytes = randomBytes(length);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}

export function publicQrUrl(code: string) {
  return `${ENV.publicBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(code)}`;
}

export function safeExternalUrl(value: string | null | undefined, allowed = ["https:", "http:"]) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return allowed.includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export async function resolvePublicQr(publicCode: string, userAgent = "") {
  const qr = await getQrByCode(publicCode);
  if (!qr) return { kind: "NOT_FOUND" as const };
  if (qr.status === "STOCK" || qr.status === "RESERVED") return { kind: "NOT_CONFIGURED" as const, qr };
  if (qr.status === "INACTIVE") return { kind: "INACTIVE" as const, qr };
  await run("UPDATE qr_codes SET scan_count = scan_count + 1, last_scan_at = ?, updated_at = ? WHERE id = ?", [Date.now(), Date.now(), qr.id]);
  await run("INSERT INTO scan_events (qr_id, timestamp, user_agent) VALUES (?, ?, ?)", [qr.id, Date.now(), userAgent.slice(0, 240)]);
  return { kind: "ACTIVE" as const, qr };
}
