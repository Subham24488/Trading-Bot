import { PrismaClient } from '@prisma/client';

export const database = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
