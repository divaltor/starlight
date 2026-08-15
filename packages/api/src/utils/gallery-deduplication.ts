export interface GalleryDedupeCandidate {
	userId: string;
	perceptualHash: string | null;
	provider: string;
	mediaId: string;
	postId: string;
	postCreatedAt: Date;
	finalScore: number | null;
}

export const galleryDedupePartitionSql = "user_id, dedupe_key";
export const galleryRepresentativeOrderSql =
	"final_score DESC NULLS LAST, provider DESC, media_id DESC, user_id DESC, post_created_at DESC, post_id DESC";

export function galleryDedupeKeySql(mediaAlias: string) {
	return `COALESCE(NULLIF(${mediaAlias}.perceptual_hash, ''), jsonb_build_array(${mediaAlias}.provider, ${mediaAlias}.external_id, ${mediaAlias}.user_id)::text)`;
}

export function galleryDedupeKey(
	candidate: Pick<GalleryDedupeCandidate, "userId" | "perceptualHash" | "provider" | "mediaId">,
) {
	return (
		candidate.perceptualHash ||
		JSON.stringify([candidate.provider, candidate.mediaId, candidate.userId])
	);
}

export function selectGalleryRepresentatives(candidates: GalleryDedupeCandidate[]) {
	const representatives = new Map<string, GalleryDedupeCandidate>();

	for (const candidate of candidates) {
		const key = `${candidate.userId}:${galleryDedupeKey(candidate)}`;
		const current = representatives.get(key);
		if (!current || compareGalleryCandidates(candidate, current) < 0) {
			representatives.set(key, candidate);
		}
	}

	return [...representatives.values()];
}

function compareGalleryCandidates(a: GalleryDedupeCandidate, b: GalleryDedupeCandidate) {
	const aScore = a.finalScore ?? Number.NEGATIVE_INFINITY;
	const bScore = b.finalScore ?? Number.NEGATIVE_INFINITY;
	if (aScore !== bScore) return bScore - aScore;
	if (a.provider !== b.provider) return b.provider.localeCompare(a.provider);
	if (a.mediaId !== b.mediaId) return b.mediaId.localeCompare(a.mediaId);
	if (a.userId !== b.userId) return b.userId.localeCompare(a.userId);
	if (a.postCreatedAt.getTime() !== b.postCreatedAt.getTime()) {
		return b.postCreatedAt.getTime() - a.postCreatedAt.getTime();
	}
	return b.postId.localeCompare(a.postId);
}
