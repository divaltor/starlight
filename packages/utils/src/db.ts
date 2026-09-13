import { PrismaPg } from "@prisma/adapter-pg";
import Sqids from "sqids";
import { parse } from "uuid";
import databaseEnv from "./database-env";
import { PrismaClient } from "./generated/prisma/client";
import type { Prisma as PrismaGenerated } from "./generated/prisma/client";

const sqids = new Sqids({
  minLength: 12,
});

export const toUniqueId = (id: number) => sqids.encode([Math.abs(id)]);

const adapter = new PrismaPg({
  connectionString: databaseEnv.DATABASE_URL,
});

const onlyNotDeletedMessages = <
  T extends {
    where?: PrismaGenerated.MessageWhereInput;
  },
>(
  args: T,
): T => {
  const { where } = args;
  if (where?.deletedAt !== undefined) {
    return args;
  }

  args.where = {
    ...args.where,
    deletedAt: null,
  } as PrismaGenerated.MessageWhereInput;

  return args;
};

const MESSAGE_READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

const isMessageReadOperation = (operation: string) => MESSAGE_READ_OPERATIONS.has(operation);

export const prisma = new PrismaClient({
  log: databaseEnv.NODE_ENV === "production" ? ["warn", "error"] : ["info", "warn", "error"],
  adapter,
}).$extends({
  query: {
    message: {
      $allOperations({ operation, args, query }) {
        if (isMessageReadOperation(operation)) {
          return query(
            onlyNotDeletedMessages(
              args as {
                where?: PrismaGenerated.MessageWhereInput;
              },
            ),
          );
        }

        return query(args);
      },
    },
  },
  result: {
    media: {
      externalId: {
        needs: {
          id: true,
          provider: true,
          userId: true,
        },
        compute(data: { id: string; provider: string; userId: string }) {
          if (data.provider !== "twitter") {
            return `${data.provider}:${data.id}`;
          }
          // Split Twitter ID into 3 parts to handle large numbers that exceed bigint
          const { id } = data;
          const chunkSize = Math.ceil(id.length / 3);

          const parts = [id.slice(0, chunkSize), id.slice(chunkSize, chunkSize * 2), id.slice(chunkSize * 2)].map(
            (part) => Math.trunc(Number(part || "0")),
          );

          const userId = parse(data.userId);

          return sqids.encode([...parts, ...userId]);
        },
      },
      s3Url: {
        needs: {
          s3Path: true,
        },
        compute(data: { s3Path: string }) {
          if (!(data.s3Path && databaseEnv.BASE_CDN_URL)) {
            return;
          }

          return `${databaseEnv.BASE_CDN_URL}/${data.s3Path}`;
        },
      },
    },
    chat: {
      thumbnailUrl: {
        needs: {
          photoThumbnail: true,
        },
        compute(data: { photoThumbnail: string }) {
          if (!data.photoThumbnail) {
            return;
          }

          return `${databaseEnv.BASE_CDN_URL}/${data.photoThumbnail}`;
        },
      },
      bigUrl: {
        needs: {
          photoBig: true,
        },
        compute(data: { photoBig: string }) {
          if (!(data.photoBig && databaseEnv.BASE_CDN_URL)) {
            return;
          }

          return `${databaseEnv.BASE_CDN_URL}/${data.photoBig}`;
        },
      },
    },
  },
  model: {
    media: {
      available: () => ({
        deletedAt: null,
        s3Path: { not: null },
      }),
    } satisfies Record<string, (...args: never[]) => PrismaGenerated.MediaWhereInput>,
    post: {
      available: () => ({
        media: {
          some: {
            deletedAt: null,
            s3Path: { not: null },
          },
        },
      }),
    } satisfies Record<string, (...args: never[]) => PrismaGenerated.PostWhereInput>,
  },
});
