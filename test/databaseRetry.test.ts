import { describe, expect, it, vi } from 'vitest';

const queryRaw = vi.fn().mockResolvedValue([{ ok: 1 }]);

vi.mock('../src/database.js', () => ({ database: { $queryRaw: queryRaw } }));

const { isConnectionError, pingDatabase, withReconnect } = await import('../src/databaseRetry.js');

const dropped = () =>
  Object.assign(new Error('Server has closed the connection.'), { code: 'P1017' });

describe('database reconnect', () => {
  it('recognises a dropped or unreachable connection, not other database errors', () => {
    expect(isConnectionError(dropped())).toBe(true);
    expect(isConnectionError(Object.assign(new Error('unreachable'), { errorCode: 'P1001' }))).toBe(
      true,
    );
    expect(
      isConnectionError(new Error('Error in PostgreSQL connection: Error { kind: Closed }')),
    ).toBe(true);
    expect(isConnectionError(Object.assign(new Error('duplicate'), { code: 'P2002' }))).toBe(false);
    expect(isConnectionError('Closed')).toBe(false);
  });

  it('retries a query once after a dropped connection', async () => {
    const task = vi.fn().mockRejectedValueOnce(dropped()).mockResolvedValueOnce('stored');
    await expect(withReconnect(task, 0)).resolves.toBe('stored');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors and gives up after a second dropped connection', async () => {
    const constraint = Object.assign(new Error('duplicate'), { code: 'P2002' });
    const failing = vi.fn().mockRejectedValue(constraint);
    await expect(withReconnect(failing, 0)).rejects.toBe(constraint);
    expect(failing).toHaveBeenCalledTimes(1);
    const twice = vi.fn().mockRejectedValue(dropped());
    await expect(withReconnect(twice, 0)).rejects.toThrow('closed the connection');
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it('pings with a one-row query', async () => {
    await pingDatabase();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
