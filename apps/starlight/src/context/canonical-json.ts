import { Schema } from "effect";

export namespace CanonicalJson {
  // Raw Prisma JSON columns and provider outputs meet at this deterministic boundary.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary accepts untrusted JSON-shaped values
  export function encode(value: unknown): string {
    return JSON.stringify(
      canonicalize(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(value))),
    );
  }

  function canonicalize(value: typeof Schema.Json.Type): typeof Schema.Json.Type {
    if (Array.isArray(value)) return value.map(canonicalize);

    if (value === null || typeof value !== "object") return value;

    return Object.fromEntries(
      Object.entries(value)
        .toSorted((left, right) => left[0].localeCompare(right[0]))
        .map((entry) => [entry[0], canonicalize(entry[1])]),
    );
  }
}
