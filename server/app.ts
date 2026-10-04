import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './store.js';

const nameSchema = z.string().trim().min(1, 'Please enter your name.').max(40, 'Names can be up to 40 characters.');
const locationSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000),
  timestamp: z.number().int().refine((value) => value <= Date.now() + 30000 && value > Date.now() - 120000, 'Location is too old. Please get a fresh position.'),
}).strict();
const updateSchema = z.object({ name: nameSchema.optional(), sharing: z.boolean().optional(), location: locationSchema.nullable().optional() })
  .strict().refine((data) => !(data.sharing === false && data.location), 'A paused location cannot be shared.');
interface Subscriber { response: Response; participantId: string }
interface Options { databasePath?: string; publicUrl?: string; trustProxy?: boolean; production?: boolean; rateLimits?: boolean }

export function createApp(options: Options = {}) {
  const app = express();
  const store = new Store(options.databasePath ?? process.env.DATABASE_PATH ?? './data/onmyway.sqlite');
  const subscribers = new Map<string, Set<Subscriber>>();
  const publicOrigin = options.publicUrl ? new URL(options.publicUrl).origin : undefined;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  if (options.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: production ? { directives: {
      'img-src': ["'self'", 'data:', 'https:'], 'style-src': ["'self'", "'unsafe-inline'"],
      'connect-src': ["'self'"], 'upgrade-insecure-requests': null,
    } } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: options.publicUrl?.startsWith('https:') ? undefined : false,
  }));
  app.use(express.json({ limit: '4kb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, res, next) => {
    if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      const expectedOrigin = publicOrigin ?? `${req.protocol}://${req.get('host')}`;
      if (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== expectedOrigin)) {
        res.status(403).json({ error: 'Please open this meeting on its original website.' }); return;
      }
      if (req.method !== 'DELETE' && !req.is('application/json')) {
        res.status(415).json({ error: 'Use application/json for this request.' }); return;
      }
    }
    next();
  });
  if (options.rateLimits !== false) {
    app.use('/api', rateLimit({ windowMs: 60000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please wait a minute.' } }));
    app.post('/api/sessions', rateLimit({ windowMs: 3600000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'You have created a lot of meetings. Please try again in an hour.' } }));
    app.post('/api/sessions/:id/join', rateLimit({ windowMs: 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Please wait a minute before joining again.' } }));
  }

  const cookieName = (id: string) => `omw_${id}`;
  const tokenFor = (req: Request, id: string) => {
    const cookie = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${cookieName(id)}=`));
    return cookie?.slice(cookie.indexOf('=') + 1);
  };
  const setCookie = (req: Request, res: Response, id: string, token: string) => res.cookie(cookieName(id), token, {
    httpOnly: true, sameSite: 'lax', secure: req.secure || Boolean(options.publicUrl?.startsWith('https:')),
    maxAge: 86400000, path: `/api/sessions/${id}`,
  });
  const member = (req: Request) => store.authenticate(String(req.params.id), tokenFor(req, String(req.params.id)));
  const sessionRequired = (req: Request, res: Response, next: NextFunction) => {
    if (!/^[a-f0-9]{32}$/.test(String(req.params.id)) || !store.session(String(req.params.id))) {
      res.status(404).json({ error: 'This meeting has expired or the link is invalid.' }); return;
    }
    next();
  };
  const memberRequired = (req: Request, res: Response, next: NextFunction) => {
    if (!member(req)) { res.status(401).json({ error: 'Join this meeting to see and share locations.' }); return; }
    next();
  };
  function broadcast(id: string) {
    const clients = subscribers.get(id);
    if (!clients) return;
    for (const client of clients) {
      if (!store.session(id)) {
        client.response.write('event: expired\ndata: {}\n\n'); client.response.end();
      } else {
        const snapshot = store.snapshot(id, client.participantId);
        if (!snapshot.participants.some((p) => p.id === client.participantId)) {
          client.response.write('event: removed\ndata: {}\n\n'); client.response.end();
        } else client.response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      }
    }
  }

  app.get('/api/health', (_req, res) => { store.db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
  app.get('/api/config', (_req, res) => res.json({
    tileUrl: process.env.MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: process.env.MAP_ATTRIBUTION ?? '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    maxZoom: Number(process.env.MAP_MAX_ZOOM ?? 19),
  }));
  app.post('/api/sessions', (req, res) => {
    const { name } = z.object({ name: nameSchema }).strict().parse(req.body);
    const result = store.create(name);
    setCookie(req, res, result.id, result.token);
    res.status(201).json(store.snapshot(result.id, result.participantId));
  });
  app.use('/api/sessions/:id', sessionRequired);
  app.get('/api/sessions/:id', (req, res) => res.json(store.snapshot(String(req.params.id), member(req)?.id ?? null)));
  app.post('/api/sessions/:id/join', (req, res) => {
    const { name } = z.object({ name: nameSchema }).strict().parse(req.body);
    const existing = member(req);
    if (existing) {
      store.update(existing.id, { name }); broadcast(String(req.params.id));
      res.json(store.snapshot(String(req.params.id), existing.id)); return;
    }
    const result = store.join(String(req.params.id), name);
    setCookie(req, res, String(req.params.id), result.token);
    broadcast(String(req.params.id));
    res.status(201).json(store.snapshot(String(req.params.id), result.participantId));
  });
  app.patch('/api/sessions/:id/me', memberRequired, (req, res) => {
    const input = updateSchema.parse(req.body);
    store.update(member(req)!.id, input);
    broadcast(String(req.params.id));
    res.json(store.snapshot(String(req.params.id), member(req)!.id));
  });
  app.delete('/api/sessions/:id/me', memberRequired, (req, res) => {
    store.remove(member(req)!.id);
    res.clearCookie(cookieName(String(req.params.id)), { path: `/api/sessions/${req.params.id}`, httpOnly: true, sameSite: 'lax' });
    broadcast(String(req.params.id));
    res.status(204).end();
  });
  app.get('/api/sessions/:id/events', memberRequired, (req, res) => {
    const id = String(req.params.id);
    const participantId = member(req)!.id;
    const clients = subscribers.get(id) ?? new Set<Subscriber>();
    if (clients.size >= 48 || [...clients].filter((c) => c.participantId === participantId).length >= 4) {
      res.status(429).json({ error: 'Too many open tabs for this meeting.' }); return;
    }
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const client = { response: res, participantId };
    clients.add(client); subscribers.set(id, clients);
    res.write(`event: snapshot\ndata: ${JSON.stringify(store.snapshot(id, participantId))}\n\n`);
    res.on('close', () => { clients.delete(client); if (!clients.size) subscribers.delete(id); });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));

  const clientPath = resolve('dist/client');
  if (existsSync(clientPath)) {
    app.use(express.static(clientPath, { maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(resolve(clientPath, 'index.html')); });
  }
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid request.' }); return; }
    if (error.message === 'SESSION_FULL') { res.status(409).json({ error: 'This meeting is full. Up to 12 people can join.' }); return; }
    if (error.status === 400 || error.status === 413) { res.status(error.status).json({ error: 'Invalid request body.' }); return; }
    console.error(error);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  const heartbeat = setInterval(() => { for (const id of subscribers.keys()) broadcast(id); }, 10000);
  const cleanup = setInterval(() => { store.cleanup(); for (const id of subscribers.keys()) broadcast(id); }, 60000);
  heartbeat.unref(); cleanup.unref(); store.cleanup();
  return { app, store, close: () => {
    clearInterval(heartbeat); clearInterval(cleanup);
    for (const clients of subscribers.values()) for (const client of clients) client.response.end();
    subscribers.clear(); store.close();
  } };
}
