import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3001);
const runtime = createApp({ publicUrl: process.env.PUBLIC_URL, trustProxy: process.env.TRUST_PROXY === '1' });
const server = runtime.app.listen(port, '0.0.0.0', () => console.log(`On My Way is listening on http://localhost:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    runtime.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
