import env from "@starlight/utils/config";
import { http } from "@starlight/utils/http";
import type { Extractor, ExtractionResult } from "@/services/extractors/base";

interface ParallelExtractResponse {
	results: Array<{
		url: string;
		title: string | null;
		full_content: string | null;
		excerpts: string[] | null;
	}>;
	errors: Array<{
		url: string;
		error_type: string;
		content: string;
	}>;
}

export class ParallelExtractor implements Extractor {
	isEnabled(): boolean {
		return !!env.PARALLEL_API_KEY;
	}

	async extract(url: string): Promise<ExtractionResult | null> {
		const response = await http.post(`${env.PARALLEL_API_BASE_URL}/v1beta/extract`, {
			headers: {
				"Content-Type": "application/json",
				"x-api-key": env.PARALLEL_API_KEY!,
				"parallel-beta": env.PARALLEL_EXTRACT_BETA,
			},
			body: JSON.stringify({
				urls: [url],
				objective: "Extract the main topic, key points, and a brief summary of the page content",
				full_content: false,
				excerpts: true,
			}),
		});

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as ParallelExtractResponse;

		const result = data.results[0];
		if (!result?.excerpts?.length) {
			return null;
		}

		return { kind: "markdown", content: result.excerpts.join("\n\n") };
	}
}
