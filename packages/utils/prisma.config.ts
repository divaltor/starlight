import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({
  path: [".env", "../../apps/server/.env", "../../apps/starlight/.env"],
  quiet: true,
});

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    // Fallback keeps generate working in build stages that have no DATABASE_URL
    url: process.env.DATABASE_URL ?? "postgresql://prisma:prisma@localhost:5432/prisma",
  },
});
