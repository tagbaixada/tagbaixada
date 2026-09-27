import { afterAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { getLinks, query, run } from "./db";
import type { TrpcContext } from "./_core/context";

const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const serial = 910000000 + Number(String(Date.now()).slice(-6));
let customerId = 0;
let linkIds: number[] = [];

function adminContext(): TrpcContext {
  return { user: { id: 1, openId: `stage6-test-${suffix}`, email: "stage6@example.com", name: "Stage 6 Test", loginMethod: "test", role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() }, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("Etapa 6 — landing page e links", () => {
  it("salva identidade, normaliza WhatsApp, preserva Wi-Fi e ordena links", async () => {
    const caller = appRouter.createCaller(adminContext());
    const customer = await caller.admin.createCustomer({ businessName: `Cliente Etapa 6 ${suffix}`, phone: `TEST-STAGE6-${suffix}`, email: "stage6@example.com", address: "Rua de teste", city: "Santos", state: "SP", notes: "TEST_STAGE6_REMOVE", googleReviewUrl: "https://example.com/review", description: "Descrição pública", logoUrl: "https://example.com/logo.png", allowDuplicate: false });
    customerId = customer.id;
    await caller.admin.saveLink({ customerId, type: "WHATSAPP", label: "Fale conosco no WhatsApp", value: JSON.stringify({ phone: "+55 (13) 99999-9999", message: "Olá, vim pelo QR" }), icon: "whatsapp", position: 0, enabled: true });
    await caller.admin.saveLink({ customerId, type: "WIFI", label: "Wi-Fi", value: JSON.stringify({ ssid: "RSA\"Guest", password: "senha;123", security: "WPA2" }), icon: "wifi", position: 1, enabled: false });
    await caller.admin.saveLink({ customerId, type: "SITE", label: "Visite nosso site", value: "https://example.com", icon: "globe", position: 2, enabled: true });
    const links = await getLinks(customerId);
    linkIds = links.map(link => Number(link.id));
    const waId = Number(links.find(link => link.type === "WHATSAPP")?.id);
    const wifiId = Number(links.find(link => link.type === "WIFI")?.id);
    const siteId = Number(links.find(link => link.type === "SITE")?.id);
    expect(links.find(link => link.type === "WHATSAPP")?.value).toBe("https://wa.me/5513999999999?text=Ol%C3%A1%2C%20vim%20pelo%20QR");
    expect(JSON.parse(links.find(link => link.type === "WIFI")?.value).ssid).toBe("RSA\"Guest");
    await caller.admin.reorderLinks({ customerId, ids: [siteId, waId, wifiId] });
    expect((await getLinks(customerId)).map(link => Number(link.id))).toEqual([siteId, waId, wifiId]);
    await caller.admin.deleteLink({ customerId, id: wifiId });
    expect((await getLinks(customerId)).some(link => Number(link.id) === wifiId)).toBe(false);
  }, 30000);
  it("rejeita URL javascript e tipo desconhecido", async () => {
    const caller = appRouter.createCaller(adminContext());
    await expect(caller.admin.saveLink({ customerId, type: "SITE", label: "Inválido", value: "javascript:alert(1)", icon: "link", position: 0, enabled: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.admin.saveLink({ customerId, type: "UNKNOWN", label: "Inválido", value: "x", icon: "link", position: 0, enabled: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

afterAll(async () => {
  if (linkIds.length) await run(`DELETE FROM links WHERE id IN (${linkIds.map(() => "?").join(",")})`, linkIds);
  if (customerId) { await run("DELETE FROM audit_logs WHERE entity_type='customer' AND entity_id=?", [customerId]); await run("DELETE FROM customers WHERE id=?", [customerId]); }
  await query("SELECT 1");
});
