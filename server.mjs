import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

// ── API Keys ───────────────────────────────────────────────────────
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

  // Reuse a previously generated fallback file if the app directory is
  // read-only but the host preserves /tmp for the running instance.
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
    // Do not crash the web server solely because the filesystem is read-only.
    // Authentication still works for this process with the generated keys,
    // although they will be regenerated after a restart.
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

// ── Health ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'online',
    domain: 'AI.cpxs.ca',
    auth: 'enabled',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    auth: 'enabled',
    keysLoaded: Object.keys(apiKeys).length,
    keyStorage: activeKeysFile === 'memory-only' ? 'memory' : 'file'
  });
});

// ── Models ─────────────────────────────────────────────────────────
app.get('/v1/models', (_req, res) => {
  res.status(200).json({
    object: 'list',
    data: [
      {
        id: 'deepseek-v4-flash-free',
        object: 'model',
        created: 1700000000,
        owned_by: 'opencode-proxy'
      }
    ]
  });
});

// ── Chat endpoint ──────────────────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({
      error: { message: 'Invalid API key' }
    });
  }

  try {
    const { model, messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: { message: 'Invalid payload: "messages" array required.' }
      });
    }

    return res.status(200).json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'deepseek-v4-flash-free',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello! Your Hostinger Node.js proxy at AI.cpxs.ca is fully operational.'
          },
          finish_reason: 'stop'
        }
      ]
    });
  } catch (error) {
    console.error('Proxy Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Start ──────────────────────────────────────────────────────────
// Hostinger injects PORT. PROXY_PORT is retained for VPS/local use.
const requestedPort = process.env.PORT || process.env.PROXY_PORT || '6446';
const PORT = Number.parseInt(requestedPort, 10);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[STARTUP] Invalid port value: ${requestedPort}`);
  process.exit(1);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[STARTUP] Server active on 0.0.0.0:${PORT}`);
  console.log(`[STARTUP] Key storage: ${activeKeysFile}`);
});

server.on('error', (error) => {
  console.error('[STARTUP] Failed to listen:', error);
  process.exit(1);
});
