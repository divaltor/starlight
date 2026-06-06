import { EmbeddingsService } from "@starlight/api/services/embeddings";
import { Layer, ManagedRuntime } from "effect";
import { ExaExtractor } from "@/services/extractors/exa";
import { FetchExtractor } from "@/services/extractors/fetch";
import { ParallelExtractor } from "@/services/extractors/parallel";
import { WorkersExtractor } from "@/services/extractors/workers";
import { TwitterApi } from "@/services/twitter-api";

export const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		FetchExtractor.defaultLayer,
		ExaExtractor.defaultLayer,
		WorkersExtractor.defaultLayer,
		ParallelExtractor.defaultLayer,
		TwitterApi.defaultLayer,
		EmbeddingsService.defaultLayer,
	),
);
