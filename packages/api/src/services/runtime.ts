import { ManagedRuntime } from "effect";
import { EmbeddingsService } from "./embeddings";

export const runtime = ManagedRuntime.make(EmbeddingsService.defaultLayer);
