import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));

app.use(express.json({ limit: '10mb' }));

// ── OpenCode Zen ───────────────────────────────────────────────────
// Use an official OpenCode Zen API key from https://opencode.ai.
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY?.trim() || '';
const OPENCODE_BASE_URL = (process.env.OPENCODE_BASE_URL?.trim() || 'https://opencode.ai/zen/v1').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.OPENCODE_DEFAULT_MODEL?.trim() || 'minimax-m2.5-free';

// ── Local proxy API keys ───────────────────────────────────────────
// Prefer KEYS_FILE when supplied. Otherwise keep the historical
// api-keys.json file beside the application. If that location is not
// writable on managed hosting, fall back to the OS temp directory so a
// filesystem permission problem does not crash the Node process.
const configuredKeysFile = process.env.KEYS_FILE?.trim();
const primaryKeysFile = configuredKeysFile
  ? path.resolve(process.cwd(), configuredKeysFile)
  : path.join(__dirname, 'api-keys.json');
const fallbackKeysFile = path.join(os.tmpdir(), 'opencode-free-proxy', 'api-keys.json');

let apiKeys = {};
let activeKeysFile = primaryKeysFile;

function readKeys(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'string' && value.trim())
    );
  } catch {
    return {};
  }
}

function writeKeys(file, keys) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
}

function loadKeys() {
  apiKeys = readKeys(primaryKeysFile);
  activeKeysFile = primaryKeysFile;

  if (Object.keys(apiKeys).length > 0) {
    console.log(`[AUTH] Loaded ${Object.keys(apiKeys).length} API key(s) from ${activeKeysFile}`);
    return;
  }

  if (fallbackKeysFile !== primaryKeysFile) {
    const fallbackKeys = readKeys(fallbackKeysFile);
    if (Object.keys(fallbackKeys).length > 0) {
      apiKeys = fallbackKeys;
      activeKeysFile = fallbackKeysFile;
      console.log(`[AUTH] Loaded ${Object.keys(apiKeys).length} API key(s) from fallback ${activeKeysFile}`);
      return;
    }
  }

  apiKeys = {
    admin: 'oc-' + crypto.randomBytes(20).toString('hex'),
    'user-default': 'oc-' + crypto.randomBytes(20).toString('hex')
  };

  try {
    writeKeys(primaryKeysFile, apiKeys);
    activeKeysFile = primaryKeysFile;
    console.log(`[AUTH] Generated API keys at ${activeKeysFile}`);
    return;
  } catch (error) {
    console.warn(`[AUTH] Cannot write ${primaryKeysFile}: ${error?.code || error?.message || error}`);
  }

  try {
    writeKeys(fallbackKeysFile, apiKeys);
    activeKeysFile = fallbackKeysFile;
    console.log(`[AUTH] Generated API keys at fallback ${activeKeysFile}`);
  } catch (error) {
    activeKeysFile = 'memory-only';
    console.warn(`[AUTH] Could not persist generated keys: ${error?.code || error?.message || error}`);
  }
}

loadKeys();

function auth(req) {
  const header = String(req.headers.authorization || req.headers['x-api-key'] || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  if (!token) return null;

  for (const [name, key] of Object.entries(apiKeys)) {
    if (token === key) return name;
  }
  return null;
}

function requireOpenCodeKey(res) {
  if (OPENCODE_API_KEY) return true;

  res.status(503).json({
    error: {
      message: 'OpenCode Zen is not configured. Set OPENCODE_API_KEY in the server environment.',
      type: 'configuration_error',
      code: 'opencode_not_configured'
    }
  });
  return false;
}

async function sendUpstreamResponse(upstream, res, wantsStream = false) {
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);

  res.status(upstream.status);

  if (wantsStream && upstream.ok && upstream.body) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  res.send(body);
}

// ── Health ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'online',
    domain: 'AI.cpxs.ca',
    auth: 'enabled',
    opencodeConfigured: Boolean(OPENCODE_API_KEY),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    auth: 'enabled',
    keysLoaded: Object.keys(apiKeys).length,
    keyStorage: activeKeysFile === 'memory-only' ? 'memory' : 'file',
    opencodeConfigured: Boolean(OPENCODE_API_KEY),
    upstream: OPENCODE_BASE_URL
  });
});

// ── Models ─────────────────────────────────────────────────────────
app.get('/v1/models', async (_req, res) => {
  if (!requireOpenCodeKey(res)) return;

  try {
    const upstream = await fetch(`${OPENCODE_BASE_URL}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${OPENCODE_API_KEY}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(30000)
    });

    await sendUpstreamResponse(upstream, res, false);
  } catch (error) {
    console.error('[OPENCODE] Models request failed:', error?.message || error);
    res.status(502).json({
      error: {
        message: 'Could not reach OpenCode Zen.',
        type: 'upstream_error',
        code: 'opencode_unreachable'
      }
    });
  }
});

// ── OpenAI-compatible chat endpoint ────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({
      error: { message: 'Invalid API key' }
    });
  }

  if (!requireOpenCodeKey(res)) return;

  const { model, messages, stream } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: 'Invalid payload: "messages" array required.' }
    });
  }

  const requestBody = {
    ...req.body,
    model: model || DEFAULT_MODEL,
    messages,
    stream: Boolean(stream)
  };

  try {
    console.log(`[OPENCODE] ${user} -> ${requestBody.model} (${requestBody.stream ? 'stream' : 'sync'})`);

    const upstream = await fetch(`${OPENCODE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENCODE_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: requestBody.stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(120000)
    });

    console.log(`[OPENCODE] ${requestBody.model} <- HTTP ${upstream.status}`);
    await sendUpstreamResponse(upstream, res, requestBody.stream);
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    console.error('[OPENCODE] Chat request failed:', error?.message || error);

    res.status(isTimeout ? 504 : 502).json({
      error: {
        message: isTimeout ? 'OpenCode Zen request timed out.' : 'Could not reach OpenCode Zen.',
        type: isTimeout ? 'timeout_error' : 'upstream_error',
        code: isTimeout ? 'opencode_timeout' : 'opencode_unreachable'
      }
    });
  }
});

// ── Start ──────────────────────────────────────────────────────────
// Hostinger managed Node.js apps expect the application on port 3000.
// Respect PORT when the platform supplies it, then PROXY_PORT for VPS/local use.
const requestedPort = process.env.PORT || process.env.PROXY_PORT || '3000';
const PORT = Number.parseInt(requestedPort, 10);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[STARTUP] Invalid port value: ${requestedPort}`);
  process.exit(1);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[STARTUP] Server active on 0.0.0.0:${PORT}`);
  console.log(`[STARTUP] Key storage: ${activeKeysFile}`);
  console.log(`[STARTUP] OpenCode Zen configured: ${Boolean(OPENCODE_API_KEY)}`);
});

server.on('error', (error) => {
  console.error('[STARTUP] Failed to listen:', error);
  process.exit(1);
});
