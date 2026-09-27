import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { jwtVerify, SignJWT } from "jose";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ENV } from "./env";
import { getSessionCookieOptions } from "./cookies";
import * as db from "../db";
import type { Request, Response } from "express";

const scrypt = promisify(scryptCallback);
const PASSWORD_PREFIX = "scrypt";
const KEY_LENGTH = 64;

function secretKey() {
  if (!ENV.cookieSecret || ENV.cookieSecret.length < 32) throw new Error("JWT_SECRET is not configured");
  return new TextEncoder().encode(ENV.cookieSecret);
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${PASSWORD_PREFIX}$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string | null | undefined) {
  if (!encoded) return false;
  const [prefix, salt, expectedHex] = encoded.split("$");
  if (prefix !== PASSWORD_PREFIX || !salt || !expectedHex || expectedHex.length !== KEY_LENGTH * 2) return false;
  const actual = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export async function createLocalSession(openId: string, name: string) {
  return new SignJWT({ openId, appId: "local", name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor((Date.now() + ONE_YEAR_MS) / 1000))
    .sign(secretKey());
}

export async function authenticateLocalRequest(req: Request) {
  const cookies = req.headers.cookie ?? "";
  const match = cookies.match(/(?:^|;\s*)app_session_id=([^;]+)/);
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  const token = match ? decodeURIComponent(match[1]) : bearer;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    const openId = typeof payload.openId === "string" ? payload.openId : "";
    if (!openId.startsWith("local:")) return null;
    return (await db.getUserByOpenId(openId)) ?? null;
  } catch {
    return null;
  }
}

export async function setLocalSession(res: Response, req: Request, openId: string, name: string) {
  const token = await createLocalSession(openId, name);
  res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
}
