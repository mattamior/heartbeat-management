import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPortCanBind, findListeningPids } from '../server/ports.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listeningPort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate port');
  return address.port;
}

describe('assertPortCanBind', () => {
  it('rejects a port that cannot be bound even before a child process is launched', async () => {
    await expect(assertPortCanBind(await listeningPort())).rejects.toThrow('无法绑定');
  });

  it('finds a Linux listener without depending on lsof', async () => {
    const port = await listeningPort();
    const pids = await findListeningPids(port);
    expect(pids.length).toBeGreaterThan(0);
  });
});
