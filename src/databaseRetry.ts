import { database } from './database.js';

/**
 * Neon's free plan suspends the database after 5 minutes without queries and drops every open
 * connection; Prisma then logs `Error in PostgreSQL connection: Error { kind: Closed }` and the
 * next query on that connection can fail. These helpers retry such a query once and keep the
 * database awake while the decision loop needs it.
 */

/** Prisma codes for a server that is unreachable, timed out connecting or closed the connection. */
const CONNECTION_ERROR_CODES = new Set(['P1001', 'P1002', 'P1017']);
const CONNECTION_ERROR_TEXT =
  /closed the connection|connection (?:reset|closed|terminated)|kind: Closed|ECONNRESET/i;

/** Pause before the retry, while a suspended database wakes up (usually well under a second). */
export const RECONNECT_DELAY_MS = 1_000;

export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { code, errorCode } = error as { code?: unknown; errorCode?: unknown };
  const prismaCode = typeof code === 'string' ? code : errorCode;
  if (typeof prismaCode === 'string' && CONNECTION_ERROR_CODES.has(prismaCode)) {
    return true;
  }
  return CONNECTION_ERROR_TEXT.test(error.message);
}

/**
 * Runs `task`; when it fails because the connection was dropped, waits briefly and runs it once
 * more on a fresh connection. Any other error, or a second failure, is thrown.
 */
export async function withReconnect<T>(
  task: () => Promise<T>,
  delayMs = RECONNECT_DELAY_MS,
): Promise<T> {
  try {
    return await task();
  } catch (error: unknown) {
    if (!isConnectionError(error)) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return task();
  }
}

/** One tiny query, so the database does not suspend between decision cycles. */
export async function pingDatabase(): Promise<void> {
  await withReconnect(() => database.$queryRaw`SELECT 1`);
}
