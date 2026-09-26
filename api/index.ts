import path from "node:path";
import express from "express";

let appPromise: Promise<express.Express> | null = null;

async function getApp() {
  if (!appPromise) {
    appPromise = import("../server/_core/index").then(({ app }) => {
      app.use(express.static(path.resolve(process.cwd(), "dist/public")));
      return app;
    });
  }
  return appPromise;
}

export default async function handler(req: any, res: any) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (error) {
    console.error("[Vercel] application initialization failed", error);
    return res.status(500).json({ error: "Application initialization failed" });
  }
}
