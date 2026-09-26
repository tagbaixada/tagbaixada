import path from "node:path";
import express from "express";
import { app } from "../server/_core/index.ts";

app.use(express.static(path.resolve(process.cwd(), "dist/public")));

export default app;
