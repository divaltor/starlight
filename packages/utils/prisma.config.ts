// import "dotenv/config"; uncomment this to load .env
import path from "node:path";
import type { PrismaConfig } from "prisma/config";

export default {
	schema: path.join("prisma", "schema.prisma"),
} satisfies PrismaConfig;
