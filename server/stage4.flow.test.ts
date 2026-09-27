import { afterAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { query, run } from "./db";
import { resolvePublicQr } from "./qr";
import type { TrpcContext } from "./_core/context";

const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const testPhone = `TEST-STAGE4-${suffix}`;
const testSerial = 900000000 + Number(String(Date.now()).slice(-6));
let customerId = 0;
let qrIds: number[] = [];
let batchId = 0;

function adminContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: `stage4-test-${suffix}`,
      email: "stage4-test@example.com",
      name: "Stage 4 Test",
      loginMethod: "test",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("Etapa 4 — fluxo operacional completo", () => {
  it("executa QR → estoque → reserva → cliente → destino → ativo → scan → troca → inativo", async () => {
    const caller = appRouter.createCaller(adminContext());
    const createdCustomer = await caller.admin.createCustomer({
      businessName: `Cliente temporário Etapa 4 ${suffix}`,
      phone: testPhone,
      email: "stage4-test@example.com",
      address: "Rua de teste",
      city: "Santos",
      state: "SP",
      notes: "TEST_STAGE4_REMOVE",
      googleReviewUrl: "https://example.com/review/one",
      allowDuplicate: false,
    });
    customerId = createdCustomer.id;

    const batch = await caller.admin.createBatch({ quantity: 3, startingSerial: testSerial });
    batchId = batch.batchId;
    expect(batch.created).toBe(3);
    expect(new Set(batch.items.map(item => item.serial)).size).toBe(3);
    expect(new Set(batch.items.map(item => item.code)).size).toBe(3);

    const rows = await query<any>("SELECT id, serial_number, public_code, status FROM qr_codes WHERE serial_number BETWEEN ? AND ? ORDER BY serial_number", [testSerial, testSerial + 2]);
    qrIds = rows.map(row => Number(row.id));
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.status === "STOCK")).toBe(true);

    const qrId = qrIds[0];
    await caller.admin.reserveQr({ id: qrId });
    expect((await caller.admin.qr({ id: qrId })).status).toBe("RESERVED");
    await caller.admin.assignQrCustomer({ id: qrId, customerId });
    await caller.admin.configureQr({ id: qrId, mode: "GOOGLE_REVIEW" });
    await caller.admin.activateQr({ id: qrId });

    const active = await resolvePublicQr(rows[0].public_code, "Stage4 test");
    expect(active.kind).toBe("ACTIVE");
    expect((active as any).qr.google_review_url).toBe("https://example.com/review/one");

    await caller.admin.updateCustomer({
      id: customerId,
      businessName: `Cliente temporário Etapa 4 ${suffix}`,
      phone: testPhone,
      email: "stage4-test@example.com",
      address: "Rua de teste",
      city: "Santos",
      state: "SP",
      notes: "TEST_STAGE4_REMOVE",
      googleReviewUrl: "https://example.com/review/two",
    });
    const changed = await resolvePublicQr(rows[0].public_code, "Stage4 test");
    expect(changed.kind).toBe("ACTIVE");
    expect((changed as any).qr.google_review_url).toBe("https://example.com/review/two");

    const counters = (await query<any>("SELECT scan_count FROM qr_codes WHERE id=?", [qrId]))[0];
    expect(Number(counters.scan_count)).toBe(2);
    expect(Number((await query<any>("SELECT COUNT(*) total FROM scan_events WHERE qr_id=?", [qrId]))[0].total)).toBe(2);
    expect(Number((await query<any>("SELECT COUNT(*) total FROM audit_logs WHERE entity_type='qr_code' AND entity_id=?", [qrId]))[0].total)).toBeGreaterThanOrEqual(5);

    await caller.admin.deactivateQr({ id: qrId });
    const inactive = await resolvePublicQr(rows[0].public_code, "Stage4 test");
    expect(inactive.kind).toBe("INACTIVE");
  }, 120000);

  afterAll(async () => {
    if (qrIds.length) {
      const placeholders = qrIds.map(() => "?").join(",");
      await run(`DELETE FROM scan_events WHERE qr_id IN (${placeholders})`, qrIds);
      await run(`DELETE FROM audit_logs WHERE entity_type='qr_code' AND entity_id IN (${placeholders})`, qrIds);
      await run(`DELETE FROM qr_codes WHERE id IN (${placeholders})`, qrIds);
    }
    if (batchId) {
      await run("DELETE FROM audit_logs WHERE entity_type='batch' AND entity_id=?", [batchId]);
      await run("DELETE FROM batches WHERE id=?", [batchId]);
    }
    if (customerId) {
      await run("DELETE FROM audit_logs WHERE entity_type='customer' AND entity_id=?", [customerId]);
      await run("DELETE FROM customers WHERE id=?", [customerId]);
    }
  }, 60000);
});
