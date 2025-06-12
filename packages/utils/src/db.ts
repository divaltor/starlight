import { PrismaPg } from "@prisma/adapter-pg";
import Sqids from "sqids";
import { parse as uuidParse } from "uuid";
import { PrismaClient } from "../prisma/generated/client";
import env from "./config";

const sqids = new Sqids({
	minLength: 12,
});

const adapter = new PrismaPg({
	connectionString: env.DATABASE_URL,
});

export function createPrismaClient() {
	return new PrismaClient({
		adapter: adapter as never,
		log:
			env.ENVIRONMENT === "prod"
				? ["info", "warn", "error"]
				: ["query", "info", "warn", "error"],
	}).$extends({
		result: {
			photo: {
				externalId: {
					needs: {
						id: true,
						userId: true,
					},
					compute(data: { id: string; userId: string }) {
						// Split Twitter ID into 3 parts to handle large numbers that exceed bigint
						const id = data.id;
						const chunkSize = Math.ceil(id.length / 3);

						const parts = [
							id.slice(0, chunkSize),
							id.slice(chunkSize, chunkSize * 2),
							id.slice(chunkSize * 2),
						].map((part) => Number.parseInt(part || "0"));

						const userId = uuidParse(data.userId);

						return sqids.encode([...parts, ...userId]);
					},
				},
				s3Url: {
					needs: {
						s3Path: true,
					},
					compute(data: { s3Path: string }) {
						if (!data.s3Path) return undefined;

						return env.BASE_CDN_URL
							? `${env.BASE_CDN_URL}/${data.s3Path}`
							: undefined;
					},
				},
			},
		},
	});
}

let globalPrisma: ReturnType<typeof createPrismaClient> | undefined;

export function getPrismaClient() {
	if (!globalPrisma) {
		globalPrisma = createPrismaClient();
	}
	return globalPrisma;
}
