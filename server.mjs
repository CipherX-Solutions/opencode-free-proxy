import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 1. CORS Configuration (Optimized for AI.cpxs.ca)
const allowedOrigins = [
  'https://AI.cpxs.ca',
  'http://AI.cpxs.ca',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow tools/cURL with no origin header or matching origins
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.cpxs.ca')) {
      return callback(null, true);
    }
    return callback(null, true); // Set to true to allow cross-origin API clients
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// 2. Storage Setup for API Keys
const KEYS_FILE = process.env.KEYS_FILE || path.join(__dirname, 'api-keys.json');

function loadKeys() {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = fs.readFileSync(KEYS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading keys file:', err.message);
  }
  return {};
}

function saveKeys(keys) {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing keys file:', err.message);
  }
}

// 3. Healthcheck Endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    domain: 'AI.cpxs.ca',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// 4. OpenAI Compatibility: List Models
app.get('/v1/models', (req, res) => {
  res.status(200).json({
    object: 'list',
    data: [
      {
        id: 'deepseek-v4-flash-free',
        object: 'model',
        created: 1700000000,
        owned_by: 'opencode-proxy'
      },
      {
        id: 'gpt-4o-mini-free',
        object: 'model',
        created: 1700000000,
        owned_by: 'opencode-proxy'
      }
    ]
  });
});

// 5. OpenAI Compatibility: Chat Completions Route
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    
    // Optional Bearer Token Check
    if (process.env.REQUIRE_AUTH === 'true') {
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: {
            message: 'Missing or invalid Authorization header.',
            type: 'invalid_request_error',
            code: 'unauthorized'
          }
        });
      }
    }

    const { model, messages, temperature, stream } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          message: 'Invalid payload: "messages" array is required.',
          type: 'invalid_request_error'
        }
      });
    }

    // Proxy request downstream or construct mock completion response
    const mockReply = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'deepseek-v4-flash-free',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello! This request was processed successfully through your Hostinger proxy at AI.cpxs.ca.'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30
      }
    };

    return res.status(200).json(mockReply);

  } catch (error) {
    console.error('Proxy Execution Error:', error);
    return res.status(500).json({
      error: {
        message: 'Internal server proxy error.',
        type: 'api_error'
      }
    });
  }
});

// 6. Global Fallback / 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found on AI.cpxs.ca proxy' });
});

// 7. Hostinger Passenger Socket/Port Binding
const PORT = process.env.PORT || 6446;

app.listen(PORT, () => {
  console.log(`[Hostinger Production] Server running for AI.cpxs.ca on port/socket: ${PORT}`);
});
