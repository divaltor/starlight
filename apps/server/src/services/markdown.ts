import { FetchExtractor } from "@/services/extractors/fetch";
import { WorkersExtractor } from "@/services/extractors/workers";

const fetchExtractor = new FetchExtractor();
const workersExtractor = new WorkersExtractor();

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

	return null;
}
