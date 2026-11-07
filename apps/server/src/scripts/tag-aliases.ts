import { prisma } from "@starlight/utils";
import { logger } from "@/logger";

// Manual script: replace the search tag aliases with the Danbooru aliases from Mexes/danbooru-tag-taxonomy.
// The dataset publishes versioned snapshots rather than continuous updates; bump the revision to import a new one.
// Usage: bun run --cwd apps/server search:aliases

// v1.1, snapshot 2026-10-02
const MEXES_REVISION = "1fc970c943534d2184e5bf8f7a3aba108d483b9b";
const MEXES_TAGS_URL = `https://huggingface.co/datasets/Mexes/danbooru-tag-taxonomy/resolve/${MEXES_REVISION}/tags.csv`;

// The tagger classifies photos into these Danbooru categories only.
const SEARCHABLE_CATEGORIES = new Set(["general", "character"]);
const CSV_FIELD_REGEX = /(?:^|,)(?<field>"(?:[^"]|"")*"|[^,]*)/gu;
const ASCII_REGEX = /^[ -~]+$/u;

const normalize = (name: string) =>
  name.normalize("NFKC").toLowerCase().replaceAll("_", " ").replaceAll(/\s+/gu, " ").trim();

async function main() {
  const response = await fetch(MEXES_TAGS_URL);

  if (!response.ok) {
    throw new Error(`Mexes tags download failed with status ${response.status}`);
  }

  const csv = await response.text();

  // Columns: tag, danbooru_category, category, subcategory, slot, confidence, status, post_count, aliases.
  // No field contains a newline, so every line is one row.
  const rows = csv
    .split("\n")
    .slice(1)
    .flatMap((line) =>
      line === ""
        ? []
        : [
            Array.from(line.matchAll(CSV_FIELD_REGEX), (match) => {
              const field = match.groups!.field!;

              return field.startsWith('"') ? field.slice(1, -1).replaceAll('""', '"') : field;
            }),
          ],
    );

  // Aliased-away names such as `boobs` stay listed as tags with no posts.
  const tagNames = new Set(rows.flatMap((row) => (Number(row[7]) > 0 ? [normalize(row[0]!)] : [])));
  const targets = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!SEARCHABLE_CATEGORIES.has(row[1]!)) {
      continue;
    }

    for (const alias of row[8]!.split(",").map(normalize)) {
      targets.set(alias, (targets.get(alias) ?? new Set()).add(normalize(row[0]!)));
    }
  }

  // Dropped: aliases of several tags (`tails`), aliases that are tags themselves (`hair bun` would widen to
  // `single hair bun`), Danbooru shortcuts (`/p` → panties), and aliases too short to mean anything.
  const aliases = [...targets].flatMap(([alias, tags]) => {
    if (tags.size > 1 || tagNames.has(alias) || alias.startsWith("/")) {
      return [];
    }

    const minLength = ASCII_REGEX.test(alias) ? 3 : 2;

    return alias.length >= minLength ? [{ alias, tag: [...tags][0]! }] : [];
  });

  await prisma.$transaction([prisma.tagAlias.deleteMany(), prisma.tagAlias.createMany({ data: aliases })]);

  logger.info({ revision: MEXES_REVISION, tags: rows.length, aliases: aliases.length }, "Tag aliases replaced");
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
