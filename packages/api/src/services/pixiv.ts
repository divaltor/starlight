import {
	BookmarkRestrict,
	PixivClient,
	type PixivIllustItem,
	parseNextUrl,
} from "@book000/pixivts";

export type PixivArtwork = {
	id: string;
	title: string;
	caption: string;
	type: "illust" | "manga" | "ugoira";
	sourceUrl: string;
	author: { id: string; name: string; username: string };
	mediaUrls: string[];
	payload: Record<string, object | string | number | boolean | null>;
};

export type PixivBookmarkPage = {
	artworks: PixivArtwork[];
	nextCursor?: number;
};

const mapArtwork = (illust: PixivIllustItem): PixivArtwork => ({
	id: String(illust.id),
	title: illust.title,
	caption: illust.caption,
	type: illust.type,
	sourceUrl: `https://www.pixiv.net/artworks/${illust.id}`,
	author: {
		id: String(illust.user.id),
		name: illust.user.name,
		username: illust.user.account,
	},
	mediaUrls:
		illust.metaPages.length > 0
			? illust.metaPages.map((page) => page.imageUrls.original)
			: [illust.metaSinglePage.originalImageUrl].filter(
					(url): url is string => typeof url === "string",
				),
	payload: illust as unknown as PixivArtwork["payload"],
});

export class PixivAdapter {
	readonly #client: PixivClient;

	private constructor(client: PixivClient) {
		this.#client = client;
	}

	static async connect(refreshToken: string) {
		const client = await PixivClient.of(refreshToken);
		return new PixivAdapter(client);
	}

	get externalUserId() {
		return String(this.#client.userId);
	}

	get refreshToken() {
		return this.#client.getRefreshToken();
	}

	async bookmarks(options: {
		cursor?: number;
		visibility: "public" | "private";
	}): Promise<PixivBookmarkPage> {
		const result = await this.#client.users.bookmarks.illusts({
			userId: this.#client.userId,
			restrict:
				options.visibility === "private" ? BookmarkRestrict.PRIVATE : BookmarkRestrict.PUBLIC,
			maxBookmarkId: options.cursor,
		});
		if (result.isErr) {
			throw new Error(`Pixiv bookmark request failed: ${result.error.type}`);
		}
		const next = result.value.nextUrl
			? parseNextUrl(result.value.nextUrl).maxBookmarkId
			: undefined;
		return {
			artworks: result.value.illusts.map(mapArtwork),
			nextCursor: typeof next === "number" ? next : undefined,
		};
	}

	async artwork(id: string) {
		const result = await this.#client.illusts.detail({ illustId: Number(id) });
		if (result.isErr) {
			throw new Error(`Pixiv artwork request failed: ${result.error.type}`);
		}
		return mapArtwork(result.value.illust);
	}

	async ugoira(id: string) {
		const result = await this.#client.ugoira.metadata({ illustId: Number(id) });
		if (result.isErr) {
			throw new Error(`Pixiv ugoira request failed: ${result.error.type}`);
		}
		return result.value.ugoiraMetadata;
	}

	async fetchMedia(url: string) {
		const result = await this.#client.images.fetch(url);
		if (result.isErr) {
			throw new Error(`Pixiv media request failed: ${result.error.type}`);
		}
		return result.value;
	}
}
