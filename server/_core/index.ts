import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { resolvePublicQr, safeExternalUrl } from "../qr";
import { getLinks, query } from "../db";
import { posterPdf, posterPng, posterSvgWithQr, zipFiles } from "../artwork";
import { storageGetSignedUrl } from "../storage";
import { sdk } from "./sdk";
import QRCode from "qrcode";

export const app = express();
function isPortAvailable(port: number): Promise<boolean> { return new Promise(resolve => { const server = net.createServer(); server.listen(port, () => server.close(() => resolve(true))); server.on("error", () => resolve(false)); }); }
async function findAvailablePort(startPort = 3000) { for (let port = startPort; port < startPort + 20; port++) if (await isPortAvailable(port)) return port; throw new Error(`No available port found starting from ${startPort}`); }
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char] as string));
const escapeJsString = (value: unknown) => JSON.stringify(String(value ?? "")).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
function publicHtml(title: string, body: string) { return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · RSA Digital</title><style>body{margin:0;background:#eff5ff;color:#102a43;font-family:Arial,sans-serif;min-height:100vh;display:grid;place-items:center}.card{width:min(92vw,480px);background:#fff;border-radius:28px;padding:34px;box-shadow:0 18px 50px #174f9126;text-align:center}h1{margin:4px 0 10px;font-size:28px}.muted{color:#60758b;line-height:1.6}.links{display:grid;gap:12px;margin-top:26px}.links a,.links button{border:0;border-radius:14px;background:#0e4b9b;color:#fff;padding:15px;font-weight:700;text-decoration:none;font-size:15px;cursor:pointer}</style></head><body><main class="card">${body}</main></body></html>`; }
async function landingBody(qr: any, links: any[]) {
  const logo = safeExternalUrl(qr.logo_url);
  const identity = `${logo ? `<img src="${escapeHtml(logo)}" alt="Logo" style="width:84px;height:84px;object-fit:contain;border-radius:22px;margin:0 auto 16px">` : `<div style="width:76px;height:76px;border-radius:22px;background:#0e4b9b;color:#ffd74b;display:grid;place-items:center;margin:0 auto 18px;font-weight:900;font-size:22px">RSA</div>`}<h1>${escapeHtml(qr.business_name || "Sua empresa")}</h1>${qr.description ? `<p class="muted">${escapeHtml(qr.description)}</p>` : ""}`;
  const buttons: string[] = [];
  for (const link of links.filter(item => Number(item.enabled)).sort((a, b) => Number(a.position) - Number(b.position) || Number(a.id) - Number(b.id))) {
    const icon = ({ GOOGLE_REVIEW: "★", INSTAGRAM: "◎", WHATSAPP: "◉", PIX: "₿", WIFI: "⌁", SITE: "↗", GOOGLE_MAPS: "⌖" } as Record<string, string>)[link.type] || "•";
    if (link.type === "PIX") buttons.push(`<button onclick="navigator.clipboard.writeText(${escapeJsString(link.value)});this.textContent='Chave Pix copiada'">${icon} ${escapeHtml(link.label || "Copiar chave Pix")}</button>`);
    else if (link.type === "WIFI") { try { const wifi = JSON.parse(link.value); const security = wifi.security === "OPEN" ? "" : `T:${wifi.security};`; const payload = `WIFI:${security}S:${String(wifi.ssid).replace(/[\\;,:]/g, "\\$&")};P:${String(wifi.password || "").replace(/[\\;,:]/g, "\\$&")};;`; const qrImage = await QRCode.toDataURL(payload, { width: 180, margin: 1 }); buttons.push(`<div style="background:#f2f6fb;border-radius:14px;padding:14px"><b>${icon} ${escapeHtml(link.label || "Wi-Fi")}</b><div class="muted">Rede: ${escapeHtml(wifi.ssid)}</div><img src="${qrImage}" alt="QR Wi-Fi" style="width:140px;margin:10px auto;display:block"><button onclick="navigator.clipboard.writeText(${escapeJsString(wifi.password || "")});this.textContent='Senha copiada'">Copiar senha</button></div>`); } catch { /* link inválido não é exposto */ } }
    else { const url = safeExternalUrl(link.value); if (url) buttons.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${icon} ${escapeHtml(link.label)}</a>`); }
  }
  return `${identity}<p class="muted">Acesse os canais oficiais e deixe sua avaliação.</p><div class="links">${buttons.join("")}</div><small style="display:block;margin-top:28px;color:#9aabc0">Powered by TAG · RSA Digital</small>`;
}
async function requireArtworkAdmin(req: express.Request, res: express.Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user.role !== "admin") { res.status(403).json({ error: "Admin access required" }); return false; }
    return true;
  } catch { res.status(401).json({ error: "Authentication required" }); return false; }
}
function registerPublicRoutes() {
  app.get(/^\/([A-Z0-9]{6,20})$/, async (req, res, next) => { const code = req.params[0]; try { const result = await resolvePublicQr(code, String(req.headers["user-agent"] ?? "")); if (result.kind === "NOT_FOUND") return res.status(404).send(publicHtml("Código não encontrado", "<h1>QR Code não encontrado</h1><p class=\"muted\">Confira o código impresso na placa.</p>")); if (result.kind === "NOT_CONFIGURED") return res.status(409).send(publicHtml(result.qr.status === "STOCK" ? "QR em estoque" : "QR reservado", `<h1>${result.qr.status === "STOCK" ? "Este QR ainda está em estoque" : "Este QR ainda não está ativo"}</h1><p class=\"muted\">O código ainda não está disponível para o público.</p>`)); if (result.kind === "INACTIVE") return res.status(410).send(publicHtml("Código indisponível", "<h1>Código indisponível</h1><p class=\"muted\">Este QR Code foi desativado.</p>")); const qr = result.qr; const reviewUrl = safeExternalUrl(qr.google_review_url) || qr.destination_url; if (qr.mode === "GOOGLE_REVIEW" && reviewUrl) return res.redirect(reviewUrl); const links = qr.customer_id ? await getLinks(qr.customer_id) : []; return res.send(publicHtml(qr.business_name || "RSA Digital", await landingBody(qr, links))); } catch (error) { next(error); } });
  app.get("/api/artwork/:code.svg", async (req, res) => { if (!await requireArtworkAdmin(req, res)) return; const qr = await query<any>("SELECT * FROM qr_codes WHERE public_code=? LIMIT 1", [req.params.code]); if (!qr[0]) return res.status(404).end(); res.type("image/svg+xml").send(await posterSvgWithQr(qr[0].serial_number, qr[0].public_code)); });
  app.get("/api/artwork/:code.png", async (req, res) => { if (!await requireArtworkAdmin(req, res)) return; const qr = await query<any>("SELECT * FROM qr_codes WHERE public_code=? LIMIT 1", [req.params.code]); if (!qr[0]) return res.status(404).end(); res.type("image/png").send(await posterPng(qr[0].serial_number, qr[0].public_code)); });
  app.get("/api/artwork/:code.pdf", async (req, res) => { if (!await requireArtworkAdmin(req, res)) return; const qr = await query<any>("SELECT * FROM qr_codes WHERE public_code=? LIMIT 1", [req.params.code]); if (!qr[0]) return res.status(404).end(); res.type("application/pdf").send(await posterPdf([{ serial: qr[0].serial_number, code: qr[0].public_code }])); });
  app.get("/api/batches/:id.zip", async (req, res) => { if (!await requireArtworkAdmin(req, res)) return; const batch = (await query<any>("SELECT * FROM batches WHERE id=?", [Number(req.params.id)]))[0]; if (!batch) return res.status(404).end(); const parsed = JSON.parse(batch.manifest_json); const items = Array.isArray(parsed) ? parsed : parsed.items; if (batch.status !== "READY" || !parsed.artifacts) return res.status(409).json({ error: "A geração das artes ainda não foi concluída." }); const first = items[0]?.serial ?? 0; const last = items.at(-1)?.serial ?? 0; const prefix = `LOTE-${String(first).padStart(6, "0")}-${String(last).padStart(6, "0")}`; const files: Array<{ name: string; data: Buffer | string }> = []; for (const item of items) { const artifact = parsed.artifacts[item.code]; if (!artifact) return res.status(409).json({ error: "Manifesto incompleto." }); for (const [folder, keyName] of [["SVG", "svgKey"], ["PNG", "pngKey"], ["PDF", "pdfKey"]] as const) { const url = await storageGetSignedUrl(artifact[keyName]); const response = await fetch(url); if (!response.ok) return res.status(502).json({ error: `Falha ao ler ${folder} do storage.` }); files.push({ name: `${prefix}/${folder}/QR-${String(item.serial).padStart(6, "0")}.${folder.toLowerCase()}`, data: Buffer.from(await response.arrayBuffer()) }); } } files.push({ name: `${prefix}/manifest.json`, data: JSON.stringify({ template: "RSA Digital — Conecte-se conosco", items }, null, 2) }); const zip = await zipFiles(files); res.type("application/zip").setHeader("Content-Disposition", `attachment; filename=${prefix}.zip`).send(zip); });
}
function configureApp() { app.use(express.json({ limit: "50mb" })); app.use(express.urlencoded({ limit: "50mb", extended: true })); registerStorageProxy(app); registerOAuthRoutes(app); registerPublicRoutes(); app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext })); }
configureApp();
async function startServer() { const server = createServer(app); if (process.env.NODE_ENV === "development") await setupVite(app, server); else serveStatic(app); const preferredPort = parseInt(process.env.PORT || "3000"); const port = await findAvailablePort(preferredPort); server.listen(port, () => console.log(`Server running on http://localhost:${port}/`)); }
if (process.env.RUN_HTTP_SERVER === "1") startServer().catch(console.error);
