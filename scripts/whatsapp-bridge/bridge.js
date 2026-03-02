#!/usr/bin/env node
/**
 * Hermes Agent WhatsApp Bridge
 *
 * Standalone Node.js process that connects to WhatsApp via Baileys
 * and exposes HTTP endpoints for the Python gateway adapter.
 *
 * Endpoints (matches gateway/platforms/whatsapp.py expectations):
 *   GET  /messages       - Long-poll for new incoming messages
 *   POST /send           - Send a message { chatId, message, replyTo? }
 *   POST /edit           - Edit a sent message { chatId, messageId, message }
 *   POST /send-audio     - Send audio as voice message (PTT) { chatId, audioPath }
 *   POST /typing         - Send typing indicator { chatId }
 *   GET  /chat/:id       - Get chat info
 *   GET  /media/:filename - Serve cached media files
 *   GET  /health         - Health check
 *
 * Usage:
 *   node bridge.js --port 3000 --session ~/.hermes/whatsapp/session
 */

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import express from 'express';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import qrcode from 'qrcode-terminal';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg('port', '3000'), 10);
const SESSION_DIR = getArg('session', path.join(process.env.HOME || '~', '.hermes', 'whatsapp', 'session'));
const PAIR_ONLY = args.includes('--pair-only');
const ALLOWED_USERS = (process.env.WHATSAPP_ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

mkdirSync(SESSION_DIR, { recursive: true });

// Media cache directory for downloaded audio/images
const MEDIA_CACHE_DIR = path.join(process.env.HOME || '~', '.hermes', 'whatsapp', 'media_cache');
mkdirSync(MEDIA_CACHE_DIR, { recursive: true });

const logger = pino({ level: 'warn' });

// Message queue for polling
const messageQueue = [];
const MAX_QUEUE_SIZE = 100;

let sock = null;
let connectionState = 'disconnected';

// Per-chat active/paused state (true = active, false = paused)
// Default: paused (not in map means paused — user must /start first)
// Persisted to disk so state survives restarts.
const CHAT_STATE_FILE = path.join(SESSION_DIR, 'chat_state.json');
const chatState = new Map();

function loadChatState() {
  try {
    if (existsSync(CHAT_STATE_FILE)) {
      const data = JSON.parse(readFileSync(CHAT_STATE_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) chatState.set(k, v);
      console.log(`📋 Loaded chat state: ${chatState.size} chats`);
    }
  } catch (err) {
    console.error('Failed to load chat state:', err.message);
  }
}

function saveChatState() {
  try {
    const obj = Object.fromEntries(chatState);
    writeFileSync(CHAT_STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('Failed to save chat state:', err.message);
  }
}

loadChatState();

async function sendCommandResponse(chatId, text) {
  if (!sock || connectionState !== 'connected') return;
  try {
    await sock.sendMessage(chatId, { text: `⚕ *Hermes Agent*\n────────────\n${text}` });
  } catch (err) {
    console.error('Failed to send command response:', err.message);
  }
}

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Hermes Agent', 'Chrome', '120.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWaiting for scan...\n');
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionState = 'disconnected';

      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Delete session and restart to re-authenticate.');
        process.exit(1);
      } else {
        // 515 = restart requested (common after pairing). Always reconnect.
        if (reason === 515) {
          console.log('↻ WhatsApp requested restart (code 515). Reconnecting...');
        } else {
          console.log(`⚠️  Connection closed (reason: ${reason}). Reconnecting in 3s...`);
        }
        setTimeout(startSocket, reason === 515 ? 1000 : 3000);
      }
    } else if (connection === 'open') {
      connectionState = 'connected';
      console.log('✅ WhatsApp connected!');
      if (PAIR_ONLY) {
        console.log('✅ Pairing complete. Credentials saved.');
        // Give Baileys a moment to flush creds, then exit cleanly
        setTimeout(() => process.exit(0), 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const chatId = msg.key.remoteJid;
      const senderId = msg.key.participant || chatId;
      const isGroup = chatId.endsWith('@g.us');
      const senderNumber = senderId.replace(/@.*/, '');

      // For own messages: allow /start, /stop, /continue commands in ANY chat,
      // but only queue regular messages from self-chat ("Message Yourself").
      if (msg.key.fromMe) {
        // Quick-extract text to check for commands
        const quickBody = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase();
        const isCommand = quickBody === '/start' || quickBody === '/continue' || quickBody === '/stop';

        if (!isCommand) {
          // Regular message: skip in groups and status
          if (isGroup || chatId.includes('status')) continue;
          // In DMs: only allow self-chat
          const myNumber = (sock.user?.id || '').replace(/:.*@/, '@').replace(/@.*/, '');
          const chatNumber = chatId.replace(/@.*/, '');
          const isSelfChat = myNumber && chatNumber === myNumber;
          if (!isSelfChat) continue;
        }
        // Commands from owner fall through to be handled below
      }

      // Check allowlist for messages from others
      if (!msg.key.fromMe && ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(senderNumber)) {
        continue;
      }

      // Extract message body
      let body = '';
      let hasMedia = false;
      let mediaType = '';
      const mediaUrls = [];

      if (msg.message.conversation) {
        body = msg.message.conversation;
      } else if (msg.message.extendedTextMessage?.text) {
        body = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage) {
        body = msg.message.imageMessage.caption || '';
        hasMedia = true;
        mediaType = 'image';
      } else if (msg.message.videoMessage) {
        body = msg.message.videoMessage.caption || '';
        hasMedia = true;
        mediaType = 'video';
      } else if (msg.message.audioMessage || msg.message.pttMessage) {
        hasMedia = true;
        mediaType = msg.message.pttMessage ? 'ptt' : 'audio';
        // Download audio to local cache so gateway can transcribe it
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const filename = `audio_${randomBytes(6).toString('hex')}.ogg`;
          const filepath = path.join(MEDIA_CACHE_DIR, filename);
          writeFileSync(filepath, buffer);
          mediaUrls.push(`http://localhost:${PORT}/media/${filename}`);
          console.log(`🎤 Cached voice message: ${filename} (${buffer.length} bytes)`);
        } catch (dlErr) {
          console.error('Failed to download audio:', dlErr.message);
        }
      } else if (msg.message.documentMessage) {
        body = msg.message.documentMessage.caption || msg.message.documentMessage.fileName || '';
        hasMedia = true;
        mediaType = 'document';
      }

      // Skip empty messages
      if (!body && !hasMedia) continue;

      // Handle /start, /continue, /stop commands (case-insensitive)
      const trimmed = body.trim().toLowerCase();
      if (trimmed === '/start' || trimmed === '/continue') {
        const wasAlreadyActive = chatState.get(chatId) === true;
        chatState.set(chatId, true);
        saveChatState();
        sendCommandResponse(chatId, wasAlreadyActive ? 'Hermes ya esta activo' : 'Hermes chat iniciado');
        continue;
      }
      if (trimmed === '/stop') {
        const wasAlreadyPaused = chatState.get(chatId) !== true;
        chatState.set(chatId, false);
        saveChatState();
        sendCommandResponse(chatId, wasAlreadyPaused ? 'Hermes ya esta pausado' : 'Hermes chat pausado');
        continue;
      }

      // Self-chat is active by default (no /start needed)
      if (!chatState.has(chatId)) {
        const myNumber = (sock.user?.id || '').replace(/:.*@/, '@').replace(/@.*/, '');
        const chatNumber = chatId.replace(/@.*/, '');
        if (myNumber && chatNumber === myNumber) {
          chatState.set(chatId, true);
          saveChatState();
        }
      }

      // Skip messages from inactive chats (must /start first)
      if (chatState.get(chatId) !== true) {
        // Send a one-time hint (only once per chat per session to avoid spam)
        if (!chatState.has(chatId)) {
          chatState.set(chatId, false);  // Mark as seen-but-inactive
          saveChatState();
          sendCommandResponse(chatId, 'Envía */start* para activar Hermes en este chat.');
        }
        continue;
      }

      const event = {
        messageId: msg.key.id,
        chatId,
        senderId,
        senderName: msg.pushName || senderNumber,
        chatName: isGroup ? (chatId.split('@')[0]) : (msg.pushName || senderNumber),
        isGroup,
        body,
        hasMedia,
        mediaType,
        mediaUrls,
        timestamp: msg.messageTimestamp,
      };

      messageQueue.push(event);
      if (messageQueue.length > MAX_QUEUE_SIZE) {
        messageQueue.shift();
      }
    }
  });
}

// HTTP server
const app = express();
app.use(express.json());

// Poll for new messages (long-poll style)
app.get('/messages', (req, res) => {
  const msgs = messageQueue.splice(0, messageQueue.length);
  res.json(msgs);
});

// Send a message
app.post('/send', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, message, replyTo } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: 'chatId and message are required' });
  }

  try {
    // Prefix responses so the user can distinguish agent replies from their
    // own messages (especially in self-chat / "Message Yourself").
    const prefixed = `⚕ *Hermes Agent*\n────────────\n${message}`;
    const sent = await sock.sendMessage(chatId, { text: prefixed });
    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a previously sent message
app.post('/edit', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, messageId, message } = req.body;
  if (!chatId || !messageId || !message) {
    return res.status(400).json({ error: 'chatId, messageId, and message are required' });
  }

  try {
    const prefixed = `⚕ *Hermes Agent*\n────────────\n${message}`;
    const key = { id: messageId, fromMe: true, remoteJid: chatId };
    await sock.sendMessage(chatId, { text: prefixed, edit: key });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send audio as voice message (PTT)
app.post('/send-audio', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, audioPath } = req.body;
  if (!chatId || !audioPath) {
    return res.status(400).json({ error: 'chatId and audioPath are required' });
  }

  try {
    if (!existsSync(audioPath)) {
      return res.status(404).json({ error: `Audio file not found: ${audioPath}` });
    }
    const audioBuffer = readFileSync(audioPath);
    const ext = audioPath.toLowerCase().split('.').pop();
    // WhatsApp PTT requires audio/ogg codecs=opus. If the file is MP3,
    // we still send it but Android may not play it as a voice bubble.
    const mimetype = (ext === 'ogg' || ext === 'opus')
      ? 'audio/ogg; codecs=opus'
      : 'audio/mpeg';
    const sent = await sock.sendMessage(chatId, {
      audio: audioBuffer,
      mimetype,
      ptt: ext === 'ogg' || ext === 'opus',  // Only PTT for opus-compatible formats
    });
    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve cached media files
app.get('/media/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filepath = path.join(MEDIA_CACHE_DIR, filename);
  if (!existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.sendFile(filepath);
});

// Typing indicator
app.post('/typing', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected' });
  }

  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  try {
    await sock.sendPresenceUpdate('composing', chatId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Chat info
app.get('/chat/:id', async (req, res) => {
  const chatId = req.params.id;
  const isGroup = chatId.endsWith('@g.us');

  if (isGroup && sock) {
    try {
      const metadata = await sock.groupMetadata(chatId);
      return res.json({
        name: metadata.subject,
        isGroup: true,
        participants: metadata.participants.map(p => p.id),
      });
    } catch {
      // Fall through to default
    }
  }

  res.json({
    name: chatId.replace(/@.*/, ''),
    isGroup,
    participants: [],
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: connectionState,
    queueLength: messageQueue.length,
    uptime: process.uptime(),
  });
});

// Start
if (PAIR_ONLY) {
  // Pair-only mode: just connect, show QR, save creds, exit. No HTTP server.
  console.log('📱 WhatsApp pairing mode');
  console.log(`📁 Session: ${SESSION_DIR}`);
  console.log();
  startSocket();
} else {
  app.listen(PORT, () => {
    console.log(`🌉 WhatsApp bridge listening on port ${PORT}`);
    console.log(`📁 Session stored in: ${SESSION_DIR}`);
    if (ALLOWED_USERS.length > 0) {
      console.log(`🔒 Allowed users: ${ALLOWED_USERS.join(', ')}`);
    } else {
      console.log(`⚠️  No WHATSAPP_ALLOWED_USERS set — all messages will be processed`);
    }
    console.log();
    startSocket();
  });
}
