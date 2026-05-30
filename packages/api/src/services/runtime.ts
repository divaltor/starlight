import { FetchHttpClient } from "@effect/platform";
import { Layer, ManagedRuntime } from "effect";
import { EmbeddingsService } from "./embeddings";

export const runtime = ManagedRuntime.make(
	Layer.mergeAll(FetchHttpClient.layer, EmbeddingsService.Service.Default),
);
