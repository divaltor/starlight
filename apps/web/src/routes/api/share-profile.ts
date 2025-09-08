import { getPrismaClient } from "@repo/utils";
import { createServerFn } from "@tanstack/react-start";
import { generateSlug } from "@/lib/utils";
import { authMiddleware } from "@/middleware/auth";

// Create or re-activate (if previously revoked) a profile share
export const createProfileShare = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		const existing = await prisma.profileShare.findUnique({
			where: { userId },
		});

		if (existing) {
			// If revoked, just reactivate without changing the slug
			if (existing.revokedAt) {
				const updated = await prisma.profileShare.update({
					where: { userId },
					data: { revokedAt: null },
				});
				return { slug: updated.slug, revokedAt: updated.revokedAt };
			}
			return { slug: existing.slug, revokedAt: existing.revokedAt };
		}

		const slug = generateSlug();
		const created = await prisma.profileShare.create({
			data: { userId, slug },
		});
		return { slug: created.slug, revokedAt: created.revokedAt };
	});

export const getProfileShare = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		return await prisma.profileShare.findUnique({
			where: { userId },
			select: { slug: true, createdAt: true, revokedAt: true },
		});
	});

export const revokeProfileShare = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(async ({ context }) => {
		const prisma = getPrismaClient();
		const userId = context.databaseUserId;

		await prisma.profileShare.update({
			where: { userId },
			data: { revokedAt: new Date() },
		});

		return { success: true };
	});
