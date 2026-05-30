import { FetchHttpClient } from "@effect/platform";
import { EmbeddingsService } from "@starlight/api/services/embeddings";
import { Layer, ManagedRuntime } from "effect";
import { FetchExtractor } from "@/services/extractors/fetch";
import { ParallelExtractor } from "@/services/extractors/parallel";
import { WorkersExtractor } from "@/services/extractors/workers";

export const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		FetchHttpClient.layer,
		FetchExtractor.Service.Default,
		WorkersExtractor.Service.Default,
		ParallelExtractor.Service.Default,
		EmbeddingsService.Service.Default,
	),
);
