import { Prisma, type Media } from "@starlight/utils";

export const mediaResolvedWhere = {
	s3Path: { not: null },
	OR: [{ kind: { not: "image" } }, { perceptualHash: { not: null } }],
} satisfies Prisma.MediaWhereInput;

export function isMediaResolved(media: Pick<Media, "kind" | "perceptualHash" | "s3Path">): boolean {
	return media.s3Path !== null && (media.kind !== "image" || media.perceptualHash !== null);
}

export function resolveMediaFromAsset(
	asset: Pick<Media, "height" | "perceptualHash" | "s3Path" | "width"> & {
		perceptualHash: string;
		s3Path: string;
	},
) {
	return {
		s3Path: asset.s3Path,
		perceptualHash: asset.perceptualHash,
		height: asset.height,
		width: asset.width,
	};
}
