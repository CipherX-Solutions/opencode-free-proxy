import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Enable CORS for all incoming requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));

app.use(express.json({ limit: '10mb' }));

// ── API Keys ───────────────────────────────────────────────────────
// KEYS_FILE may be relative to the app working directory or absolute.
// If the file is missing or empty, two local proxy keys are generated once.
const KEYS_FILE = process.env.KEYS_FILE || path.join(__dirname, 'api-keys.json');
let apiKeys = {};

function loadKeys() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      apiKeys = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === 'string' && value.trim())
      );
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[AUTH] Could not read ${KEYS_FILE}; generating a new key file.`);
    }
  }

  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: 'oc-' + crypto.randomBytes(20).toString('hex'),
      'user-default': 'oc-' + crypto.randomBytes(20).toString('hex')
    };

    try {
      const dir = path.dirname(KEYS_FILE);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2) + '\n', { mode: 0o600 });
      console.log(`[AUTH] Generated API keys at ${KEYS_FILE}`);
    } catch (error) {
      console.error(`[AUTH] Failed to write ${KEYS_FILE}:`, error?.message || error);
      throw error;
    }
  } else {
    console.log(`[AUTH] Loaded ${Object.keys(apiKeys).length} API key(s) from ${KEYS_FILE}`);
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

// Health Check Root
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    domain: 'AI.cpxs.ca',
    auth: 'enabled',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    auth: 'enabled',
    keysLoaded: Object.keys(apiKeys).length
  });
});

// Models Endpoint
app.get('/v1/models', (req, res) => {
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

// Chat Endpoint
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

// Hostinger injects PORT. PROXY_PORT remains available for local/VPS use.
const PORT = Number(process.env.PORT || process.env.PROXY_PORT || 6446);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server active on port ${PORT}`);
});
