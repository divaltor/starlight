import path from "node:path";
import { env } from "@repo/utils";
import { Glob } from "bun";
import { create } from "youtube-dl-exec";
import { logger } from "@/logger";

const filesGlob = new Glob("*.mp4");

type VideoMetadata = {
	height?: number;
	width?: number;
};

type VideoInformation = {
	filePath: string;
	metadata: VideoMetadata;
};

async function createVideoInformation(
	filePath: string,
): Promise<VideoInformation> {
	const parsedPath = path.parse(filePath);

	const infoJsonPath = path.join(
		parsedPath.dir,
		`${parsedPath.name}.info.json`,
	);

	logger.debug("Creating video information for %s", infoJsonPath);

	let metadata: VideoMetadata = {};

	try {
		metadata = (await Bun.file(infoJsonPath).json()) as VideoMetadata;
	} catch (error) {
		logger.error(error, "Error creating video information for %s", filePath);
	}

	return {
		filePath,
		metadata,
	};
}

const youtubedl = create(env.YOUTUBE_DL_PATH);

export async function downloadVideo(
	url: string,
	folder: string,
	cookies?: string,
): Promise<VideoInformation[]> {
	logger.debug("Downloading video from %s to %s", url, folder);

	await youtubedl(url, {
		paths: folder,
		quiet: true,
		noWarnings: true,
		noPostOverwrites: true,
		noOverwrites: true,
		format: "mp4",
		writeInfoJson: true,
		noCheckCertificates: true,
		cookies,
	});

	const mp4Files = filesGlob.scan({ cwd: folder });

	const videoInformations: VideoInformation[] = [];

	for await (const filePath of mp4Files) {
		videoInformations.push(
			await createVideoInformation(path.join(folder, filePath)),
		);
	}

	return videoInformations;
}
