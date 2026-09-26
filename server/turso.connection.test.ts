import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";

describe("Turso connection", () => {
  it("accepts the configured URL and auth token", async () => {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    expect(url, "TURSO_DATABASE_URL must be configured").toMatch(/^libsql:\/\//);
    expect(authToken, "TURSO_AUTH_TOKEN must be configured").toBeTruthy();
    const client = createClient({ url: url!, authToken });
    const result = await client.execute("select 1 as ok");
    expect(result.rows[0]?.ok).toBe(1);
    client.close();
  }, 30000);
});
