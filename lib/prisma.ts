import { PrismaClient } from "@prisma/client";

// One client per process. Next's dev server hot-reloads modules, which would
// otherwise open a new connection pool on every edit until SQLite complains.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
