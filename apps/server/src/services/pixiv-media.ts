import JSZip from "jszip";
import { MAX_MEDIA_DOWNLOAD_BYTES } from "@/services/media-download";

const PIXIV_HOSTS = new Set(["pixiv.net", "www.pixiv.net"]);
export const MAX_PIXIV_DOWNLOAD_BYTES = MAX_MEDIA_DOWNLOAD_BYTES;
export const MAX_UGOIRA_UNCOMPRESSED_BYTES = 200_000_000;
const MAX_UGOIRA_FRAMES = 1000;
const FFMPEG_TIMEOUT_MS = 120_000;

const createTemporaryDirectory = async () => {
	const directory = `${Bun.env.TMPDIR ?? "/tmp"}/starlight-ugoira-${Bun.randomUUIDv7()}`;
	const child = Bun.spawn(["mkdir", "-m", "700", directory], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if ((await child.exited) !== 0) {
		throw new Error("Failed to create ugoira temporary directory");
	}
	return directory;
};

const removeTemporaryDirectory = async (directory: string) => {
	const child = Bun.spawn(["rm", "-rf", directory], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
};

const writeBoundedEntry = async (
	entry: JSZip.JSZipObject,
	path: string,
	limit: number,
	total: { value: number },
) => {
	const stream = entry.nodeStream("nodebuffer");
	const sink = Bun.file(path).writer();
	await new Promise<void>((resolve, reject) => {
		let finished = false;
		const finish = (error?: Error) => {
			if (finished) {
				return;
			}
			finished = true;
			void Promise.resolve(sink.end(error)).then(() => (error ? reject(error) : resolve()), reject);
		};

		stream.on("data", (chunk: Uint8Array) => {
			if (finished) {
				return;
			}
			total.value += chunk.byteLength;
			if (total.value > limit) {
				finish(new Error("Ugoira is too large"));
				return;
			}
			sink.write(chunk);
		});
		stream.on("error", finish);
		stream.on("end", () => finish());
	});
};

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
		if (frame.file.includes("/") || frame.file.includes("\\")) {
			throw new Error("Unsafe ugoira archive path");
		}
	}
	const zip = await JSZip.loadAsync(archive);
	for (const entry of Object.values(zip.files)) {
		if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) {
			throw new Error("Unsafe ugoira archive path");
		}
	}
	const directory = await createTemporaryDirectory();
	const total = { value: 0 };
	try {
		for (const frame of frames) {
			const entry = zip.file(frame.file);
			if (!entry || entry.dir) {
				throw new Error(`Missing ugoira frame ${frame.file}`);
			}
			await writeBoundedEntry(entry, `${directory}/${frame.file}`, uncompressedLimit, total);
		}
		const concatPath = `${directory}/frames.txt`;
		await Bun.write(
			concatPath,
			buildFfmpegConcat(frames.map((frame) => ({ ...frame, file: `${directory}/${frame.file}` }))),
		);
		return { directory, concatPath };
	} catch (error) {
		await removeTemporaryDirectory(directory);
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
		if ((await Bun.file(output).stat()).size > MAX_PIXIV_DOWNLOAD_BYTES) {
			throw new Error("Converted ugoira is too large");
		}
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
};
