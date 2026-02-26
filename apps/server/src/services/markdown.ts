import { FetchExtractor } from "@/services/extractors/fetch";
import { WorkersExtractor } from "@/services/extractors/workers";
import { ParallelExtractor } from "@/services/extractors/parallel";

const fetchExtractor = new FetchExtractor();
const workersExtractor = new WorkersExtractor();
const parallelExtractor = new ParallelExtractor();

export async function extractMarkdown(url: string): Promise<string | null> {
	const fetchResult = await fetchExtractor.extract(url);

	if (fetchResult?.kind === "markdown") {
		return fetchResult.content;
	}

	if (fetchResult?.kind === "html" && workersExtractor.isEnabled()) {
		const workersResult = await workersExtractor.extract({
			name: "page.html",
			data: fetchResult.content,
			type: "text/html",
		});

		if (workersResult) {
			return workersResult.content;
		}
	}

	if (parallelExtractor.isEnabled()) {
		const parallelResult = await parallelExtractor.extract(url);

		if (parallelResult) {
			return parallelResult.content;
		}
	}

	return null;
}
