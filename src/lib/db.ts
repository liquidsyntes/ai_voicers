import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalDb.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
if (process.env.NODE_ENV !== 'production') globalDb.prisma = db;

export async function owner() {
  return db.owner.upsert({ where: { id: '00000000-0000-4000-8000-000000000001' }, create: { id: '00000000-0000-4000-8000-000000000001', settings: { create: {} } }, update: {} });
}
