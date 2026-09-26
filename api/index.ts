import path from "node:path";
import express from "express";
import { app } from "../dist/index.js";

app.use(express.static(path.resolve(process.cwd(), "dist/public")));

export default function handler(req: any, res: any) {
  return app(req, res);
}
