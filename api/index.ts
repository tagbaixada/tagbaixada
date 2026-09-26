import path from "node:path";
import express from "express";
import { app } from "../server/_core/index";

// Vercel serves the compiled Vite assets from the same serverless entrypoint.
app.use(express.static(path.resolve(process.cwd(), "dist/public")));

export default app;
