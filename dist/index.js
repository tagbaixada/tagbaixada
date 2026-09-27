// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
var OAUTH_STATE_COOKIE = "__Host-oauth_state";
var decodeOAuthState = (state) => {
  let decoded;
  try {
    decoded = atob(state);
  } catch {
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
  }
  return { redirectUri: decoded };
};

// server/_core/oauth.ts
import { parse as parseCookieHeader2 } from "cookie";

// server/db.ts
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import fs from "node:fs";
import path from "node:path";

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  tursoUrl: process.env.TURSO_DATABASE_URL ?? "",
  tursoToken: process.env.TURSO_AUTH_TOKEN ?? process.env.turso_tagbaixada ?? "",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "https://go.rsadigitalconsultoria.com.br",
  appBaseUrl: process.env.APP_BASE_URL ?? "https://app.rsadigitalconsultoria.com.br",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// drizzle/schema.ts
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
var users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
});
var schemaHealthCheck = sql`select 1`;

// server/db.ts
var client = null;
var ready = null;
var migration = null;
function getMigration() {
  if (migration !== null) return migration;
  try {
    migration = fs.readFileSync(path.resolve(process.cwd(), "drizzle/0001_rsa_qr.sql"), "utf8");
  } catch {
    migration = "";
  }
  return migration;
}
function getDb() {
  if (!client) {
    const url = ENV.tursoUrl || (ENV.databaseUrl.startsWith("libsql") ? ENV.databaseUrl : "file:local.db");
    client = createClient({ url, authToken: ENV.tursoToken || void 0 });
  }
  return client;
}
async function ensureDb() {
  if (!ready) {
    const script = getMigration();
    ready = script ? getDb().executeMultiple(script).catch((error) => {
      ready = null;
      console.error("[DB] migration failed", error);
      throw error;
    }) : Promise.resolve();
  }
  await ready;
}
async function query(sql2, args = []) {
  await ensureDb();
  const result = await getDb().execute({ sql: sql2, args });
  return result.rows;
}
async function run(sql2, args = []) {
  await ensureDb();
  return getDb().execute({ sql: sql2, args });
}
async function audit(action, entityType, entityId, metadata, adminOpenId) {
  await run("INSERT INTO audit_logs (action, entity_type, entity_id, metadata, created_at, admin_open_id) VALUES (?, ?, ?, ?, ?, ?)", [action, entityType, entityId, JSON.stringify(metadata ?? {}), Date.now(), adminOpenId ?? null]);
}
async function upsertUser(user) {
  if (!user.openId) return;
  if (ENV.tursoUrl || !ENV.databaseUrl || ENV.databaseUrl.startsWith("libsql")) {
    const now = Date.now();
    const role = user.openId === ENV.ownerOpenId ? "admin" : user.role ?? "user";
    await run("INSERT INTO users (open_id,name,email,login_method,role,created_at,updated_at,last_signed_in) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(open_id) DO UPDATE SET name=excluded.name,email=excluded.email,login_method=excluded.login_method,role=excluded.role,updated_at=excluded.updated_at,last_signed_in=excluded.last_signed_in", [user.openId, user.name ?? null, user.email ?? null, user.loginMethod ?? null, role, now, now, now]);
    return;
  }
  const db = drizzle(ENV.databaseUrl);
  await db.insert(users).values(user).onDuplicateKeyUpdate({ set: { name: user.name, email: user.email, lastSignedIn: /* @__PURE__ */ new Date() } });
}
async function getUserByOpenId(openId) {
  if (ENV.tursoUrl || !ENV.databaseUrl || ENV.databaseUrl.startsWith("libsql")) return (await query("SELECT id, open_id as openId, name, email, login_method as loginMethod, role, created_at as createdAt, updated_at as updatedAt, last_signed_in as lastSignedIn FROM users WHERE open_id=? LIMIT 1", [openId]))[0];
  const db = drizzle(ENV.databaseUrl);
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}
async function getCustomer(id) {
  return (await query("SELECT * FROM customers WHERE id = ? LIMIT 1", [id]))[0] ?? null;
}
async function getQrByCode(publicCode) {
  return (await query("SELECT q.*, c.business_name, c.phone, c.email, c.address, c.city, c.state, c.notes, c.google_review_url FROM qr_codes q LEFT JOIN customers c ON c.id = q.customer_id WHERE q.public_code = ? LIMIT 1", [publicCode]))[0] ?? null;
}
async function getLinks(customerId) {
  return query("SELECT * FROM links WHERE customer_id = ? ORDER BY position ASC, id ASC", [customerId]);
}

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req)
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client2) {
    this.client = client2;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    return decodeOAuthState(state).redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client2 = createOAuthHttpClient()) {
    this.client = client2;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    let sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken) {
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }
    const session = await this.verifySession(sessionToken);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
};
var CRON_OPEN_ID_PREFIX = "cron_";
function buildCronUser(userInfo) {
  const now = /* @__PURE__ */ new Date();
  return {
    id: -1,
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? void 0,
    isCron: true
  };
}
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app2) {
  app2.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    const { nonce } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader2(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/", secure: true, sameSite: "none" });
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/storageProxy.ts
function registerStorageProxy(app2) {
  app2.get("/manus-storage/*", async (req, res) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` }
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = await forgeResp.json();
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}

// server/routers.ts
import { TRPCError as TRPCError3 } from "@trpc/server";
import { z as z2 } from "zod";

// server/qr.ts
import { randomBytes } from "node:crypto";
var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generatePublicCode(length = 8) {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
function publicQrUrl(code) {
  return `${ENV.publicBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(code)}`;
}
function safeExternalUrl(value, allowed = ["https:", "http:"]) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return allowed.includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}
async function resolvePublicQr(publicCode, userAgent = "") {
  const qr = await getQrByCode(publicCode);
  if (!qr) return { kind: "NOT_FOUND" };
  if (qr.status === "STOCK" || qr.status === "RESERVED") return { kind: "NOT_CONFIGURED", qr };
  if (qr.status === "INACTIVE") return { kind: "INACTIVE", qr };
  await run("UPDATE qr_codes SET scan_count = scan_count + 1, last_scan_at = ?, updated_at = ? WHERE id = ?", [Date.now(), Date.now(), qr.id]);
  await run("INSERT INTO scan_events (qr_id, timestamp, user_agent) VALUES (?, ?, ?)", [qr.id, Date.now(), userAgent.slice(0, 240)]);
  return { kind: "ACTIVE", qr };
}

// server/_core/trpc.ts
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
import { TRPCError as TRPCError2 } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError2({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError2({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError2({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError2({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError2({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError2({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers.ts
var adminProcedure2 = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError3({ code: "FORBIDDEN", message: "Acesso restrito ao administrador." });
  return next();
});
var customerInput = z2.object({ businessName: z2.string().min(2), phone: z2.string().max(40).default(""), email: z2.string().email().optional().or(z2.literal("")), address: z2.string().optional(), city: z2.string().max(80).default(""), state: z2.string().max(2).default(""), notes: z2.string().optional(), googleReviewUrl: z2.string().optional() });
var linkInput = z2.object({ customerId: z2.number().int(), type: z2.string().min(2), label: z2.string().min(1), value: z2.string().min(1), icon: z2.string().default("link"), position: z2.number().int().default(0), enabled: z2.boolean().default(true) });
var appRouter = router({
  system: systemRouter,
  auth: router({ me: publicProcedure.query((opts) => opts.ctx.user), logout: publicProcedure.mutation(({ ctx }) => {
    ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
    return { success: true };
  }) }),
  public: router({ qr: publicProcedure.input(z2.object({ code: z2.string().min(6).max(20) })).query(async ({ input }) => getQrByCode(input.code)) }),
  admin: router({
    dashboard: adminProcedure2.query(async () => {
      const [counts, customers, recent] = await Promise.all([
        query("SELECT COUNT(*) total, SUM(status='ACTIVE') active, SUM(status='STOCK') stock, SUM(status='INACTIVE') inactive, COALESCE(SUM(scan_count),0) scans FROM qr_codes"),
        query("SELECT COUNT(*) total FROM customers"),
        query("SELECT a.*, q.serial_number, c.business_name FROM audit_logs a LEFT JOIN qr_codes q ON q.id = a.entity_id AND a.entity_type='qr_code' LEFT JOIN customers c ON c.id = q.customer_id ORDER BY a.created_at DESC LIMIT 8")
      ]);
      const now = Date.now();
      const today = (await query("SELECT COUNT(*) total FROM scan_events WHERE timestamp >= ?", [(/* @__PURE__ */ new Date()).setHours(0, 0, 0, 0)]))[0]?.total ?? 0;
      const last30 = (await query("SELECT COUNT(*) total FROM scan_events WHERE timestamp >= ?", [now - 30 * 864e5]))[0]?.total ?? 0;
      return { cards: { ...counts[0] ?? {}, customers: customers[0]?.total ?? 0, scansToday: today, scans30: last30 }, recent };
    }),
    customers: adminProcedure2.input(z2.object({ search: z2.string().optional() }).default({})).query(({ input }) => query("SELECT * FROM customers WHERE (? = '' OR business_name LIKE ? OR phone LIKE ?) ORDER BY created_at DESC", [input.search ?? "", `%${input.search ?? ""}%`, `%${input.search ?? ""}%`])),
    customer: adminProcedure2.input(z2.object({ id: z2.number() })).query(({ input }) => getCustomer(input.id)),
    createCustomer: adminProcedure2.input(customerInput).mutation(async ({ input, ctx }) => {
      const now = Date.now();
      const result = await run("INSERT INTO customers (business_name, phone, email, address, city, state, notes, google_review_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [input.businessName, input.phone, input.email || null, input.address || null, input.city, input.state.toUpperCase(), input.notes || null, safeExternalUrl(input.googleReviewUrl) || null, now, now]);
      const id = Number(result.lastInsertRowid);
      await audit("CUSTOMER_CREATED", "customer", id, input, ctx.user.openId);
      return { id };
    }),
    updateCustomer: adminProcedure2.input(customerInput.extend({ id: z2.number() })).mutation(async ({ input, ctx }) => {
      await run("UPDATE customers SET business_name=?, phone=?, email=?, address=?, city=?, state=?, notes=?, google_review_url=?, updated_at=? WHERE id=?", [input.businessName, input.phone, input.email || null, input.address || null, input.city, input.state.toUpperCase(), input.notes || null, safeExternalUrl(input.googleReviewUrl) || null, Date.now(), input.id]);
      await audit("CUSTOMER_UPDATED", "customer", input.id, input, ctx.user.openId);
      return { success: true };
    }),
    qrs: adminProcedure2.input(z2.object({ status: z2.string().optional(), search: z2.string().optional() }).default({})).query(({ input }) => query("SELECT q.*, c.business_name, c.phone FROM qr_codes q LEFT JOIN customers c ON c.id=q.customer_id WHERE (? = '' OR q.status=?) AND (? = '' OR CAST(q.serial_number AS TEXT) LIKE ? OR q.public_code LIKE ? OR c.business_name LIKE ? OR c.phone LIKE ?) ORDER BY q.serial_number ASC", [input.status ?? "", input.status ?? "", input.search ?? "", `%${input.search ?? ""}%`, `%${input.search ?? ""}%`, `%${input.search ?? ""}%`, `%${input.search ?? ""}%`])),
    createBatch: adminProcedure2.input(z2.object({ quantity: z2.number().int().min(1).max(500), startingSerial: z2.number().int().min(1) })).mutation(async ({ input, ctx }) => {
      const now = Date.now();
      const items = [];
      for (let i = 0; i < input.quantity; i++) {
        let code = generatePublicCode();
        while ((await query("SELECT id FROM qr_codes WHERE public_code=?", [code])).length) code = generatePublicCode();
        const serial = input.startingSerial + i;
        await run("INSERT INTO qr_codes (serial_number, public_code, status, mode, created_at, updated_at) VALUES (?, ?, 'STOCK', 'GOOGLE_REVIEW', ?, ?)", [serial, code, now, now]);
        items.push({ serial, code });
      }
      const batch = await run("INSERT INTO batches (batch_number, quantity, status, created_at, manifest_json) VALUES (COALESCE((SELECT MAX(batch_number)+1 FROM batches),1), ?, 'COMPLETED', ?, ?)", [items.length, now, JSON.stringify(items)]);
      await audit("BATCH_CREATED", "batch", Number(batch.lastInsertRowid), { quantity: items.length }, ctx.user.openId);
      return { batchId: Number(batch.lastInsertRowid), items };
    }),
    assignQr: adminProcedure2.input(z2.object({ qrId: z2.number(), customerId: z2.number(), mode: z2.enum(["GOOGLE_REVIEW", "LANDING_PAGE"]), destinationUrl: z2.string().optional() })).mutation(async ({ input, ctx }) => {
      const customer = await getCustomer(input.customerId);
      if (!customer) throw new TRPCError3({ code: "NOT_FOUND", message: "Cliente n\xE3o encontrado." });
      const destination = input.mode === "GOOGLE_REVIEW" ? safeExternalUrl(customer.google_review_url) : null;
      if (input.mode === "GOOGLE_REVIEW" && !destination) throw new TRPCError3({ code: "BAD_REQUEST", message: "Cadastre ou selecione o Google Review URL antes de ativar." });
      await run("UPDATE qr_codes SET customer_id=?, status='ACTIVE', mode=?, destination_url=?, reserved_at=COALESCE(reserved_at, ?), activated_at=?, updated_at=? WHERE id=? AND status IN ('STOCK','RESERVED')", [input.customerId, input.mode, destination || input.destinationUrl || null, Date.now(), Date.now(), Date.now(), input.qrId]);
      await audit("QR_ACTIVATED", "qr_code", input.qrId, input, ctx.user.openId);
      return { success: true };
    }),
    setQrStatus: adminProcedure2.input(z2.object({ id: z2.number(), status: z2.enum(["INACTIVE", "ACTIVE"]) })).mutation(async ({ input, ctx }) => {
      await run("UPDATE qr_codes SET status=?, updated_at=? WHERE id=?", [input.status, Date.now(), input.id]);
      await audit(input.status === "ACTIVE" ? "QR_ACTIVATED" : "QR_DEACTIVATED", "qr_code", input.id, input, ctx.user.openId);
      return { success: true };
    }),
    updateQr: adminProcedure2.input(z2.object({ id: z2.number(), mode: z2.enum(["GOOGLE_REVIEW", "LANDING_PAGE"]), destinationUrl: z2.string().optional() })).mutation(async ({ input, ctx }) => {
      const url = input.destinationUrl ? safeExternalUrl(input.destinationUrl) : null;
      await run("UPDATE qr_codes SET mode=?, destination_url=?, updated_at=? WHERE id=?", [input.mode, url, Date.now(), input.id]);
      await audit("DESTINATION_CHANGED", "qr_code", input.id, input, ctx.user.openId);
      return { success: true };
    }),
    links: adminProcedure2.input(z2.object({ customerId: z2.number() })).query(({ input }) => getLinks(input.customerId)),
    saveLink: adminProcedure2.input(linkInput.extend({ id: z2.number().optional() })).mutation(async ({ input, ctx }) => {
      if (input.id) await run("UPDATE links SET type=?, label=?, value=?, icon=?, position=?, enabled=?, updated_at=? WHERE id=?", [input.type, input.label, input.value, input.icon, input.position, input.enabled ? 1 : 0, Date.now(), input.id]);
      else await run("INSERT INTO links (customer_id,type,label,value,icon,position,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [input.customerId, input.type, input.label, input.value, input.icon, input.position, input.enabled ? 1 : 0, Date.now(), Date.now()]);
      await audit("LINKS_CHANGED", "customer", input.customerId, input, ctx.user.openId);
      return { success: true };
    }),
    audit: adminProcedure2.input(z2.object({ entityType: z2.string().optional(), entityId: z2.number().optional() }).default({})).query(({ input }) => query("SELECT * FROM audit_logs WHERE (? = '' OR entity_type = ?) AND (? IS NULL OR entity_id = ?) ORDER BY created_at DESC LIMIT 100", [input.entityType ?? "", input.entityType ?? "", input.entityId ?? null, input.entityId ?? null]))
  })
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/vite.ts
import express from "express";
import fs3 from "fs";
import { nanoid } from "nanoid";
import path3 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs2 from "node:fs";
import path2 from "node:path";
import { defineConfig } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path2.join(PROJECT_ROOT, ".manus-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs2.existsSync(LOG_DIR)) {
    fs2.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs2.existsSync(logPath) || fs2.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs2.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs2.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path2.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs2.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginManusDebugCollector() {
  return {
    name: "manus-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
var plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()];
var vite_config_default = defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path2.resolve(import.meta.dirname, "client", "src"),
      "@shared": path2.resolve(import.meta.dirname, "shared"),
      "@assets": path2.resolve(import.meta.dirname, "attached_assets")
    }
  },
  envDir: path2.resolve(import.meta.dirname),
  root: path2.resolve(import.meta.dirname, "client"),
  publicDir: path2.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path2.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1"
    ],
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/_core/vite.ts
async function setupVite(app2, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app2.use(vite.middlewares);
  app2.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path3.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs3.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app2) {
  const distPath = process.env.NODE_ENV === "development" ? path3.resolve(import.meta.dirname, "../..", "dist", "public") : path3.resolve(import.meta.dirname, "public");
  if (!fs3.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app2.use(express.static(distPath));
  app2.use("*", (_req, res) => {
    res.sendFile(path3.resolve(distPath, "index.html"));
  });
}

// server/artwork.ts
import QRCode from "qrcode";
import { ZipArchive } from "archiver";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { PassThrough } from "node:stream";
async function qrSvg(code) {
  return QRCode.toString(publicQrUrl(code), { type: "svg", errorCorrectionLevel: "H", margin: 4, width: 680 });
}
async function qrPng(code) {
  return QRCode.toBuffer(publicQrUrl(code), { type: "png", errorCorrectionLevel: "H", margin: 4, width: 1600 });
}
function posterSvg(serial, code) {
  const serialText = String(serial).padStart(6, "0");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600"><rect width="1200" height="1600" fill="#0e4b9b"/><circle cx="110" cy="110" r="34" fill="#ffd74b"/><circle cx="190" cy="110" r="34" fill="#ffd74b"/><circle cx="270" cy="110" r="34" fill="#ffd74b"/><circle cx="350" cy="110" r="34" fill="#ffd74b"/><circle cx="430" cy="110" r="34" fill="#ffd74b"/><text x="600" y="300" text-anchor="middle" fill="#ffd74b" font-family="Arial" font-size="88" font-weight="700">CONECTE-SE</text><text x="600" y="420" text-anchor="middle" fill="white" font-family="Arial" font-size="138" font-weight="800">CONOSCO</text><text x="600" y="520" text-anchor="middle" fill="white" font-family="Arial" font-size="36" letter-spacing="7">AVALIE \u2022 SIGA \u2022 ACOMPANHE</text><rect x="190" y="650" width="820" height="650" rx="42" fill="white"/><image href="data:image/svg+xml;base64,${Buffer.from("").toString("base64")}"/><text x="600" y="1380" text-anchor="middle" fill="white" font-family="Arial" font-size="34" letter-spacing="3">ESCANEIE O QR CODE</text><text x="600" y="1440" text-anchor="middle" fill="#ffd74b" font-family="Arial" font-size="30" letter-spacing="2">APROXIME O CELULAR \u2022 NFC</text><text x="1090" y="1530" text-anchor="end" fill="white" font-family="Arial" font-size="24">#${serialText} \xB7 ${code}</text></svg>`;
}
async function posterSvgWithQr(serial, code) {
  const qr = await qrSvg(code);
  const embedded = Buffer.from(qr).toString("base64");
  return posterSvg(serial, code).replace(`<image href="data:image/svg+xml;base64,${Buffer.from("").toString("base64")}"/>`, `<image x="230" y="690" width="740" height="570" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${embedded}"/>`);
}
async function posterPdf(items) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const item of items) {
    const page = pdf.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.055, 0.294, 0.608) });
    page.drawText("CONECTE-SE", { x: 170, y: 730, size: 34, font, color: rgb(1, 0.84, 0.29) });
    page.drawText("CONOSCO", { x: 175, y: 660, size: 42, font, color: rgb(1, 1, 1) });
    page.drawText(`QR #${String(item.serial).padStart(6, "0")} \xB7 ${item.code}`, { x: 80, y: 50, size: 12, font, color: rgb(1, 1, 1) });
  }
  return Buffer.from(await pdf.save());
}
async function zipFiles(files) {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise((resolve, reject) => {
    output.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
  });
  archive.pipe(output);
  for (const file of files) archive.append(file.data, { name: file.name });
  await archive.finalize();
  return done;
}

// server/_core/index.ts
var app = express2();
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}
async function findAvailablePort(startPort = 3e3) {
  for (let port = startPort; port < startPort + 20; port++) if (await isPortAvailable(port)) return port;
  throw new Error(`No available port found starting from ${startPort}`);
}
var escapeHtml = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
function publicHtml(title, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} \xB7 RSA Digital</title><style>body{margin:0;background:#eff5ff;color:#102a43;font-family:Arial,sans-serif;min-height:100vh;display:grid;place-items:center}.card{width:min(92vw,480px);background:#fff;border-radius:28px;padding:34px;box-shadow:0 18px 50px #174f9126;text-align:center}h1{margin:4px 0 10px;font-size:28px}.muted{color:#60758b;line-height:1.6}.links{display:grid;gap:12px;margin-top:26px}.links a,.links button{border:0;border-radius:14px;background:#0e4b9b;color:#fff;padding:15px;font-weight:700;text-decoration:none;font-size:15px;cursor:pointer}</style></head><body><main class="card">${body}</main></body></html>`;
}
function registerPublicRoutes() {
  app.get(/^\/([A-Z0-9]{6,20})$/, async (req, res, next) => {
    const code = req.params[0];
    try {
      const result = await resolvePublicQr(code, String(req.headers["user-agent"] ?? ""));
      if (result.kind === "NOT_FOUND") return res.status(404).send(publicHtml("C\xF3digo n\xE3o encontrado", '<h1>QR Code n\xE3o encontrado</h1><p class="muted">Confira o c\xF3digo impresso na placa.</p>'));
      if (result.kind === "NOT_CONFIGURED") return res.send(publicHtml("QR ainda n\xE3o configurado", '<h1>Este QR ainda n\xE3o foi configurado</h1><p class="muted">O c\xF3digo est\xE1 reservado para uma nova placa.</p>'));
      if (result.kind === "INACTIVE") return res.status(410).send(publicHtml("C\xF3digo indispon\xEDvel", '<h1>C\xF3digo indispon\xEDvel</h1><p class="muted">Este QR Code foi desativado.</p>'));
      const qr = result.qr;
      if (qr.mode === "GOOGLE_REVIEW" && qr.destination_url) return res.redirect(qr.destination_url);
      const links = qr.customer_id ? await getLinks(qr.customer_id) : [];
      const visible = links.filter((link) => Number(link.enabled));
      const buttons = visible.map((link) => link.type === "PIX" ? `<button onclick="navigator.clipboard.writeText('${escapeHtml(link.value)}');this.textContent='Chave Pix copiada'">${escapeHtml(link.label)}</button>` : `<a href="${escapeHtml(link.value)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join("");
      return res.send(publicHtml(qr.business_name || "RSA Digital", `<div style="width:76px;height:76px;border-radius:22px;background:#0e4b9b;color:#ffd74b;display:grid;place-items:center;margin:0 auto 18px;font-weight:900;font-size:22px">RSA</div><h1>${escapeHtml(qr.business_name || "Sua empresa")}</h1><p class="muted">Acesse os canais oficiais e deixe sua avalia\xE7\xE3o.</p><div class="links">${buttons}</div>`));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/artwork/:code.svg", async (req, res) => {
    const qr = await query("SELECT * FROM qr_codes WHERE public_code=? LIMIT 1", [req.params.code]);
    if (!qr[0]) return res.status(404).end();
    res.type("image/svg+xml").send(await posterSvgWithQr(qr[0].serial_number, qr[0].public_code));
  });
  app.get("/api/artwork/:code.png", async (req, res) => {
    const qr = await query("SELECT * FROM qr_codes WHERE public_code=? LIMIT 1", [req.params.code]);
    if (!qr[0]) return res.status(404).end();
    res.type("image/png").send(await qrPng(qr[0].public_code));
  });
  app.get("/api/artwork/:code.pdf", async (req, res) => {
    const qr = await query("SELECT * FROM qr_codes WHERE public_code=? LIMIT 1", [req.params.code]);
    if (!qr[0]) return res.status(404).end();
    res.type("application/pdf").send(await posterPdf([{ serial: qr[0].serial_number, code: qr[0].public_code }]));
  });
  app.get("/api/batches/:id.zip", async (req, res) => {
    const batch = (await query("SELECT * FROM batches WHERE id=?", [Number(req.params.id)]))[0];
    if (!batch) return res.status(404).end();
    const items = JSON.parse(batch.manifest_json);
    const files = await Promise.all(items.map(async (item) => ({ name: `QR-${String(item.serial).padStart(6, "0")}.svg`, data: await posterSvgWithQr(item.serial, item.code) })));
    res.type("application/zip").setHeader("Content-Disposition", `attachment; filename=QR-LOTE-${batch.batch_number}.zip`).send(await zipFiles(files));
  });
}
function configureApp() {
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerPublicRoutes();
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
}
configureApp();
async function startServer() {
  const server = createServer(app);
  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  server.listen(port, () => console.log(`Server running on http://localhost:${port}/`));
}
if (process.env.RUN_HTTP_SERVER === "1") startServer().catch(console.error);
export {
  app
};
