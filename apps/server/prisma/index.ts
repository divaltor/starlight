import env from "@/config";
import { PrismaClient } from "@/prisma/generated/client";
import Sqids from "sqids";
import { parse as uuidParse } from "uuid";

const sqids = new Sqids({
	minLength: 12,
});

const prisma = new PrismaClient({
	log:
		env.ENVIRONMENT === "dev"
			? ["query", "info", "warn", "error"]
			: ["info", "warn", "error"],
}).$extends({
	result: {
		photo: {
			externalId: {
				needs: {
					id: true,
					userId: true,
				},
				compute(data) {
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
				compute(data) {
					if (!data.s3Path) return undefined;

					return `${env.BASE_CDN_URL}/${data.s3Path}`;
				},
			},
		},
	},
});

export default prisma;
