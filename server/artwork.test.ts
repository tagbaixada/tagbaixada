import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { batchArtworkFiles, posterPng, posterSvgWithQr } from "./artwork";
import { publicQrUrl } from "./qr";

describe("Etapa 5 — artes dinâmicas", () => {
  it("gera 5 SVG, 5 PNG, 5 PDF, ZIP e decodifica todos os QR PNGs", async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({ serial: 137 + index, code: `T5${index}A${index}B${index}C` }));
    const result = await batchArtworkFiles(items);
    expect(result.manifest).toHaveLength(5);
    expect(result.files.filter(file => file.name.includes("/SVG/")).length).toBe(5);
    expect(result.files.filter(file => file.name.includes("/PNG/")).length).toBe(5);
    expect(result.files.filter(file => file.name.includes("/PDF/")).length).toBe(5);
    expect(result.files.some(file => file.name.endsWith("manifest.json"))).toBe(true);

    for (const item of items) {
      const svg = await posterSvgWithQr(item.serial, item.code);
      expect(svg).toContain(`#${String(item.serial).padStart(6, "0")}`);
      expect(svg).toContain(publicQrUrl(item.code));
      const png = await posterPng(item.serial, item.code);
      const decoded = PNG.sync.read(png);
      const qr = jsQR(decoded.data, decoded.width, decoded.height, { inversionAttempts: "attemptBoth" });
      expect(qr?.data).toBe(publicQrUrl(item.code));
    }

    const zipPath = `/tmp/stage5-${Date.now()}.zip`;
    writeFileSync(zipPath, result.zip);
    const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).trim().split("\n");
    expect(entries.filter(name => name.includes("/SVG/")).length).toBe(5);
    expect(entries.filter(name => name.includes("/PNG/")).length).toBe(5);
    expect(entries.filter(name => name.includes("/PDF/")).length).toBe(5);
    expect(entries.some(name => name.endsWith("manifest.json"))).toBe(true);
    unlinkSync(zipPath);
  }, 120000);
});
