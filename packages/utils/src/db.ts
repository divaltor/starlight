import { PrismaPg } from "@prisma/adapter-pg";
import Sqids from "sqids";
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
  if (args.where?.deletedAt !== undefined) {
    return args;
  }

  args.where = {
    ...args.where,
    deletedAt: null,
  };

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

export const prisma = new PrismaClient({
  log: databaseEnv.NODE_ENV === "production" ? ["warn", "error"] : ["info", "warn", "error"],
  adapter,
}).$extends({
  query: {
    message: {
      $allOperations({ operation, args, query }) {
        if (MESSAGE_READ_OPERATIONS.has(operation)) {
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
    photo: {
      externalId: {
        needs: {
          id: true,
          userId: true,
        },
        compute(data: { id: string; userId: string }) {
          // Split Twitter ID into 3 parts to handle large numbers that exceed bigint
          const { id } = data;
          const chunkSize = Math.ceil(id.length / 3);

          const parts = [id.slice(0, chunkSize), id.slice(chunkSize, chunkSize * 2), id.slice(chunkSize * 2)].map(
            (part) => Math.trunc(Number(part || "0")),
          );

          const userId = Buffer.from(data.userId.replaceAll("-", ""), "hex");

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
    photo: {
      available: (): PrismaGenerated.PhotoWhereInput => ({
        deletedAt: null,
        s3Path: { not: null },
      }),
    },
    tweet: {
      available: (): PrismaGenerated.TweetWhereInput => ({
        photos: {
          some: {
            deletedAt: null,
            s3Path: { not: null },
          },
        },
      }),
    },
  },
});
