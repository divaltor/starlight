import type { Prisma } from "@starlight/utils/generated/prisma/client";

export namespace CanonicalJson {
  // Raw Prisma JSON columns and provider outputs meet at this deterministic boundary.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary accepts untrusted JSON-shaped values
  export function encode(value: unknown): string {
    return JSON.stringify(canonicalize(value as Prisma.InputJsonValue));
  }

  function canonicalize(value: Prisma.InputJsonValue): Prisma.InputJsonValue {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value === null || typeof value !== "object") return value;

    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .toSorted((left, right) => left[0].localeCompare(right[0]))
        .map((entry) => [entry[0], canonicalize(entry[1])]),
    );
  }
}
