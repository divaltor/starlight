import path from "node:path";
import { Glob } from "bun";
import { create } from "youtube-dl-exec";

import env from "@/config";
import { logger } from "@/logger";

const filesGlob = new Glob("*.mp4");

type VideoInformation = {
	filePath: string;
	metadata: {
		height?: number;
		width?: number;
	};
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

	return (await Bun.file(infoJsonPath).json()) as VideoInformation;
}

const youtubedl = create(env.YOUTUBE_DL_PATH);

export async function downloadVideo(
	url: string,
	folder: string,
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
