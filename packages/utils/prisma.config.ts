import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({
	path: [".env", "../../apps/server/.env"],
});

export default defineConfig({
	schema: path.join("prisma", "schema.prisma"),
	datasource: {
		url: process.env.DATABASE_URL!,
	},
});
