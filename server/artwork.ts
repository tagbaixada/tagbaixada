import QRCode from "qrcode";
import { ZipArchive } from "archiver";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { PassThrough } from "node:stream";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { publicQrUrl } from "./qr";
import { ART_TEMPLATE_JPEG_BASE64 } from "./art-template";

export const ART_WIDTH = 1024;
export const ART_HEIGHT = 1024;
export const ART_TEMPLATE_NAME = "RSA Digital — Conecte-se conosco";

function serialText(serial: number) {
  return String(serial).padStart(6, "0");
}

export async function qrSvg(code: string) {
  return QRCode.toString(publicQrUrl(code), { type: "svg", errorCorrectionLevel: "H", margin: 4, width: 640 });
}

export async function qrPng(code: string) {
  return QRCode.toBuffer(publicQrUrl(code), { type: "png", errorCorrectionLevel: "H", margin: 4, width: 1600 });
}

/**
 * The supplied JPEG is preserved as the visual base. The prototype QR area is
 * covered with white and replaced by the dynamic vector QR below.
 */
export async function posterSvgWithQr(serial: number, code: string) {
  const qr = await qrSvg(code);
  const qrBase64 = Buffer.from(qr).toString("base64");
  const serialLabel = `#${serialText(serial)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${ART_WIDTH}" height="${ART_HEIGHT}" viewBox="0 0 ${ART_WIDTH} ${ART_HEIGHT}">
  <title>${ART_TEMPLATE_NAME} — ${serialLabel}</title>
  <desc>serial=${serialText(serial)} public_code=${code} url=${publicQrUrl(code)}</desc>
  <image x="0" y="0" width="1024" height="1024" preserveAspectRatio="none" href="data:image/jpeg;base64,${ART_TEMPLATE_JPEG_BASE64}"/>
  <rect x="510" y="684" width="264" height="234" rx="18" fill="#ffffff"/>
  <image x="532" y="698" width="220" height="220" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${qrBase64}"/>
  <text x="765" y="906" text-anchor="middle" fill="#102a43" font-family="Arial, sans-serif" font-size="18" font-weight="700">${serialLabel}</text>
</svg>`;
}

export async function posterPng(serial: number, code: string) {
  const qr = await QRCode.toBuffer(publicQrUrl(code), { type: "png", errorCorrectionLevel: "H", margin: 4, width: 640 });
  const qrBase64 = qr.toString("base64");
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="510" y="684" width="264" height="234" rx="18" fill="white"/><image x="532" y="698" width="220" height="220" href="data:image/png;base64,${qrBase64}"/><text x="765" y="906" text-anchor="middle" fill="#102a43" font-family="Arial" font-size="18" font-weight="700">#${serialText(serial)}</text></svg>`);
  return sharp(Buffer.from(ART_TEMPLATE_JPEG_BASE64, "base64"))
    .composite([{ input: overlay }])
    .resize(1600, 1600)
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 95 })
    .toBuffer();
}

export async function posterPdf(items: Array<{ serial: number; code: string }>) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const background = await pdf.embedJpg(Buffer.from(ART_TEMPLATE_JPEG_BASE64, "base64"));
  pdf.setTitle(`${ART_TEMPLATE_NAME} — ${items.length} arte(s)`);
  for (const item of items) {
    const page = pdf.addPage([283.46, 283.46]);
    page.drawImage(background, { x: 0, y: 0, width: 283.46, height: 283.46 });
    const qr = await QRCode.toBuffer(publicQrUrl(item.code), { type: "png", errorCorrectionLevel: "H", margin: 4, width: 640 });
    const qrImage = await pdf.embedPng(qr);
    page.drawRectangle({ x: 141.2, y: 29.5, width: 73.1, height: 64.7, color: rgb(1, 1, 1) });
    page.drawImage(qrImage, { x: 147.3, y: 35.3, width: 61, height: 61 });
    page.drawText(`#${serialText(item.serial)}`, { x: 191, y: 31.5, size: 4.5, font: bold, color: rgb(0.06, 0.16, 0.26) });
    page.drawText(`QR-${serialText(item.serial)} · ${publicQrUrl(item.code)}`, { x: 4, y: 2, size: 2.4, font, color: rgb(0, 0, 0), opacity: 0.01 });
  }
  return Buffer.from(await pdf.save());
}

export async function zipFiles(files: Array<{ name: string; data: Buffer | string }>) {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => { output.on("end", () => resolve(Buffer.concat(chunks))); archive.on("error", reject); });
  archive.pipe(output);
  for (const file of files) archive.append(file.data, { name: file.name });
  await archive.finalize();
  return done;
}

export async function batchArtworkFiles(items: Array<{ serial: number; code: string }>) {
  const first = items[0]?.serial ?? 0;
  const last = items.at(-1)?.serial ?? 0;
  const prefix = `LOTE-${serialText(first)}-${serialText(last)}`;
  const files: Array<{ name: string; data: Buffer | string }> = [];
  const manifest = items.map(item => ({
    filename: `QR-${serialText(item.serial)}`,
    serial: serialText(item.serial),
    public_code: item.code,
    url: publicQrUrl(item.code),
  }));
  for (const item of items) {
    const name = `QR-${serialText(item.serial)}`;
    files.push({ name: `${prefix}/SVG/${name}.svg`, data: await posterSvgWithQr(item.serial, item.code) });
    files.push({ name: `${prefix}/PNG/${name}.png`, data: await posterPng(item.serial, item.code) });
    files.push({ name: `${prefix}/PDF/${name}.pdf`, data: await posterPdf([item]) });
  }
  files.push({ name: `${prefix}/manifest.json`, data: JSON.stringify({ template: ART_TEMPLATE_NAME, width: ART_WIDTH, height: ART_HEIGHT, items: manifest }, null, 2) });
  return { prefix, manifest, files, zip: await zipFiles(files) };
}
