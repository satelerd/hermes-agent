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

// Chat gating is handled in gateway/run.py.
// The bridge intentionally stays stateless and only forwards events.

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
      let senderId = msg.key.participant || chatId;
      const isGroup = chatId.endsWith('@g.us');
      const senderNumber = senderId.replace(/@.*/, '');

      // For own messages: allow /start, /stop, /continue commands in ANY chat,
      // allow *-prefixed messages as owner override in any active chat,
      // but only queue regular messages from self-chat ("Message Yourself").
      let ownerOverride = false;
      if (msg.key.fromMe) {
        // Quick-extract text to check for commands and owner override
        const quickBody = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const quickLower = quickBody.toLowerCase();
        const isCommand = quickLower === '/start' || quickLower === '/continue' || quickLower === '/stop' || quickLower === '/approve' || quickLower === '/go' || quickLower === '/apruebo' || quickLower === '/approved';
        // Owner override: message starts with * — forward to agent in any active chat
        const isOverride = quickBody.startsWith('*') && quickBody.length > 1;

        if (!isCommand && !isOverride) {
          // Regular message: skip in groups and status
          if (isGroup || chatId.includes('status')) continue;
          // In DMs: only allow self-chat
          const myNumber = (sock.user?.id || '').replace(/:.*@/, '@').replace(/@.*/, '');
          const chatNumber = chatId.replace(/@.*/, '');
          const isSelfChat = myNumber && chatNumber === myNumber;
          if (!isSelfChat) continue;
        }
        if (isOverride) ownerOverride = true;
        // Commands and overrides from owner fall through to be handled below
      }

      // For fromMe messages, use own JID as senderId so Python can
      // identify the owner (LIDs in groups are not matchable to phone numbers).
      if (msg.key.fromMe) {
        const myJid = (sock.user?.id || '').replace(/:.*@/, '@');
        if (myJid) {
          senderId = myJid;
        }
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
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const ext = (msg.message.imageMessage.mimetype || 'image/jpeg').includes('png') ? 'png' : 'jpg';
          const filename = `image_${randomBytes(6).toString('hex')}.${ext}`;
          const filepath = path.join(MEDIA_CACHE_DIR, filename);
          writeFileSync(filepath, buffer);
          mediaUrls.push(`http://localhost:${PORT}/media/${filename}`);
          console.log(`📷 Cached image: ${filename} (${buffer.length} bytes)`);
        } catch (dlErr) {
          console.error('Failed to download image:', dlErr.message);
        }
      } else if (msg.message.videoMessage) {
        body = msg.message.videoMessage.caption || '';
        hasMedia = true;
        mediaType = 'video';
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const filename = `video_${randomBytes(6).toString('hex')}.mp4`;
          const filepath = path.join(MEDIA_CACHE_DIR, filename);
          writeFileSync(filepath, buffer);
          mediaUrls.push(`http://localhost:${PORT}/media/${filename}`);
          console.log(`🎬 Cached video: ${filename} (${buffer.length} bytes)`);
        } catch (dlErr) {
          console.error('Failed to download video:', dlErr.message);
        }
      } else if (msg.message.audioMessage || msg.message.pttMessage) {
        hasMedia = true;
        mediaType = msg.message.pttMessage ? 'ptt' : 'audio';
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
        body = msg.message.documentMessage.caption || '';
        hasMedia = true;
        mediaType = 'document';
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const origName = msg.message.documentMessage.fileName || 'file';
          const ext = origName.includes('.') ? origName.split('.').pop() : 'bin';
          const filename = `doc_${randomBytes(6).toString('hex')}_${origName}`;
          const filepath = path.join(MEDIA_CACHE_DIR, filename);
          writeFileSync(filepath, buffer);
          mediaUrls.push(`http://localhost:${PORT}/media/${filename}`);
          console.log(`📎 Cached document: ${filename} (${buffer.length} bytes)`);
        } catch (dlErr) {
          console.error('Failed to download document:', dlErr.message);
        }
      }

      // Skip empty messages
      if (!body && !hasMedia) continue;

      // Owner override: strip leading * from body
      if (ownerOverride && body.startsWith('*')) {
        body = body.slice(1).trimStart();
        if (!body && !hasMedia) continue; // Nothing left after stripping
      }

      // IMPORTANT: WhatsApp chat approval is handled in gateway/run.py
      // (/start -> owner /approved -> user /start). The bridge must not
      // consume those commands or gate chats locally; just forward events.

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

// MIME type map and media type inference for /send-media
const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function inferMediaType(ext) {
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', '3gp'].includes(ext)) return 'video';
  if (['ogg', 'opus', 'mp3', 'wav', 'm4a'].includes(ext)) return 'audio';
  return 'document';
}

// Send media (image, video, document) natively
app.post('/send-media', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, filePath, mediaType, caption, fileName } = req.body;
  if (!chatId || !filePath) {
    return res.status(400).json({ error: 'chatId and filePath are required' });
  }

  try {
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    const buffer = readFileSync(filePath);
    const ext = filePath.toLowerCase().split('.').pop();
    const type = mediaType || inferMediaType(ext);
    let msgPayload;

    switch (type) {
      case 'image':
        msgPayload = { image: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'image/jpeg' };
        break;
      case 'video':
        msgPayload = { video: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'video/mp4' };
        break;
      case 'audio': {
        const audioMime = (ext === 'ogg' || ext === 'opus') ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
        msgPayload = { audio: buffer, mimetype: audioMime, ptt: ext === 'ogg' || ext === 'opus' };
        break;
      }
      case 'document':
      default:
        msgPayload = {
          document: buffer,
          fileName: fileName || path.basename(filePath),
          caption: caption || undefined,
          mimetype: MIME_MAP[ext] || 'application/octet-stream',
        };
        break;
    }

    const sent = await sock.sendMessage(chatId, msgPayload);
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
