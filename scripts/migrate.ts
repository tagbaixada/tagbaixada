import "dotenv/config";
import { createClient } from "@libsql/client";
import fs from "node:fs";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error("TURSO_DATABASE_URL is required");
const client = createClient({ url, authToken });
const migration = fs.readFileSync(new URL("../drizzle/0001_rsa_qr.sql", import.meta.url), "utf8");
await client.executeMultiple(migration);
console.log("Turso migration applied: 0001_rsa_qr.sql");
client.close();
