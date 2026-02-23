import path from "node:path";
import { env } from "@starlight/utils";
import { logger } from "@/logger";

interface CobaltTunnelResponse {
	filename: string;
	status: "tunnel" | "redirect";
	url: string;
}

interface CobaltPickerItem {
	thumb?: string;
	type: "photo" | "video" | "gif";
	url: string;
}

interface CobaltPickerResponse {
	audio?: string;
	audioFilename?: string;
	picker: CobaltPickerItem[];
	status: "picker";
}

interface CobaltErrorResponse {
	error: { code: string; context?: Record<string, unknown> };
	status: "error";
}

type CobaltResponse =
	| CobaltTunnelResponse
	| CobaltPickerResponse
	| CobaltErrorResponse;

export interface CobaltVideoResult {
	filePath: string;
	metadata: { width?: number; height?: number };
}

async function downloadFromTunnelUrl(
	url: string,
	folder: string
): Promise<string> {
	const response = await fetch(url);

	if (!(response.ok && response.body)) {
		throw new Error(
			`Failed to download from cobalt tunnel: ${response.status}`
		);
	}

	// biome-ignore lint/correctness/noUndeclaredVariables: Global Bun
	const uuid = Bun.randomUUIDv7();
	const filePath = path.join(folder, `${uuid}.mp4`);

	// biome-ignore lint/correctness/noUndeclaredVariables: Global Bun
	await Bun.write(filePath, response);

	return filePath;
}

export async function downloadViaCobalt(
	url: string,
	folder: string
): Promise<CobaltVideoResult[]> {
	const apiUrl = env.COBALT_API_URL;

	if (!apiUrl) {
		throw new Error("Cobalt API URL is not configured");
	}

	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};

	if (env.COBALT_API_KEY) {
		headers.Authorization = `Api-Key ${env.COBALT_API_KEY}`;
	}

	const response = await fetch(apiUrl, {
		method: "POST",
		headers,
		body: JSON.stringify({
			url,
			videoQuality: "1080",
		}),
	});

	if (!response.ok) {
		throw new Error(`Cobalt API returned ${response.status}`);
	}

	const data = (await response.json()) as CobaltResponse;

	if (data.status === "error") {
		throw new Error(`Cobalt error: ${data.error.code}`);
	}

	const results: CobaltVideoResult[] = [];

	if (data.status === "tunnel" || data.status === "redirect") {
		const filePath = await downloadFromTunnelUrl(data.url, folder);
		results.push({ filePath, metadata: {} });
	} else if (data.status === "picker") {
		for (const item of data.picker) {
			if (item.type === "video") {
				const filePath = await downloadFromTunnelUrl(item.url, folder);
				results.push({ filePath, metadata: {} });
			}
		}
	}

	if (results.length === 0) {
		throw new Error("No video found in cobalt response");
	}

	logger.debug("Downloaded %d video(s) via cobalt for %s", results.length, url);

	return results;
}
