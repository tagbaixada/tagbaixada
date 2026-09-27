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
  if (ctx.user.role !== "admin") {
    throw new TRPCError3({ code: "FORBIDDEN", message: "Acesso restrito ao administrador." });
  }
  return next();
});
var statusSchema = z2.enum(["STOCK", "RESERVED", "ACTIVE", "INACTIVE"]);
var modeSchema = z2.enum(["GOOGLE_REVIEW", "LANDING_PAGE"]);
var customerInput = z2.object({
  businessName: z2.string().trim().min(2).max(180),
  phone: z2.string().trim().max(40).default(""),
  email: z2.string().trim().email().optional().or(z2.literal("")),
  address: z2.string().trim().max(240).optional().or(z2.literal("")),
  city: z2.string().trim().max(80).default(""),
  state: z2.string().trim().max(2).default(""),
  notes: z2.string().trim().max(2e3).optional().or(z2.literal("")),
  googleReviewUrl: z2.string().trim().optional().or(z2.literal(""))
});
var linkInput = z2.object({
  customerId: z2.number().int().positive(),
  type: z2.string().trim().min(2).max(40),
  label: z2.string().trim().min(1).max(100),
  value: z2.string().trim().min(1).max(1e3),
  icon: z2.string().trim().max(40).default("link"),
  position: z2.number().int().min(0).default(0),
  enabled: z2.boolean().default(true)
});
function invalidUrl(message = "Informe uma URL HTTP ou HTTPS v\xE1lida.") {
  throw new TRPCError3({ code: "BAD_REQUEST", message });
}
function requireUrl(value, message) {
  const safe = safeExternalUrl(value);
  if (!safe) invalidUrl(message);
  return safe;
}
function validateLinkValue(type, value) {
  if (/^(javascript|data|vbscript):/i.test(value.trim())) invalidUrl("Links javascript:, data: e vbscript: n\xE3o s\xE3o permitidos.");
  if (["SITE", "INSTAGRAM", "WHATSAPP", "GOOGLE_REVIEW"].includes(type)) return requireUrl(value);
  return value;
}
async function getQr(id) {
  const rows = await query(
    "SELECT q.*, c.business_name, c.phone, c.email, c.address, c.city, c.state, c.notes, c.google_review_url FROM qr_codes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.id=? LIMIT 1",
    [id]
  );
  return rows[0] ?? null;
}
async function ensureQrForCustomer(id) {
  const qr = await getQr(id);
  if (!qr) throw new TRPCError3({ code: "NOT_FOUND", message: "QR Code n\xE3o encontrado." });
  if (!qr.customer_id) throw new TRPCError3({ code: "BAD_REQUEST", message: "Associe um cliente antes de continuar." });
  return qr;
}
async function validateActivation(qr) {
  if (!qr.customer_id) throw new TRPCError3({ code: "BAD_REQUEST", message: "O QR precisa de um cliente." });
  if (!qr.mode) throw new TRPCError3({ code: "BAD_REQUEST", message: "Escolha o modo do QR." });
  if (qr.mode === "GOOGLE_REVIEW") {
    const destination = requireUrl(qr.google_review_url);
    return destination;
  }
  return null;
}
async function activateQrFor(id, ctx) {
  const qr = await ensureQrForCustomer(id);
  if (!["RESERVED", "INACTIVE"].includes(qr.status)) throw new TRPCError3({ code: "CONFLICT", message: "O QR precisa estar reservado ou inativo para ser ativado." });
  const destination = await validateActivation(qr);
  await run("UPDATE qr_codes SET status='ACTIVE', destination_url=?, activated_at=?, updated_at=? WHERE id=? AND status IN ('RESERVED','INACTIVE')", [destination, Date.now(), Date.now(), id]);
  await audit("QR_ACTIVATED", "qr_code", id, { mode: qr.mode, destination }, ctx.user.openId);
  return { success: true };
}
async function deactivateQrFor(id, ctx) {
  const qr = await getQr(id);
  if (!qr) throw new TRPCError3({ code: "NOT_FOUND", message: "QR Code n\xE3o encontrado." });
  if (qr.status !== "ACTIVE") throw new TRPCError3({ code: "CONFLICT", message: "Somente QR Codes ativos podem ser desativados." });
  await run("UPDATE qr_codes SET status='INACTIVE', updated_at=? WHERE id=? AND status='ACTIVE'", [Date.now(), id]);
  await audit("QR_DEACTIVATED", "qr_code", id, { from: "ACTIVE", to: "INACTIVE" }, ctx.user.openId);
  return { success: true };
}
async function configureQrFor(id, mode, ctx) {
  const qr = await ensureQrForCustomer(id);
  if (!["RESERVED", "ACTIVE"].includes(qr.status)) throw new TRPCError3({ code: "CONFLICT", message: "Reserve o QR antes de configurar o destino." });
  const destination = mode === "GOOGLE_REVIEW" ? requireUrl(qr.google_review_url, "Cadastre uma URL manual de avalia\xE7\xE3o do Google para este cliente.") : null;
  await run("UPDATE qr_codes SET mode=?, destination_url=?, updated_at=? WHERE id=?", [mode, destination, Date.now(), id]);
  await audit("DESTINATION_CHANGED", "qr_code", id, { mode, destination }, ctx.user.openId);
  return { success: true };
}
var appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
      return { success: true };
    })
  }),
  public: router({
    qr: publicProcedure.input(z2.object({ code: z2.string().min(6).max(20) })).query(async ({ input }) => {
      const qr = await getQrByCode(input.code);
      return qr ? { publicCode: qr.public_code, status: qr.status, mode: qr.mode, publicUrl: publicQrUrl(qr.public_code) } : null;
    })
  }),
  admin: router({
    dashboard: adminProcedure2.query(async () => {
      const counts = (await query(
        "SELECT COUNT(*) total, SUM(status='ACTIVE') active, SUM(status='STOCK') stock, SUM(status='RESERVED') reserved, SUM(status='INACTIVE') inactive, COALESCE(SUM(scan_count),0) scans FROM qr_codes"
      ))[0] ?? {};
      const customers = (await query("SELECT COUNT(*) total FROM customers"))[0] ?? {};
      const todayStart = /* @__PURE__ */ new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const today = (await query("SELECT COUNT(*) total FROM scan_events WHERE timestamp >= ?", [todayStart.getTime()]))[0]?.total ?? 0;
      const last30 = (await query("SELECT COUNT(*) total FROM scan_events WHERE timestamp >= ?", [Date.now() - 30 * 864e5]))[0]?.total ?? 0;
      const recent = await query("SELECT a.*, q.serial_number, c.business_name FROM audit_logs a LEFT JOIN qr_codes q ON q.id=a.entity_id AND a.entity_type='qr_code' LEFT JOIN customers c ON c.id=q.customer_id ORDER BY a.created_at DESC LIMIT 8");
      return { cards: { ...counts, customers: customers.total ?? 0, scansToday: today, scans30: last30 }, recent };
    }),
    customers: adminProcedure2.input(z2.object({ search: z2.string().trim().default(""), page: z2.number().int().min(1).default(1), pageSize: z2.number().int().min(1).max(100).default(25) })).query(async ({ input }) => {
      const offset = (input.page - 1) * input.pageSize;
      const like = `%${input.search}%`;
      const where = input.search ? "WHERE business_name LIKE ? OR phone LIKE ?" : "";
      const args = input.search ? [like, like] : [];
      const total = (await query(`SELECT COUNT(*) total FROM customers ${where}`, args))[0]?.total ?? 0;
      const items = await query(`SELECT * FROM customers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...args, input.pageSize, offset]);
      return { items, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),
    customer: adminProcedure2.input(z2.object({ id: z2.number().int().positive() })).query(({ input }) => getCustomer(input.id)),
    createCustomer: adminProcedure2.input(customerInput.extend({ allowDuplicate: z2.boolean().default(false) })).mutation(async ({ input, ctx }) => {
      if (input.phone && !input.allowDuplicate) {
        const duplicate = (await query("SELECT id, business_name FROM customers WHERE phone=? LIMIT 1", [input.phone]))[0];
        if (duplicate) throw new TRPCError3({ code: "CONFLICT", message: `J\xE1 existe um cliente com este telefone: ${duplicate.business_name}. Confirme novamente para criar mesmo assim.` });
      }
      const now = Date.now();
      const review = input.googleReviewUrl ? requireUrl(input.googleReviewUrl) : null;
      const result = await run("INSERT INTO customers (business_name, phone, email, address, city, state, notes, google_review_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [input.businessName, input.phone, input.email || null, input.address || null, input.city, input.state.toUpperCase(), input.notes || null, review, now, now]);
      const id = Number(result.lastInsertRowid);
      await audit("CUSTOMER_CREATED", "customer", id, { businessName: input.businessName, phone: input.phone }, ctx.user.openId);
      return { id };
    }),
    updateCustomer: adminProcedure2.input(customerInput.extend({ id: z2.number().int().positive() })).mutation(async ({ input, ctx }) => {
      if (input.phone) {
        const duplicate = (await query("SELECT id, business_name FROM customers WHERE phone=? AND id<>? LIMIT 1", [input.phone, input.id]))[0];
        if (duplicate) throw new TRPCError3({ code: "CONFLICT", message: `Este telefone j\xE1 pertence a ${duplicate.business_name}.` });
      }
      const review = input.googleReviewUrl ? requireUrl(input.googleReviewUrl) : null;
      await run("UPDATE customers SET business_name=?, phone=?, email=?, address=?, city=?, state=?, notes=?, google_review_url=?, updated_at=? WHERE id=?", [input.businessName, input.phone, input.email || null, input.address || null, input.city, input.state.toUpperCase(), input.notes || null, review, Date.now(), input.id]);
      await audit("CUSTOMER_UPDATED", "customer", input.id, { businessName: input.businessName, phone: input.phone }, ctx.user.openId);
      return { success: true };
    }),
    qrs: adminProcedure2.input(z2.object({ status: z2.string().trim().default(""), search: z2.string().trim().default(""), page: z2.number().int().min(1).default(1), pageSize: z2.number().int().min(1).max(100).default(25) })).query(async ({ input }) => {
      const offset = (input.page - 1) * input.pageSize;
      const conditions = [];
      const args = [];
      if (input.status) {
        statusSchema.parse(input.status);
        conditions.push("q.status=?");
        args.push(input.status);
      }
      if (input.search) {
        const like = `%${input.search}%`;
        conditions.push("(CAST(q.serial_number AS TEXT) LIKE ? OR q.public_code LIKE ? OR c.business_name LIKE ? OR c.phone LIKE ?)");
        args.push(like, like, like, like);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const total = (await query(`SELECT COUNT(*) total FROM qr_codes q LEFT JOIN customers c ON c.id=q.customer_id ${where}`, args))[0]?.total ?? 0;
      const items = await query(`SELECT q.*, c.business_name, c.phone FROM qr_codes q LEFT JOIN customers c ON c.id=q.customer_id ${where} ORDER BY q.serial_number ASC LIMIT ? OFFSET ?`, [...args, input.pageSize, offset]);
      return { items, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),
    qr: adminProcedure2.input(z2.object({ id: z2.number().int().positive() })).query(async ({ input }) => {
      const qr = await getQr(input.id);
      if (!qr) throw new TRPCError3({ code: "NOT_FOUND", message: "QR Code n\xE3o encontrado." });
      return { ...qr, public_url: publicQrUrl(qr.public_code), links: qr.customer_id ? await getLinks(qr.customer_id) : [] };
    }),
    createBatch: adminProcedure2.input(z2.object({ quantity: z2.number().int().min(1).max(500), startingSerial: z2.number().int().min(1) })).mutation(async ({ input, ctx }) => {
      const serials = Array.from({ length: input.quantity }, (_, index) => input.startingSerial + index);
      const placeholders = serials.map(() => "?").join(",");
      const duplicate = await query(`SELECT serial_number FROM qr_codes WHERE serial_number IN (${placeholders}) LIMIT 1`, serials);
      if (duplicate.length) throw new TRPCError3({ code: "CONFLICT", message: `O serial ${String(duplicate[0].serial_number).padStart(6, "0")} j\xE1 existe.` });
      const items = [];
      for (const serial of serials) {
        let code = generatePublicCode();
        while ((await query("SELECT id FROM qr_codes WHERE public_code=?", [code])).length) code = generatePublicCode();
        items.push({ serial, code });
      }
      const now = Date.now();
      const statements = items.map((item) => ({ sql: "INSERT INTO qr_codes (serial_number, public_code, status, mode, created_at, updated_at) VALUES (?, ?, 'STOCK', 'GOOGLE_REVIEW', ?, ?)", args: [item.serial, item.code, now, now] }));
      statements.push({ sql: "INSERT INTO batches (batch_number, quantity, status, created_at, manifest_json) VALUES (COALESCE((SELECT MAX(batch_number)+1 FROM batches),1), ?, 'COMPLETED', ?, ?)", args: [items.length, now, JSON.stringify(items)] });
      const results = await getDb().batch(statements);
      const batchId = Number(results[items.length]?.lastInsertRowid ?? 0);
      await audit("BATCH_CREATED", "batch", batchId, { quantity: items.length, firstSerial: serials[0], lastSerial: serials[serials.length - 1] }, ctx.user.openId);
      for (let index = 0; index < items.length; index += 1) await audit("QR_CREATED", "qr_code", Number(results[index]?.lastInsertRowid ?? 0) || null, items[index], ctx.user.openId);
      return { batchId, requested: input.quantity, created: items.length, errors: 0, firstSerial: serials[0], lastSerial: serials[serials.length - 1], items };
    }),
    reserveQr: adminProcedure2.input(z2.object({ id: z2.number().int().positive() })).mutation(async ({ input, ctx }) => {
      const qr = await getQr(input.id);
      if (!qr) throw new TRPCError3({ code: "NOT_FOUND", message: "QR Code n\xE3o encontrado." });
      if (qr.status !== "STOCK") throw new TRPCError3({ code: "CONFLICT", message: "Somente QR Codes em estoque podem ser reservados." });
      await run("UPDATE qr_codes SET status='RESERVED', reserved_at=?, updated_at=? WHERE id=? AND status='STOCK'", [Date.now(), Date.now(), input.id]);
      await audit("QR_RESERVED", "qr_code", input.id, { from: "STOCK", to: "RESERVED" }, ctx.user.openId);
      return { success: true };
    }),
    assignQrCustomer: adminProcedure2.input(z2.object({ id: z2.number().int().positive(), customerId: z2.number().int().positive() })).mutation(async ({ input, ctx }) => {
      const qr = await getQr(input.id);
      if (!qr) throw new TRPCError3({ code: "NOT_FOUND", message: "QR Code n\xE3o encontrado." });
      if (!["STOCK", "RESERVED"].includes(qr.status)) throw new TRPCError3({ code: "CONFLICT", message: "A associa\xE7\xE3o s\xF3 pode ser alterada antes da ativa\xE7\xE3o." });
      if (!await getCustomer(input.customerId)) throw new TRPCError3({ code: "NOT_FOUND", message: "Cliente n\xE3o encontrado." });
      await run("UPDATE qr_codes SET customer_id=?, updated_at=? WHERE id=? AND status IN ('STOCK','RESERVED')", [input.customerId, Date.now(), input.id]);
      await audit(qr.customer_id ? "QR_CUSTOMER_CHANGED" : "QR_CUSTOMER_ASSIGNED", "qr_code", input.id, { fromCustomerId: qr.customer_id, toCustomerId: input.customerId }, ctx.user.openId);
      return { success: true };
    }),
    configureQr: adminProcedure2.input(z2.object({ id: z2.number().int().positive(), mode: modeSchema })).mutation(async ({ input, ctx }) => {
      const qr = await ensureQrForCustomer(input.id);
      if (!["RESERVED", "ACTIVE"].includes(qr.status)) throw new TRPCError3({ code: "CONFLICT", message: "Reserve o QR antes de configurar o destino." });
      let destination = null;
      if (input.mode === "GOOGLE_REVIEW") destination = requireUrl(qr.google_review_url, "Cadastre uma URL manual de avalia\xE7\xE3o do Google para este cliente.");
      await run("UPDATE qr_codes SET mode=?, destination_url=?, updated_at=? WHERE id=?", [input.mode, destination, Date.now(), input.id]);
      await audit("DESTINATION_CHANGED", "qr_code", input.id, { mode: input.mode, destination }, ctx.user.openId);
      return { success: true };
    }),
    activateQr: adminProcedure2.input(z2.object({ id: z2.number().int().positive() })).mutation(({ input, ctx }) => activateQrFor(input.id, ctx)),
    deactivateQr: adminProcedure2.input(z2.object({ id: z2.number().int().positive() })).mutation(({ input, ctx }) => deactivateQrFor(input.id, ctx)),
    setQrStatus: adminProcedure2.input(z2.object({ id: z2.number().int().positive(), status: z2.enum(["ACTIVE", "INACTIVE"]) })).mutation(async ({ input, ctx }) => {
      return input.status === "ACTIVE" ? activateQrFor(input.id, ctx) : deactivateQrFor(input.id, ctx);
    }),
    updateQr: adminProcedure2.input(z2.object({ id: z2.number().int().positive(), mode: modeSchema })).mutation(async ({ input, ctx }) => {
      return configureQrFor(input.id, input.mode, ctx);
    }),
    links: adminProcedure2.input(z2.object({ customerId: z2.number().int().positive() })).query(({ input }) => getLinks(input.customerId)),
    saveLink: adminProcedure2.input(linkInput.extend({ id: z2.number().int().positive().optional() })).mutation(async ({ input, ctx }) => {
      const value = validateLinkValue(input.type, input.value);
      if (input.id) await run("UPDATE links SET type=?, label=?, value=?, icon=?, position=?, enabled=?, updated_at=? WHERE id=? AND customer_id=?", [input.type, input.label, value, input.icon, input.position, input.enabled ? 1 : 0, Date.now(), input.id, input.customerId]);
      else await run("INSERT INTO links (customer_id,type,label,value,icon,position,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [input.customerId, input.type, input.label, value, input.icon, input.position, input.enabled ? 1 : 0, Date.now(), Date.now()]);
      await audit("LINKS_CHANGED", "customer", input.customerId, input, ctx.user.openId);
      return { success: true };
    }),
    audit: adminProcedure2.input(z2.object({ entityType: z2.string().optional(), entityId: z2.number().optional() }).default({})).query(({ input }) => query("SELECT * FROM audit_logs WHERE (? = '' OR entity_type=?) AND (? IS NULL OR entity_id=?) ORDER BY created_at DESC LIMIT 100", [input.entityType ?? "", input.entityType ?? "", input.entityId ?? null, input.entityId ?? null]))
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
import fs2 from "fs";
import { nanoid } from "nanoid";
import path2 from "path";
var loadModule = new Function(
  "modulePath",
  "return import(modulePath)"
);
async function setupVite(app2, server) {
  const [{ createServer: createViteServer }, { default: viteConfig }] = await Promise.all([
    loadModule("vite"),
    loadModule("../../vite.config")
  ]);
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app2.use(vite.middlewares);
  app2.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs2.promises.readFile(clientTemplate, "utf-8");
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
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs2.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app2.use(express.static(distPath));
  app2.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
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
      if (result.kind === "NOT_CONFIGURED") return res.status(409).send(publicHtml(result.qr.status === "STOCK" ? "QR em estoque" : "QR reservado", `<h1>${result.qr.status === "STOCK" ? "Este QR ainda est\xE1 em estoque" : "Este QR ainda n\xE3o est\xE1 ativo"}</h1><p class="muted">O c\xF3digo ainda n\xE3o est\xE1 dispon\xEDvel para o p\xFAblico.</p>`));
      if (result.kind === "INACTIVE") return res.status(410).send(publicHtml("C\xF3digo indispon\xEDvel", '<h1>C\xF3digo indispon\xEDvel</h1><p class="muted">Este QR Code foi desativado.</p>'));
      const qr = result.qr;
      const reviewUrl = safeExternalUrl(qr.google_review_url) || qr.destination_url;
      if (qr.mode === "GOOGLE_REVIEW" && reviewUrl) return res.redirect(reviewUrl);
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
