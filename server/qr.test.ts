import { describe, expect, it } from "vitest";
import { generatePublicCode, publicQrUrl, safeExternalUrl } from "./qr";

describe("permanent QR resolver primitives", () => {
  it("generates an opaque code with the expected alphabet and length", () => {
    const code = generatePublicCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(code).not.toMatch(/0|1|I|O/);
  });
  it("keeps the public URL independent from internal database ids", () => {
    expect(publicQrUrl("A7K92X4M")).toContain("/A7K92X4M");
    expect(publicQrUrl("A7K92X4M")).not.toContain("?id=");
  });
  it("rejects dangerous URL schemes", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,hello")).toBeNull();
    expect(safeExternalUrl("https://example.com/review")).toBe("https://example.com/review");
  });
});
