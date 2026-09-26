import QRCode from "qrcode";
import { ZipArchive } from "archiver";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { PassThrough } from "node:stream";
import { publicQrUrl } from "./qr";

export async function qrSvg(code: string) {
  return QRCode.toString(publicQrUrl(code), { type: "svg", errorCorrectionLevel: "H", margin: 4, width: 680 });
}

export async function qrPng(code: string) {
  return QRCode.toBuffer(publicQrUrl(code), { type: "png", errorCorrectionLevel: "H", margin: 4, width: 1600 });
}

export function posterSvg(serial: number, code: string) {
  const serialText = String(serial).padStart(6, "0");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600"><rect width="1200" height="1600" fill="#0e4b9b"/><circle cx="110" cy="110" r="34" fill="#ffd74b"/><circle cx="190" cy="110" r="34" fill="#ffd74b"/><circle cx="270" cy="110" r="34" fill="#ffd74b"/><circle cx="350" cy="110" r="34" fill="#ffd74b"/><circle cx="430" cy="110" r="34" fill="#ffd74b"/><text x="600" y="300" text-anchor="middle" fill="#ffd74b" font-family="Arial" font-size="88" font-weight="700">CONECTE-SE</text><text x="600" y="420" text-anchor="middle" fill="white" font-family="Arial" font-size="138" font-weight="800">CONOSCO</text><text x="600" y="520" text-anchor="middle" fill="white" font-family="Arial" font-size="36" letter-spacing="7">AVALIE • SIGA • ACOMPANHE</text><rect x="190" y="650" width="820" height="650" rx="42" fill="white"/><image href="data:image/svg+xml;base64,${Buffer.from('').toString('base64')}"/><text x="600" y="1380" text-anchor="middle" fill="white" font-family="Arial" font-size="34" letter-spacing="3">ESCANEIE O QR CODE</text><text x="600" y="1440" text-anchor="middle" fill="#ffd74b" font-family="Arial" font-size="30" letter-spacing="2">APROXIME O CELULAR • NFC</text><text x="1090" y="1530" text-anchor="end" fill="white" font-family="Arial" font-size="24">#${serialText} · ${code}</text></svg>`;
}

export async function posterSvgWithQr(serial: number, code: string) {
  const qr = await qrSvg(code);
  const embedded = Buffer.from(qr).toString("base64");
  return posterSvg(serial, code).replace(`<image href="data:image/svg+xml;base64,${Buffer.from('').toString('base64')}"/>`, `<image x="230" y="690" width="740" height="570" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${embedded}"/>`);
}

export async function posterPng(serial: number, code: string) {
  return qrPng(code);
}

export async function posterPdf(items: Array<{ serial: number; code: string }>) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const item of items) { const page = pdf.addPage([595, 842]); page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.055, 0.294, 0.608) }); page.drawText("CONECTE-SE", { x: 170, y: 730, size: 34, font, color: rgb(1, .84, .29) }); page.drawText("CONOSCO", { x: 175, y: 660, size: 42, font, color: rgb(1, 1, 1) }); page.drawText(`QR #${String(item.serial).padStart(6, "0")} · ${item.code}`, { x: 80, y: 50, size: 12, font, color: rgb(1, 1, 1) }); }
  return Buffer.from(await pdf.save());
}

export async function zipFiles(files: Array<{ name: string; data: Buffer | string }>) {
  const archive = new ZipArchive({ zlib: { level: 9 } }); const output = new PassThrough(); const chunks: Buffer[] = []; output.on("data", chunk => chunks.push(Buffer.from(chunk))); const done = new Promise<Buffer>((resolve, reject) => { output.on("end", () => resolve(Buffer.concat(chunks))); archive.on("error", reject); }); archive.pipe(output); for (const file of files) archive.append(file.data, { name: file.name }); await archive.finalize(); return done;
}
