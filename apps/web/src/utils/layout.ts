import type { TweetData } from "@starlight/api/src/types/tweets";

export class LayoutManager {
	pageWidth: number;
	pageHeight: number;
	centerZone: { x: number; y: number; width: number; height: number };
	placedRects: Array<{
		x: number;
		y: number;
		width: number;
		height: number;
	}> = [];

	constructor(pageWidth: number, pageHeight: number, centerZonePercent = 0.25) {
		this.pageWidth = pageWidth;
		this.pageHeight = pageHeight;

		const centerWidth = pageWidth * centerZonePercent;
		const centerHeight = pageHeight * centerZonePercent;
		this.centerZone = {
			x: (pageWidth - centerWidth) / 2,
			y: (pageHeight - centerHeight) / 2,
			width: centerWidth,
			height: centerHeight,
		};
	}

	overlaps(
		r1: { x: number; y: number; width: number; height: number },
		r2: { x: number; y: number; width: number; height: number }
	) {
		return (
			r1.x < r2.x + r2.width &&
			r1.x + r1.width > r2.x &&
			r1.y < r2.y + r2.height &&
			r1.y + r1.height > r2.y
		);
	}

	isValidPosition(rect: {
		x: number;
		y: number;
		width: number;
		height: number;
	}) {
		if (this.overlaps(rect, this.centerZone)) {
			return false;
		}

		for (const placedRect of this.placedRects) {
			if (this.overlaps(rect, placedRect)) {
				return false;
			}
		}

		return true;
	}

	placeRectangle(width: number, height: number, maxAttempts = 50) {
		const margin = 0.05;
		const padding = 2;
		const halfW = width / 2;
		const halfH = height / 2;
		const minCenterX = halfW + padding;
		const maxCenterX = this.pageWidth - halfW - padding - margin;
		const minCenterY = halfH + padding;
		const maxCenterY = this.pageHeight - halfH - padding - margin;

		if (minCenterX > maxCenterX || minCenterY > maxCenterY) {
			return null;
		}

		for (let i = 0; i < maxAttempts; i++) {
			const centerX = minCenterX + Math.random() * (maxCenterX - minCenterX);
			const centerY = minCenterY + Math.random() * (maxCenterY - minCenterY);

			const rect = {
				x: centerX - halfW,
				y: centerY - halfH,
				width,
				height,
			};

			if (this.overlaps(rect, this.centerZone)) {
				continue;
			}

			const paddedNew = {
				x: rect.x - padding,
				y: rect.y - padding,
				width: rect.width + 2 * padding,
				height: rect.height + 2 * padding,
			};

			let valid = true;
			for (const placedRect of this.placedRects) {
				const paddedPlaced = {
					x: placedRect.x - padding,
					y: placedRect.y - padding,
					width: placedRect.width + 2 * padding,
					height: placedRect.height + 2 * padding,
				};
				if (this.overlaps(paddedNew, paddedPlaced)) {
					valid = false;
					break;
				}
			}

			if (valid) {
				this.placedRects.push(rect);
				return { top: centerY, left: centerX };
			}
		}
		return null;
	}

	placeTweets(tweets: TweetData[]) {
		const results: Array<{
			position: { top: number; left: number };
			index: number;
		}> = [];
		const CONTAINER_WIDTH_PERCENT = 20;

		// Compute heights and sort indices by height descending
		const indices: Array<{ index: number; height: number }> = [];
		for (let i = 0; i < tweets.length; i++) {
			const tweet = tweets[i];
			if (!tweet.photos.length) {
				continue;
			}

			const firstPhoto = tweet.photos[0];
			let aspect = 0.8;
			if (firstPhoto.width && firstPhoto.height && firstPhoto.width > 0) {
				aspect = firstPhoto.height / firstPhoto.width;
			}
			const height = CONTAINER_WIDTH_PERCENT * aspect;
			indices.push({ index: i, height });
		}

		// Sort by height descending
		indices.sort((a, b) => b.height - a.height);

		// Place in sorted order
		for (const { index: sortedIndex } of indices) {
			const tweet = tweets[sortedIndex];
			const firstPhoto = tweet.photos[0];
			let aspect = 0.8;
			if (firstPhoto.width && firstPhoto.height && firstPhoto.width > 0) {
				aspect = firstPhoto.height / firstPhoto.width;
			}
			const computedHeight = CONTAINER_WIDTH_PERCENT * aspect;

			const placement = this.placeRectangle(
				CONTAINER_WIDTH_PERCENT,
				computedHeight
			);
			if (placement) {
				results.push({ position: placement, index: sortedIndex });
			}
		}
		return results;
	}
}
