import { buildApp } from './app.js';

const configuredPort = process.env.HEARTBEAT_PORT ?? '27100';
const port = Number(configuredPort);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('HEARTBEAT_PORT 必须是 1 到 65535 之间的整数');
}

const app = await buildApp();
await app.listen({ host: '127.0.0.1', port });
console.log(`Heartbeat Management listening at http://127.0.0.1:${port}`);
