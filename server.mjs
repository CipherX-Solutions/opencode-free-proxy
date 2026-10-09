import express from 'express';
import cors from 'cors';
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

const KEYS_FILE = process.env.KEYS_FILE || path.join(__dirname, 'api-keys.json');

// Health Check Root
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
