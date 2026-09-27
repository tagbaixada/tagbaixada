import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { InValue } from "@libsql/client";
import { audit, getCustomer, getDb, getLinks, getQrByCode, query, run } from "./db";
import { generatePublicCode, publicQrUrl, safeExternalUrl } from "./qr";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { systemRouter } from "./_core/systemRouter";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso restrito ao administrador." });
  }
  return next();
});

const statusSchema = z.enum(["STOCK", "RESERVED", "ACTIVE", "INACTIVE"]);
const modeSchema = z.enum(["GOOGLE_REVIEW", "LANDING_PAGE"]);
const customerInput = z.object({
  businessName: z.string().trim().min(2).max(180),
  phone: z.string().trim().max(40).default(""),
  email: z.string().trim().email().optional().or(z.literal("")),
  address: z.string().trim().max(240).optional().or(z.literal("")),
  city: z.string().trim().max(80).default(""),
  state: z.string().trim().max(2).default(""),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  googleReviewUrl: z.string().trim().optional().or(z.literal("")),
});
const linkInput = z.object({
  customerId: z.number().int().positive(),
  type: z.string().trim().min(2).max(40),
  label: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(1000),
  icon: z.string().trim().max(40).default("link"),
  position: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

function invalidUrl(message = "Informe uma URL HTTP ou HTTPS válida."): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function requireUrl(value: string | null | undefined, message?: string) {
  const safe = safeExternalUrl(value);
  if (!safe) invalidUrl(message);
  return safe;
}

function validateLinkValue(type: string, value: string) {
  if (/^(javascript|data|vbscript):/i.test(value.trim())) invalidUrl("Links javascript:, data: e vbscript: não são permitidos.");
  if (["SITE", "INSTAGRAM", "WHATSAPP", "GOOGLE_REVIEW"].includes(type)) return requireUrl(value);
  return value;
}

async function getQr(id: number) {
  const rows = await query<any>(
    "SELECT q.*, c.business_name, c.phone, c.email, c.address, c.city, c.state, c.notes, c.google_review_url FROM qr_codes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.id=? LIMIT 1",
    [id],
  );
  return rows[0] ?? null;
}

async function ensureQrForCustomer(id: number) {
  const qr = await getQr(id);
  if (!qr) throw new TRPCError({ code: "NOT_FOUND", message: "QR Code não encontrado." });
  if (!qr.customer_id) throw new TRPCError({ code: "BAD_REQUEST", message: "Associe um cliente antes de continuar." });
  return qr;
}

async function validateActivation(qr: any) {
  if (!qr.customer_id) throw new TRPCError({ code: "BAD_REQUEST", message: "O QR precisa de um cliente." });
  if (!qr.mode) throw new TRPCError({ code: "BAD_REQUEST", message: "Escolha o modo do QR." });
  if (qr.mode === "GOOGLE_REVIEW") {
    const destination = requireUrl(qr.google_review_url);
    return destination;
  }
  return null;
}

type AdminContext = { user: { openId: string } };

async function activateQrFor(id: number, ctx: AdminContext) {
  const qr = await ensureQrForCustomer(id);
  if (!["RESERVED", "INACTIVE"].includes(qr.status)) throw new TRPCError({ code: "CONFLICT", message: "O QR precisa estar reservado ou inativo para ser ativado." });
  const destination = await validateActivation(qr);
  await run("UPDATE qr_codes SET status='ACTIVE', destination_url=?, activated_at=?, updated_at=? WHERE id=? AND status IN ('RESERVED','INACTIVE')", [destination, Date.now(), Date.now(), id]);
  await audit("QR_ACTIVATED", "qr_code", id, { mode: qr.mode, destination }, ctx.user.openId);
  return { success: true } as const;
}

async function deactivateQrFor(id: number, ctx: AdminContext) {
  const qr = await getQr(id);
  if (!qr) throw new TRPCError({ code: "NOT_FOUND", message: "QR Code não encontrado." });
  if (qr.status !== "ACTIVE") throw new TRPCError({ code: "CONFLICT", message: "Somente QR Codes ativos podem ser desativados." });
  await run("UPDATE qr_codes SET status='INACTIVE', updated_at=? WHERE id=? AND status='ACTIVE'", [Date.now(), id]);
  await audit("QR_DEACTIVATED", "qr_code", id, { from: "ACTIVE", to: "INACTIVE" }, ctx.user.openId);
  return { success: true } as const;
}

async function configureQrFor(id: number, mode: "GOOGLE_REVIEW" | "LANDING_PAGE", ctx: AdminContext) {
  const qr = await ensureQrForCustomer(id);
  if (!["RESERVED", "ACTIVE"].includes(qr.status)) throw new TRPCError({ code: "CONFLICT", message: "Reserve o QR antes de configurar o destino." });
  const destination = mode === "GOOGLE_REVIEW" ? requireUrl(qr.google_review_url, "Cadastre uma URL manual de avaliação do Google para este cliente.") : null;
  await run("UPDATE qr_codes SET mode=?, destination_url=?, updated_at=? WHERE id=?", [mode, destination, Date.now(), id]);
  await audit("DESTINATION_CHANGED", "qr_code", id, { mode, destination }, ctx.user.openId);
  return { success: true } as const;
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  public: router({
    qr: publicProcedure.input(z.object({ code: z.string().min(6).max(20) })).query(async ({ input }) => {
      const qr = await getQrByCode(input.code);
      return qr ? { publicCode: qr.public_code, status: qr.status, mode: qr.mode, publicUrl: publicQrUrl(qr.public_code) } : null;
    }),
  }),
  admin: router({
    dashboard: adminProcedure.query(async () => {
      const counts = (await query<any>(
        "SELECT COUNT(*) total, SUM(status='ACTIVE') active, SUM(status='STOCK') stock, SUM(status='RESERVED') reserved, SUM(status='INACTIVE') inactive, COALESCE(SUM(scan_count),0) scans FROM qr_codes",
      ))[0] ?? {};
      const customers = (await query<any>("SELECT COUNT(*) total FROM customers"))[0] ?? {};
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const today = (await query<any>("SELECT COUNT(*) total FROM scan_events WHERE timestamp >= ?", [todayStart.getTime()]))[0]?.total ?? 0;
      const last30 = (await query<any>("SELECT COUNT(*) total FROM scan_events WHERE timestamp >= ?", [Date.now() - 30 * 86400000]))[0]?.total ?? 0;
      const recent = await query<any>("SELECT a.*, q.serial_number, c.business_name FROM audit_logs a LEFT JOIN qr_codes q ON q.id=a.entity_id AND a.entity_type='qr_code' LEFT JOIN customers c ON c.id=q.customer_id ORDER BY a.created_at DESC LIMIT 8");
      return { cards: { ...counts, customers: customers.total ?? 0, scansToday: today, scans30: last30 }, recent };
    }),
    customers: adminProcedure.input(z.object({ search: z.string().trim().default(""), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(25) })).query(async ({ input }) => {
      const offset = (input.page - 1) * input.pageSize;
      const like = `%${input.search}%`;
      const where = input.search ? "WHERE business_name LIKE ? OR phone LIKE ?" : "";
      const args = input.search ? [like, like] : [];
      const total = (await query<any>(`SELECT COUNT(*) total FROM customers ${where}`, args))[0]?.total ?? 0;
      const items = await query<any>(`SELECT * FROM customers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...args, input.pageSize, offset]);
      return { items, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),
    customer: adminProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getCustomer(input.id)),
    createCustomer: adminProcedure.input(customerInput.extend({ allowDuplicate: z.boolean().default(false) })).mutation(async ({ input, ctx }) => {
      if (input.phone && !input.allowDuplicate) {
        const duplicate = (await query<any>("SELECT id, business_name FROM customers WHERE phone=? LIMIT 1", [input.phone]))[0];
        if (duplicate) throw new TRPCError({ code: "CONFLICT", message: `Já existe um cliente com este telefone: ${duplicate.business_name}. Confirme novamente para criar mesmo assim.` });
      }
      const now = Date.now();
      const review = input.googleReviewUrl ? requireUrl(input.googleReviewUrl) : null;
      const result = await run("INSERT INTO customers (business_name, phone, email, address, city, state, notes, google_review_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [input.businessName, input.phone, input.email || null, input.address || null, input.city, input.state.toUpperCase(), input.notes || null, review, now, now]);
      const id = Number(result.lastInsertRowid);
      await audit("CUSTOMER_CREATED", "customer", id, { businessName: input.businessName, phone: input.phone }, ctx.user.openId);
      return { id };
    }),
    updateCustomer: adminProcedure.input(customerInput.extend({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
      if (input.phone) {
        const duplicate = (await query<any>("SELECT id, business_name FROM customers WHERE phone=? AND id<>? LIMIT 1", [input.phone, input.id]))[0];
        if (duplicate) throw new TRPCError({ code: "CONFLICT", message: `Este telefone já pertence a ${duplicate.business_name}.` });
      }
      const review = input.googleReviewUrl ? requireUrl(input.googleReviewUrl) : null;
      await run("UPDATE customers SET business_name=?, phone=?, email=?, address=?, city=?, state=?, notes=?, google_review_url=?, updated_at=? WHERE id=?", [input.businessName, input.phone, input.email || null, input.address || null, input.city, input.state.toUpperCase(), input.notes || null, review, Date.now(), input.id]);
      await audit("CUSTOMER_UPDATED", "customer", input.id, { businessName: input.businessName, phone: input.phone }, ctx.user.openId);
      return { success: true };
    }),
    qrs: adminProcedure.input(z.object({ status: z.string().trim().default(""), search: z.string().trim().default(""), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(25) })).query(async ({ input }) => {
      const offset = (input.page - 1) * input.pageSize;
      const conditions: string[] = [];
      const args: InValue[] = [];
      if (input.status) { statusSchema.parse(input.status); conditions.push("q.status=?"); args.push(input.status); }
      if (input.search) { const like = `%${input.search}%`; conditions.push("(CAST(q.serial_number AS TEXT) LIKE ? OR q.public_code LIKE ? OR c.business_name LIKE ? OR c.phone LIKE ?)"); args.push(like, like, like, like); }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const total = (await query<any>(`SELECT COUNT(*) total FROM qr_codes q LEFT JOIN customers c ON c.id=q.customer_id ${where}`, args))[0]?.total ?? 0;
      const items = await query<any>(`SELECT q.*, c.business_name, c.phone FROM qr_codes q LEFT JOIN customers c ON c.id=q.customer_id ${where} ORDER BY q.serial_number ASC LIMIT ? OFFSET ?`, [...args, input.pageSize, offset]);
      return { items, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),
    qr: adminProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ input }) => {
      const qr = await getQr(input.id);
      if (!qr) throw new TRPCError({ code: "NOT_FOUND", message: "QR Code não encontrado." });
      return { ...qr, public_url: publicQrUrl(qr.public_code), links: qr.customer_id ? await getLinks(qr.customer_id) : [] };
    }),
    createBatch: adminProcedure.input(z.object({ quantity: z.number().int().min(1).max(500), startingSerial: z.number().int().min(1) })).mutation(async ({ input, ctx }) => {
      const serials = Array.from({ length: input.quantity }, (_, index) => input.startingSerial + index);
      const placeholders = serials.map(() => "?").join(",");
      const duplicate = await query<any>(`SELECT serial_number FROM qr_codes WHERE serial_number IN (${placeholders}) LIMIT 1`, serials);
      if (duplicate.length) throw new TRPCError({ code: "CONFLICT", message: `O serial ${String(duplicate[0].serial_number).padStart(6, "0")} já existe.` });
      const items: Array<{ serial: number; code: string }> = [];
      for (const serial of serials) {
        let code = generatePublicCode();
        while ((await query<any>("SELECT id FROM qr_codes WHERE public_code=?", [code])).length) code = generatePublicCode();
        items.push({ serial, code });
      }
      const now = Date.now();
      const statements: Array<{ sql: string; args: InValue[] }> = items.map(item => ({ sql: "INSERT INTO qr_codes (serial_number, public_code, status, mode, created_at, updated_at) VALUES (?, ?, 'STOCK', 'GOOGLE_REVIEW', ?, ?)", args: [item.serial, item.code, now, now] }));
      statements.push({ sql: "INSERT INTO batches (batch_number, quantity, status, created_at, manifest_json) VALUES (COALESCE((SELECT MAX(batch_number)+1 FROM batches),1), ?, 'COMPLETED', ?, ?)", args: [items.length, now, JSON.stringify(items)] });
      const results = await getDb().batch(statements);
      const batchId = Number(results[items.length]?.lastInsertRowid ?? 0);
      await audit("BATCH_CREATED", "batch", batchId, { quantity: items.length, firstSerial: serials[0], lastSerial: serials[serials.length - 1] }, ctx.user.openId);
      for (let index = 0; index < items.length; index += 1) await audit("QR_CREATED", "qr_code", Number(results[index]?.lastInsertRowid ?? 0) || null, items[index], ctx.user.openId);
      return { batchId, requested: input.quantity, created: items.length, errors: 0, firstSerial: serials[0], lastSerial: serials[serials.length - 1], items };
    }),
    reserveQr: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
      const qr = await getQr(input.id);
      if (!qr) throw new TRPCError({ code: "NOT_FOUND", message: "QR Code não encontrado." });
      if (qr.status !== "STOCK") throw new TRPCError({ code: "CONFLICT", message: "Somente QR Codes em estoque podem ser reservados." });
      await run("UPDATE qr_codes SET status='RESERVED', reserved_at=?, updated_at=? WHERE id=? AND status='STOCK'", [Date.now(), Date.now(), input.id]);
      await audit("QR_RESERVED", "qr_code", input.id, { from: "STOCK", to: "RESERVED" }, ctx.user.openId);
      return { success: true };
    }),
    assignQrCustomer: adminProcedure.input(z.object({ id: z.number().int().positive(), customerId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
      const qr = await getQr(input.id);
      if (!qr) throw new TRPCError({ code: "NOT_FOUND", message: "QR Code não encontrado." });
      if (!["STOCK", "RESERVED"].includes(qr.status)) throw new TRPCError({ code: "CONFLICT", message: "A associação só pode ser alterada antes da ativação." });
      if (!(await getCustomer(input.customerId))) throw new TRPCError({ code: "NOT_FOUND", message: "Cliente não encontrado." });
      await run("UPDATE qr_codes SET customer_id=?, updated_at=? WHERE id=? AND status IN ('STOCK','RESERVED')", [input.customerId, Date.now(), input.id]);
      await audit(qr.customer_id ? "QR_CUSTOMER_CHANGED" : "QR_CUSTOMER_ASSIGNED", "qr_code", input.id, { fromCustomerId: qr.customer_id, toCustomerId: input.customerId }, ctx.user.openId);
      return { success: true };
    }),
    configureQr: adminProcedure.input(z.object({ id: z.number().int().positive(), mode: modeSchema })).mutation(async ({ input, ctx }) => {
      const qr = await ensureQrForCustomer(input.id);
      if (!["RESERVED", "ACTIVE"].includes(qr.status)) throw new TRPCError({ code: "CONFLICT", message: "Reserve o QR antes de configurar o destino." });
      let destination: string | null = null;
      if (input.mode === "GOOGLE_REVIEW") destination = requireUrl(qr.google_review_url, "Cadastre uma URL manual de avaliação do Google para este cliente.");
      await run("UPDATE qr_codes SET mode=?, destination_url=?, updated_at=? WHERE id=?", [input.mode, destination, Date.now(), input.id]);
      await audit("DESTINATION_CHANGED", "qr_code", input.id, { mode: input.mode, destination }, ctx.user.openId);
      return { success: true };
    }),
    activateQr: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ input, ctx }) => activateQrFor(input.id, ctx)),
    deactivateQr: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ input, ctx }) => deactivateQrFor(input.id, ctx)),
    setQrStatus: adminProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["ACTIVE", "INACTIVE"]) })).mutation(async ({ input, ctx }) => {
      return input.status === "ACTIVE" ? activateQrFor(input.id, ctx) : deactivateQrFor(input.id, ctx);
    }),
    updateQr: adminProcedure.input(z.object({ id: z.number().int().positive(), mode: modeSchema })).mutation(async ({ input, ctx }) => {
      return configureQrFor(input.id, input.mode, ctx);
    }),
    links: adminProcedure.input(z.object({ customerId: z.number().int().positive() })).query(({ input }) => getLinks(input.customerId)),
    saveLink: adminProcedure.input(linkInput.extend({ id: z.number().int().positive().optional() })).mutation(async ({ input, ctx }) => {
      const value = validateLinkValue(input.type, input.value);
      if (input.id) await run("UPDATE links SET type=?, label=?, value=?, icon=?, position=?, enabled=?, updated_at=? WHERE id=? AND customer_id=?", [input.type, input.label, value, input.icon, input.position, input.enabled ? 1 : 0, Date.now(), input.id, input.customerId]);
      else await run("INSERT INTO links (customer_id,type,label,value,icon,position,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [input.customerId, input.type, input.label, value, input.icon, input.position, input.enabled ? 1 : 0, Date.now(), Date.now()]);
      await audit("LINKS_CHANGED", "customer", input.customerId, input, ctx.user.openId);
      return { success: true };
    }),
    audit: adminProcedure.input(z.object({ entityType: z.string().optional(), entityId: z.number().optional() }).default({})).query(({ input }) => query<any>("SELECT * FROM audit_logs WHERE (? = '' OR entity_type=?) AND (? IS NULL OR entity_id=?) ORDER BY created_at DESC LIMIT 100", [input.entityType ?? "", input.entityType ?? "", input.entityId ?? null, input.entityId ?? null])),
  }),
});

export type AppRouter = typeof appRouter;
