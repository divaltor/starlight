import { ManagedRuntime } from "effect";
import * as EmbeddingsService from "./embeddings";

export const runtime = ManagedRuntime.make(EmbeddingsService.defaultLayer);
