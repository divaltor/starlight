import path from "node:path";
import { env } from "@starlight/utils";
import { create } from "youtube-dl-exec";
import { logger } from "@/logger";

// biome-ignore lint/correctness/noUndeclaredVariables: Global in runtime
const filesGlob = new Bun.Glob("*.mp4");

interface VideoMetadata {
	height?: number;
	width?: number;
}

export interface VideoInformation {
	filePath: string;
	metadata: VideoMetadata;
}

async function createVideoInformation(
	filePath: string
): Promise<VideoInformation> {
	const parsedPath = path.parse(filePath);

	const infoJsonPath = path.join(
		parsedPath.dir,
		`${parsedPath.name}.info.json`
	);

	logger.debug("Creating video information for %s", infoJsonPath);

	let metadata: VideoMetadata = {};

	try {
		// biome-ignore lint/correctness/noUndeclaredVariables: Global in runtime
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

export async function downloadVideoFromUrl(
	url: string,
	folder: string,
	metadata: VideoMetadata = {}
): Promise<VideoInformation> {
	// biome-ignore lint/correctness/noUndeclaredVariables: Global in runtime
	const uuid = Bun.randomUUIDv7();
	const filePath = path.join(folder, `${uuid}.mp4`);

	logger.debug("Downloading video directly from URL %s", url);

	const response = await fetch(url);

	if (!(response.ok && response.body)) {
		throw new Error(`Failed to download video from ${url}: ${response.status}`);
	}

	// biome-ignore lint/correctness/noUndeclaredVariables: Global in runtime
	await Bun.write(filePath, response);

	return { filePath, metadata };
}

export async function downloadVideo(
	url: string,
	folder: string
): Promise<VideoInformation[]> {
	logger.debug("Downloading video from %s to %s", url, folder);

	// biome-ignore lint/correctness/noUndeclaredVariables: Global in runtime
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
		logger.error("Error downloading video from %s", url);
		throw subprocess.error;
	}

	const mp4Files = filesGlob.scan({ cwd: folder });

	const videoInformations: VideoInformation[] = [];

	for await (const filePath of mp4Files) {
		videoInformations.push(
			await createVideoInformation(path.join(folder, filePath))
		);
	}

	return videoInformations;
}
