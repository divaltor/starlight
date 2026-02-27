import env from "@starlight/utils/config";
import { http } from "@starlight/utils/http";
import type { ExtractionFile, ExtractionResult } from "@/services/extractors/base";
import { logger } from "@/logger";

export class WorkersExtractor {
	isEnabled(): boolean {
		return !!env.CLOUDFLARE_ACCOUNT_ID && !!env.CLOUDFLARE_API_TOKEN;
	}

	async extract(file: ExtractionFile): Promise<ExtractionResult | null> {
		logger.info(
			"WorkersExtractor: Starting extraction for file %s (type: %s)",
			file.name,
			file.type,
		);

		const blob = new Blob([file.data], { type: file.type });
		const form = new FormData();
		form.append("files", blob, file.name);

		const response = await http.post(
			`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown`,
			{
				headers: {
					Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				},
				body: form,
			},
		);

		if (!response.ok) {
			logger.info(
				"WorkersExtractor: Cloudflare API request failed for %s, status %s",
				file.name,
				response.status,
			);
			return null;
		}

		const results = (await response.json()) as {
			result: Array<{ format: "markdown" | "error"; data?: string; error?: string }>;
		};

		const first = results.result[0];
		if (!first || first.format !== "markdown" || !first.data) {
			logger.info("WorkersExtractor: Invalid or error result for %s", file.name);
			return null;
		}

		logger.info(
			"WorkersExtractor: Successfully extracted markdown from %s (%s bytes)",
			file.name,
			first.data.length,
		);
		return { kind: "markdown", content: first.data };
	}
}
