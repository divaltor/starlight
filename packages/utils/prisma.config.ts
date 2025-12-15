// import "dotenv/config"; uncomment this to load .env
import path from "node:path";
import dotenv from "dotenv";
import type { PrismaConfig } from "prisma/config";

dotenv.config({
	path: [".env", "../../apps/server/.env"],
});

export default {
	schema: path.join("prisma", "schema.prisma"),
} satisfies PrismaConfig;
