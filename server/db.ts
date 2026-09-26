import { createClient, type Client, type InValue } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import fs from "node:fs";
import path from "node:path";
import { ENV } from "./_core/env";
import { users, type InsertUser } from "../drizzle/schema";

let client: Client | null = null;
let ready: Promise<void> | null = null;
const migration = fs.readFileSync(path.resolve(process.cwd(), "drizzle/0001_rsa_qr.sql"), "utf8");

export function getDb(): Client {
  if (!client) {
    const url = ENV.tursoUrl || (ENV.databaseUrl.startsWith("libsql") ? ENV.databaseUrl : "file:local.db");
    client = createClient({ url, authToken: ENV.tursoToken || undefined });
  }
  return client;
}
export async function ensureDb() { if (!ready) ready = getDb().executeMultiple(migration).catch(error => { ready = null; console.error("[DB] migration failed", error); throw error; }); await ready; }
export async function query<T = Record<string, unknown>>(sql: string, args: InValue[] = []) { await ensureDb(); const result = await getDb().execute({ sql, args }); return result.rows as unknown as T[]; }
export async function run(sql: string, args: InValue[] = []) { await ensureDb(); return getDb().execute({ sql, args }); }
export async function audit(action: string, entityType: string, entityId: number | null, metadata: unknown, adminOpenId?: string) { await run("INSERT INTO audit_logs (action, entity_type, entity_id, metadata, created_at, admin_open_id) VALUES (?, ?, ?, ?, ?, ?)", [action, entityType, entityId, JSON.stringify(metadata ?? {}), Date.now(), adminOpenId ?? null]); }

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) return;
  if (ENV.tursoUrl || !ENV.databaseUrl || ENV.databaseUrl.startsWith("libsql")) {
    const now = Date.now(); const role = user.openId === ENV.ownerOpenId ? "admin" : (user.role ?? "user");
    await run("INSERT INTO users (open_id,name,email,login_method,role,created_at,updated_at,last_signed_in) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(open_id) DO UPDATE SET name=excluded.name,email=excluded.email,login_method=excluded.login_method,role=excluded.role,updated_at=excluded.updated_at,last_signed_in=excluded.last_signed_in", [user.openId, user.name ?? null, user.email ?? null, user.loginMethod ?? null, role, now, now, now]);
    return;
  }
  const db = drizzle(ENV.databaseUrl); await db.insert(users).values(user).onDuplicateKeyUpdate({ set: { name: user.name, email: user.email, lastSignedIn: new Date() } });
}
export async function getUserByOpenId(openId: string) {
  if (ENV.tursoUrl || !ENV.databaseUrl || ENV.databaseUrl.startsWith("libsql")) return (await query<any>("SELECT id, open_id as openId, name, email, login_method as loginMethod, role, created_at as createdAt, updated_at as updatedAt, last_signed_in as lastSignedIn FROM users WHERE open_id=? LIMIT 1", [openId]))[0];
  const db = drizzle(ENV.databaseUrl); const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1); return result[0];
}
export async function getCustomer(id: number) { return (await query<any>("SELECT * FROM customers WHERE id = ? LIMIT 1", [id]))[0] ?? null; }
export async function getQrByCode(publicCode: string) { return (await query<any>("SELECT q.*, c.business_name, c.phone, c.email, c.address, c.city, c.state, c.notes, c.google_review_url FROM qr_codes q LEFT JOIN customers c ON c.id = q.customer_id WHERE q.public_code = ? LIMIT 1", [publicCode]))[0] ?? null; }
export async function getLinks(customerId: number) { return query<any>("SELECT * FROM links WHERE customer_id = ? ORDER BY position ASC, id ASC", [customerId]); }
