import path from "node:path";
import { env } from "@starlight/utils";
import { http } from "@starlight/utils/http";
import { create } from "youtube-dl-exec";
import { logger } from "@/logger";

const filesGlob = new Bun.Glob("*.mp4");

interface VideoMetadata {
	height?: number;
	width?: number;
}

export interface VideoInformation {
	filePath: string;
	metadata: VideoMetadata;
}

async function createVideoInformation(filePath: string): Promise<VideoInformation> {
	const parsedPath = path.parse(filePath);

	const infoJsonPath = path.join(parsedPath.dir, `${parsedPath.name}.info.json`);

	logger.debug({ infoJsonPath }, "Creating video information");

	let metadata: VideoMetadata = {};

	try {
		metadata = (await Bun.file(infoJsonPath).json()) as VideoMetadata;
	} catch (error) {
		logger.error({ error, filePath }, "Failed to create video information");
	}

	return {
		filePath,
		metadata,
	};
}

const youtubedl = create(env.YOUTUBE_DL_PATH);

export async function downloadVideoFromUrl(
	url: string,
	folder: string,
	metadata: VideoMetadata = {},
): Promise<VideoInformation> {
	const uuid = Bun.randomUUIDv7();
	const filePath = path.join(folder, `${uuid}.mp4`);

	logger.debug({ url }, "Downloading video directly from URL");

	const response = await http(url);

	if (!(response.ok && response.body)) {
		throw new Error(`Failed to download video from ${url}: ${response.status}`);
	}

	await Bun.write(filePath, response);

	return { filePath, metadata };
}

export async function downloadVideo(url: string, folder: string): Promise<VideoInformation[]> {
	logger.debug({ folder, url }, "Downloading video");

	const uuid = Bun.randomUUIDv7();

	const subprocess = await youtubedl.exec(url, {
		paths: folder,
		quiet: true,
		noWarnings: true,
		noPostOverwrites: true,
		noOverwrites: true,
		format: "mp4",
		writeInfoJson: true,
		noCheckCertificates: true,
		output: `${uuid}.%(ext)s`,
	});

	if (subprocess.error) {
		logger.error({ url }, "Failed to download video");
		throw subprocess.error;
	}

	const mp4Files = filesGlob.scan({ cwd: folder });

	const videoInformations: VideoInformation[] = [];

	for await (const filePath of mp4Files) {
		videoInformations.push(await createVideoInformation(path.join(folder, filePath)));
	}

	return videoInformations;
}
