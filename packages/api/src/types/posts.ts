export type SearchResult = {
	media_id: string;
	provider: string;
	user_id: string;
	kind: string;
	original_url: string;
	s3_path: string;
	username: string;
	post_id: string;
	post_provider: string;
	source_url: string;
	post_created_at: Date;
	is_nsfw: boolean;
	height: number;
	width: number;
	final_score: number;
};

export type MediaData = {
	id: string;
	externalId: string;
	provider: string;
	kind: string;
	url: string;
	is_nsfw?: boolean;
	height?: number;
	width?: number;
	alt: string;
};

export type PostData = {
	id: string;
	externalId: string;
	provider: string;
	artist: string;
	date: string;
	media: MediaData[];
	hasMultipleMedia: boolean;
	sourceUrl: string;
};

export type PostsPageResult = {
	posts: PostData[];
	nextCursor: string | null;
};

export type SearchPageResult = {
	results: PostData[];
	nextCursor: string | null;
};
