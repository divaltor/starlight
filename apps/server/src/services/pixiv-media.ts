import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import { MAX_MEDIA_DOWNLOAD_BYTES } from "@/services/media-download";

const PIXIV_HOSTS = new Set(["pixiv.net", "www.pixiv.net"]);
export const MAX_PIXIV_DOWNLOAD_BYTES = MAX_MEDIA_DOWNLOAD_BYTES;
export const MAX_UGOIRA_UNCOMPRESSED_BYTES = 200_000_000;
const MAX_UGOIRA_FRAMES = 1000;
const FFMPEG_TIMEOUT_MS = 120_000;

export const parsePixivArtworkUrl = (value: string) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || !PIXIV_HOSTS.has(url.hostname.toLowerCase())) {
		return null;
	}
	const match = /^\/artworks\/(\d+)\/?$/.exec(url.pathname);
	return match?.[1] ?? null;
};

export const buildFfmpegConcat = (frames: Array<{ file: string; delay: number }>) => {
	if (frames.length === 0 || frames.some((frame) => frame.delay <= 0)) {
		throw new Error("Invalid ugoira frame timing");
	}
	const lines: string[] = [];
	for (const frame of frames) {
		if (frame.file.includes("'") || frame.file.includes("\n")) {
			throw new Error("Invalid ugoira frame filename");
		}
		lines.push(`file '${frame.file}'`, `duration ${frame.delay / 1000}`);
	}
	lines.push(`file '${frames.at(-1)?.file}'`);
	return `${lines.join("\n")}\n`;
};

export const extractUgoiraZip = async (
	archive: ArrayBuffer | Uint8Array,
	frames: Array<{ file: string; delay: number }>,
	limits: { compressed?: number; uncompressed?: number; frames?: number } = {},
) => {
	const compressedLimit = limits.compressed ?? MAX_PIXIV_DOWNLOAD_BYTES;
	const uncompressedLimit = limits.uncompressed ?? MAX_UGOIRA_UNCOMPRESSED_BYTES;
	const frameLimit = limits.frames ?? MAX_UGOIRA_FRAMES;
	if (archive.byteLength > compressedLimit || frames.length > frameLimit) {
		throw new Error("Ugoira is too large");
	}
	for (const frame of frames) {
		if (basename(frame.file) !== frame.file || frame.file.includes("\\")) {
			throw new Error("Unsafe ugoira archive path");
		}
	}
	const zip = await JSZip.loadAsync(archive);
	for (const entry of Object.values(zip.files)) {
		if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) {
			throw new Error("Unsafe ugoira archive path");
		}
	}
	const directory = await mkdtemp(join(tmpdir(), "starlight-ugoira-"));
	let total = 0;
	try {
		await mkdir(directory, { recursive: true });
		for (const frame of frames) {
			const entry = zip.file(frame.file);
			if (!entry || entry.dir) {
				throw new Error(`Missing ugoira frame ${frame.file}`);
			}
			const limiter = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					total += chunk.byteLength;
					if (total > uncompressedLimit) {
						callback(new Error("Ugoira is too large"));
						return;
					}
					callback(null, chunk);
				},
			});
			await pipeline(
				entry.nodeStream("nodebuffer"),
				limiter,
				createWriteStream(join(directory, frame.file), { flags: "wx" }),
			);
		}
		const concatPath = join(directory, "frames.txt");
		await writeFile(
			concatPath,
			buildFfmpegConcat(frames.map((frame) => ({ ...frame, file: join(directory, frame.file) }))),
		);
		return { directory, concatPath };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
};

export const convertUgoira = async (concatPath: string, output: string) => {
	// biome-ignore lint/correctness/noUndeclaredVariables: Server runtime is Bun.
	const child = Bun.spawn(
		[
			"ffmpeg",
			"-y",
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			concatPath,
			"-vf",
			"scale=trunc(iw/2)*2:trunc(ih/2)*2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
			"-fs",
			String(MAX_PIXIV_DOWNLOAD_BYTES),
			output,
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	const stderr = new Response(child.stderr).arrayBuffer();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			child.exited,
			new Promise<"timeout">((resolve) => {
				timeout = setTimeout(() => {
					resolve("timeout");
				}, FFMPEG_TIMEOUT_MS);
			}),
		]);
		if (result === "timeout") {
			child.kill();
			await child.exited;
			await stderr;
			throw new Error("Ugoira conversion timed out");
		}
		await stderr;
		if (result !== 0) {
			throw new Error("Failed to convert ugoira");
		}
		if ((await stat(output)).size > MAX_PIXIV_DOWNLOAD_BYTES) {
			throw new Error("Converted ugoira is too large");
		}
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
};
