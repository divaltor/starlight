"use server";

import { getPrismaClient } from "@repo/utils";
import { Renderer } from "@takumi-rs/core";
import { container, image, text } from "@takumi-rs/helpers";

interface OGCacheEntry {
	dataUrl: string;
	generatedAt: number; // epoch ms
}

const OG_CACHE = new Map<string, OGCacheEntry>();
const OG_CACHE_TTL = 1000 * 60 * 30; // 30 minutes

export async function generateProfileOg(slug: string): Promise<string | null> {
	const cacheKey = slug;
	const cached = OG_CACHE.get(cacheKey);
	if (cached && Date.now() - cached.generatedAt < OG_CACHE_TTL) {
		return cached.dataUrl;
	}

	const prisma = getPrismaClient();
	const profileShare = await prisma.profileShare.findUnique({
		where: { slug, revokedAt: null },
		include: { user: { select: { username: true } } },
	});

	if (!profileShare) {
		return await buildNotFoundOg(slug);
	}

	const tweets = await prisma.tweet.findMany({
		where: { userId: profileShare.userId, ...prisma.tweet.available() },
		include: {
			photos: {
				where: prisma.photo.available(),
				orderBy: { createdAt: "desc" },
				select: { s3Url: true },
			},
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: 12,
	});

	const photoUrls: string[] = [];
	for (const t of tweets) {
		for (const p of t.photos) {
			if (p.s3Url) photoUrls.push(p.s3Url);
			if (photoUrls.length >= 8) break;
		}
		if (photoUrls.length >= 8) break;
	}

	if (photoUrls.length === 0) {
		return await buildNotFoundOg(slug);
	}

	const dataUris: string[] = [];
	for (const url of photoUrls) {
		try {
			const res = await fetch(url);
			if (!res.ok) continue;
			const buf = new Uint8Array(await res.arrayBuffer());
			const mime = res.headers.get("content-type") || "image/jpeg";
			const b64 = Buffer.from(buf).toString("base64");
			dataUris.push(`data:${mime};base64,${b64}`);
		} catch {
			// ignore failed fetch
		}
	}

	if (dataUris.length === 0) {
		return await buildNotFoundOg(slug);
	}

	const WIDTH = 1200;
	const HEIGHT = 630;
	const PADDING = 40;
	const GAP = 16;
	const COLS = 4;
	const cellWidth = Math.floor((WIDTH - PADDING * 2 - GAP * (COLS - 1)) / COLS);
	const rows = Math.ceil(dataUris.length / COLS);
	const maxRows = Math.min(rows, 2); // enforce height constraints
	const cellHeight = Math.floor(
		(HEIGHT - PADDING * 2 - GAP * (maxRows - 1) - 80) / maxRows,
	); // leave room for header

	const imageNodes = dataUris.slice(0, COLS * maxRows).map((src) =>
		container({
			style: {
				width: cellWidth,
				height: cellHeight,
				borderRadius: 24,
			},
			children: [
				image({
					src,
					width: cellWidth,
					height: cellHeight,
					style: { objectFit: "cover" },
				}),
			],
		}),
	);

	const grid = container({
		style: {
			width: WIDTH - PADDING * 2,
			flexDirection: "row",
			flexWrap: "wrap",
			gap: GAP,
		},
		children: imageNodes,
	});

	const root = container({
		style: {
			width: WIDTH,
			height: HEIGHT,
			backgroundImage: "linear-gradient(135deg,#0f1115,#1d2430)",
			padding: PADDING,
			flexDirection: "column",
			justifyContent: "flex-start",
			gap: 32,
		},
		children: [
			text(`@${slug}`.toUpperCase(), {
				fontSize: 54,
				fontWeight: 600,
				color: 0xffffff,
				letterSpacing: 2,
			}),
			grid,
			text("Shared via Starlight", {
				fontSize: 24,
				color: 0xffffff,
			}),
		],
	});

	const renderer = new Renderer();
	const png = await renderer.renderAsync(root, {
		width: WIDTH,
		height: HEIGHT,
		format: "png",
	});
	const base64 = Buffer.from(png).toString("base64");
	const dataUrl = `data:image/png;base64,${base64}`;
	OG_CACHE.set(cacheKey, { dataUrl, generatedAt: Date.now() });
	return dataUrl;
}

async function buildNotFoundOg(slug: string): Promise<string> {
	const WIDTH = 1200;
	const HEIGHT = 630;
	const root = container({
		style: {
			width: WIDTH,
			height: HEIGHT,
			backgroundImage: "linear-gradient(135deg,#1a1a1a,#2a2a2a)",
			alignItems: "center",
			justifyContent: "center",
			gap: 32,
			flexDirection: "column",
		},
		children: [
			text("(｡•́︿•̀｡)", { fontSize: 120, color: 0xffffff }),
			text("Profile link not available", {
				fontSize: 42,
				color: 0xffffff,
				fontWeight: 600,
			}),
			text(`@${slug}`, { fontSize: 32, color: 0xffffff }),
		],
	});
	const renderer = new Renderer();
	const png = await renderer.renderAsync(root, {
		width: WIDTH,
		height: HEIGHT,
		format: "png",
	});
	const base64 = Buffer.from(png).toString("base64");
	return `data:image/png;base64,${base64}`;
}
