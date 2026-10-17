import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import pairRouter, { setPairingController, updatePairingStatus } from './pair.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============== CONFIG ===============
const BOT_SETTINGS_FILE = path.join(__dirname, 'bot-setting.json');
const AUTH_DIR = path.join(__dirname, 'auth', 'growbot');
const LINKED_AUTH_DIR = path.join(__dirname, 'auth', 'linked');
// An unset OWNER_NUMBER must not turn into the invalid JID
// "undefined@s.whatsapp.net". Commands sent by the currently linked device
// are also trusted below, because Baileys reports those with key.fromMe=true.
const OWNER_NUMBER_RAW = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const OWNER_NUMBER = OWNER_NUMBER_RAW ? `${OWNER_NUMBER_RAW}@s.whatsapp.net` : '';
const MARKED_GROUPS_FILE = path.join(__dirname, 'marked-groups.json');
const commandContext = new AsyncLocalStorage();
let PREFIX = '.';

try {
  const settings = JSON.parse(await readFile(BOT_SETTINGS_FILE, 'utf8'));
  if (typeof settings.prefix === 'string') PREFIX = settings.prefix;
} catch {
  await writeFile(BOT_SETTINGS_FILE, JSON.stringify({ prefix: '.' }, null, 2));
}

let MARKED_GROUPS = new Set();
try {
  const data = JSON.parse(await readFile(MARKED_GROUPS_FILE, 'utf8'));
  data.forEach(g => MARKED_GROUPS.add(g));
} catch {
  await writeFile(MARKED_GROUPS_FILE, '[]');
}

function saveMarked() {
  return writeFile(MARKED_GROUPS_FILE, JSON.stringify([...MARKED_GROUPS], null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeJid(jid) {
  return jid?.replace(/:\d+/, '')?.split('@')[0] + '@g.us';
}

function isCommand(text, cmd) {
  return text?.toLowerCase().startsWith(PREFIX + cmd);
}

// Baileys wraps some incoming text in ephemeral/edited message containers.
// Unwrap those like the working King MD handler before looking for commands.
function unwrapMessageContent(message = {}) {
  let current = message || {};
  let depth = 0;
  while (depth++ < 8) {
    const wrapped =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.editedMessage?.message ||
      null;
    if (!wrapped) break;
    current = wrapped;
  }
  return current || {};
}

function getMessageText(msg) {
  const content = unwrapMessageContent(msg?.message || {});
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.templateButtonReplyMessage?.selectedId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  ).trim();
}

function isOwnerCommand(msg, jid, sender) {
  // On companion/linked devices, commands typed by the account itself arrive
  // with fromMe=true. Do not discard those commands.
  if (msg?.key?.fromMe === true) return true;
  if (!OWNER_NUMBER) return false;

  const candidates = [
    sender,
    msg?.key?.participant,
    msg?.key?.senderPn,
    msg?.key?.participantPn,
    jid,
    msg?.key?.remoteJidAlt
  ];
  return candidates.some(candidate => {
    if (typeof candidate !== 'string') return false;
    const normalized = candidate.replace(/:\d+(?=@s\.whatsapp\.net$)/, '');
    return normalized === OWNER_NUMBER;
  });
}

// Supports both the existing two-argument calls in the command code and
// explicit socket calls used by the connection lifecycle.
function sendText(sockOrJid, jidOrText, maybeText) {
  let sock;
  let jid;
  let text;
  if (sockOrJid && typeof sockOrJid.sendMessage === 'function') {
    sock = sockOrJid;
    jid = jidOrText;
    text = maybeText;
  } else {
    sock = commandContext.getStore();
    jid = sockOrJid;
    text = jidOrText;
  }
  if (!sock) return Promise.reject(new Error('No active WhatsApp socket is available for this message.'));
  return sock.sendMessage(jid, { text: String(text ?? '') });
}

// =============== GROWTH ENGINE ===============
async function getRandomMemberFromGroup(sock, jid) {
  try {
    const metadata = await sock.groupMetadata(jid);
    const members = metadata.participants
      .filter(p => !p.id.includes('bot') && !p.admin)
      .map(p => p.id);
    if (members.length === 0) return null;
    return members[Math.floor(Math.random() * members.length)];
  } catch (e) {
    console.error(`Failed to get member from ${jid}:`, e.message);
    return null;
  }
}

async function growGroup(sock, targetJid, amount) {
  const target = normalizeJid(targetJid);
  let added = 0;

  if (!MARKED_GROUPS.size) {
    return sendText(sock.user.id, `❌ No source groups marked. Use .mark in groups first.`);
  }

  sendText(sock.user.id, `🚀 Starting growth: Adding ${amount} members to ${target} from ${MARKED_GROUPS.size} marked groups.`);

  while (added < amount) {
    for (const sourceJid of MARKED_GROUPS) {
      if (added >= amount) break;

      const member = await getRandomMemberFromGroup(sock, sourceJid);
      if (!member) continue;

      try {
        await sock.groupParticipantsUpdate(target, [member], 'add');
        added++;
        console.log(`✅ Added ${member} to ${target} (${added}/${amount})`);
        await sendText(sock.user.id, `✅ Added member #${added} to ${target}`);
      } catch (e) {
        console.error(`Failed to add ${member}:`, e.message);
        if (e.message.includes('403')) {
          await sendText(sock.user.id, `🚫 Add permission denied for ${target}. Am I admin?`);
          return;
        }
      }

      await sleep(3 * 60 * 1000); // 3 mins
    }
  }

  await sendText(sock.user.id, `🎯 Growth complete: ${amount} members added to ${target}`);
}

// =============== NONGET ===============
async function nonget(sock, minMembers) {
  const groups = await sock.groupFetchAllParticipating();
  const candidates = Object.values(groups).filter(g => g.participants?.length > minMembers);

  if (!candidates.length) {
    return sendText(sock.user.id, `❌ No groups found with more than ${minMembers} members.`);
  }

  for (const group of candidates) {
    try {
      await sock.groupParticipantsUpdate(group.id, [OWNER_NUMBER], 'add');
      await sock.groupParticipantsUpdate(group.id, [OWNER_NUMBER], 'promote');
      await sendText(sock.user.id, `👑 Added and promoted owner to: ${group.subject} (${group.participants.length} members)`);
      return;
    } catch (e) {
      console.error(`Failed to add owner to ${group.id}:`, e.message);
    }
  }

  await sendText(sock.user.id, `❌ Could not add owner to any large group.`);
}

// =============== WEB SERVER ===============
const app = express();
app.use(express.json());
app.use(pairRouter);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'growbot', status: 'running' });
});

const PORT = process.env.PORT || 3000;

// =============== MULTI-SESSION PAIRING RUNTIME ===============
// The pairing task remains alive across socket replacements. Linked accounts
// are stored under auth/linked/<phone-number> and restored on server startup.
const socketSessions = new Map();
const pairingSessionByNumber = new Map();
const pairingTasks = new Map();
const PAIRING_MAX_FAST_FAILURES = Number(process.env.PAIRING_MAX_FAST_FAILURES || 6);
const PAIRING_FAST_FAIL_MS = 10_000;
const PAIRING_LINK_TIMEOUT_MS = Number(process.env.PAIRING_LINK_TIMEOUT_MS || 3 * 60_000);
let whatsappVersionPromise = null;

async function getWhatsAppVersion() {
  if (!whatsappVersionPromise) {
    whatsappVersionPromise = fetchLatestBaileysVersion()
      .then(result => Array.isArray(result?.version) ? result.version : null)
      .catch(error => {
        console.warn('⚠️ Could not fetch the supported WhatsApp Web version; using Baileys default:', error?.message || error);
        return null;
      });
  }
  return whatsappVersionPromise;
}

function refreshPrimarySocket() {
  const primary = socketSessions.get('primary');
  return primary?.socket || [...socketSessions.values()].find(item => item.connection === 'open')?.socket || null;
}

async function isRegisteredOnDisk(authDir) {
  try {
    const raw = await readFile(path.join(authDir, 'creds.json'), 'utf8');
    return JSON.parse(raw)?.registered === true;
  } catch {
    return false;
  }
}

function waitForSessionReady(session, timeoutMs = 15_000) {
  if (session.pairingReady) return Promise.resolve(true);
  let timer;
  return Promise.race([
    session.readyPromise,
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

async function disposeSession(session, { wipe = false } = {}) {
  if (!session) return;
  session.disposed = true;
  clearTimeout(session.reconnectTimer);
  session.resolveReady?.(false);
  session.resolveReady = null;
  const sock = session.socket;
  session.socket = null;
  session.connection = 'close';
  if (socketSessions.get(session.id) === session) socketSessions.delete(session.id);
  try { sock?.end?.(new Error('Pairing socket disposed')); } catch {}
  refreshPrimarySocket();
  if (wipe) await rm(session.authDir, { recursive: true, force: true }).catch(() => {});
}

function finishPairingTask(task) {
  clearTimeout(task.linkTimer);
  pairingTasks.delete(task.id);
}

function failPairingTask(task, error) {
  if (task.finished) return;
  task.finished = true;
  task.cancelled = true;
  console.warn(`🔴 Pairing ${task.id} (${task.number}) failed: ${error}`);
  updatePairingStatus('failed', { error }, task.id);
  finishPairingTask(task);
}

function markPairingLinked(task) {
  if (task.linked || task.finished) return;
  task.linked = true;
  console.log(`🔗 Pairing ${task.id}: WhatsApp accepted the code; finishing the link…`);
  updatePairingStatus('linking', {}, task.id);
  clearTimeout(task.linkTimer);
  task.linkTimer = setTimeout(async () => {
    const session = task.session;
    if (task.finished || session?.connection === 'open') return;
    failPairingTask(task, 'WhatsApp accepted the code but the link did not finish in time. Generate a new code.');
    await disposeSession(session, { wipe: true });
  }, PAIRING_LINK_TIMEOUT_MS);
  task.linkTimer.unref?.();
}

async function requestCodeForSession(session, task) {
  const ready = await waitForSessionReady(session, 15_000);
  if (!ready) throw new Error('WhatsApp did not finish starting in time. Please retry.');
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (task.cancelled) throw new Error('Pairing cancelled.');
    if (session.disposed || task.session !== session) throw new Error('Pairing socket was replaced.');
    try {
      if (!session.socket) throw new Error('Connection closed before a pairing code was requested.');
      if (session.state.creds.registered) throw new Error('This number already has a registered WhatsApp session.');
      console.log(`🔐 Requesting pairing code for ${task.number} (attempt ${attempt + 1}/4)`);
      const code = String(await session.socket.requestPairingCode(task.number) || '').trim().toUpperCase();
      if (!code) throw new Error('WhatsApp returned an empty pairing code.');
      if (session.disposed || task.session !== session) throw new Error('Pairing socket was replaced.');
      task.codeIssuedAt = Date.now();
      updatePairingStatus('code_ready', { code }, task.id);
      return code;
    } catch (error) {
      lastError = error;
      if (/already.*registered|cancelled|replaced/i.test(error?.message || '')) throw error;
      console.warn(`⚠️ Pairing code attempt ${attempt + 1} failed for ${task.number}:`, error?.message || error);
      await sleep(1000 + attempt * 1000);
    }
  }
  throw lastError || new Error('Failed to generate a pairing code.');
}

async function openPairingSocket(task) {
  const previous = task.session;
  task.session = null;
  await disposeSession(previous, { wipe: false });
  // Only pre-link attempts are refreshed here; linked credentials are never wiped by this path.
  await rm(task.authDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(task.authDir, { recursive: true });
  const session = await launchSocketSession({
    sessionId: task.sessionId,
    authDir: task.authDir,
    number: task.number,
    pairingId: task.id,
    primary: false,
    version: await getWhatsAppVersion(),
    task
  });
  task.session = session;
  pairingSessionByNumber.set(task.number, task.sessionId);
  return requestCodeForSession(session, task);
}

async function regeneratePairingCode(task, why) {
  if (task.regenerating || task.cancelled || task.linked || task.finished) return;
  task.regenerating = true;
  try {
    while (!task.cancelled && !task.linked && !task.finished) {
      if (task.fastFailures >= PAIRING_MAX_FAST_FAILURES) {
        failPairingTask(task, `WhatsApp keeps closing the connection immediately (${why}). Check the network and Baileys version, then try again.`);
        await disposeSession(task.session, { wipe: true });
        return;
      }
      task.refreshes += 1;
      console.log(`🔄 Pairing ${task.id}: refreshing code #${task.refreshes} (${why})`);
      updatePairingStatus('restarting', {}, task.id);
      await sleep(Math.min(1000 * (1 + task.fastFailures * 2), 15_000));
      if (task.cancelled || task.linked || task.finished) return;
      try {
        await openPairingSocket(task);
        return;
      } catch (error) {
        if (task.cancelled || task.linked || task.finished) return;
        task.fastFailures += 1;
        why = error?.message || String(error);
        console.warn(`⚠️ Pairing ${task.id}: code refresh failed: ${why}`);
      }
    }
  } finally {
    task.regenerating = false;
  }
}

async function cancelPairingSession(pairingId, reason = 'cancelled') {
  const task = pairingTasks.get(pairingId);
  if (!task) return;
  console.log(`🛑 Pairing ${pairingId} ${reason}.`);
  task.cancelled = true;
  task.finished = true;
  finishPairingTask(task);
  const session = task.session;
  // If WhatsApp has already accepted the link, let the socket finish reconnecting.
  if (session && session.connection !== 'open' && !session.state.creds.registered) {
    await disposeSession(session, { wipe: true });
    if (pairingSessionByNumber.get(task.number) === task.sessionId) pairingSessionByNumber.delete(task.number);
  }
}

async function startPairingSession(number, pairingId) {
  const sessionId = `linked:${number}`;
  const authDir = path.join(LINKED_AUTH_DIR, number);
  const live = socketSessions.get(sessionId);
  if (live?.state?.creds?.registered || await isRegisteredOnDisk(authDir)) {
    throw new Error('This number is already paired with the bot.');
  }

  for (const previous of [...pairingTasks.values()]) {
    if (previous.number === number) await cancelPairingSession(previous.id, 'replaced');
  }

  const task = {
    id: pairingId,
    number,
    sessionId,
    authDir,
    session: null,
    linked: false,
    cancelled: false,
    finished: false,
    firstCodeDelivered: false,
    regenerating: false,
    refreshes: 0,
    fastFailures: 0,
    codeIssuedAt: 0,
    linkTimer: null
  };
  pairingTasks.set(pairingId, task);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const code = await openPairingSocket(task);
      task.firstCodeDelivered = true;
      return code;
    } catch (error) {
      lastError = error;
      if (task.cancelled || /already.*registered/i.test(error?.message || '')) break;
      console.warn(`⚠️ Pairing ${pairingId}: first-code attempt ${attempt}/3 failed: ${error?.message || error}`);
      await disposeSession(task.session, { wipe: true });
      task.session = null;
      await sleep(1500 * attempt);
    }
  }
  task.cancelled = true;
  task.finished = true;
  finishPairingTask(task);
  await disposeSession(task.session, { wipe: true });
  if (pairingSessionByNumber.get(number) === sessionId) pairingSessionByNumber.delete(number);
  throw lastError || new Error('Failed to generate a pairing code.');
}

async function launchSocketSession({ sessionId, authDir, number = '', pairingId = null, primary = false, version = null, task = null, authBundle = null }) {
  const existing = socketSessions.get(sessionId);
  if (existing?.socket && existing.connection !== 'close' && !existing.disposed) return existing;

  const { state, saveCreds } = authBundle || await useMultiFileAuthState(authDir);
  const activeVersion = version || await getWhatsAppVersion();
  let resolveReady;
  const session = {
    id: sessionId,
    authDir,
    number,
    pairingId,
    task,
    primary,
    state,
    saveCreds,
    disposed: false,
    connection: 'connecting',
    pairingReady: false,
    readyPromise: new Promise(resolve => { resolveReady = resolve; }),
    resolveReady: null,
    socket: null,
    reconnectTimer: null,
    credsSave: Promise.resolve(),
    commandsAttached: false
  };
  session.resolveReady = resolveReady;

  const sock = makeWASocket({
    ...(activeVersion ? { version: activeVersion } : {}),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, console)
    },
    markOnlineOnConnect: !task || task.linked,
    // Required for commands typed from the same linked account. King MD
    // enables this so the socket emits the account's own outgoing messages.
    emitOwnEvents: true,
    syncFullHistory: false,
    browser: Browsers.ubuntu('Chrome'),
    defaultQueryTimeoutMs: 60_000,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000
  });

  session.socket = sock;
  socketSessions.set(sessionId, session);
  if (task) task.session = session;

  sock.ev.on('creds.update', () => {
    session.credsSave = session.credsSave
      .then(() => saveCreds())
      .catch(error => console.error(`❌ Failed to save credentials for ${sessionId}:`, error?.message || error));
  });

  sock.ev.on('connection.update', async update => {
    if (session.disposed || session.socket !== sock) return;
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    // Baileys emits the first QR event after the socket is ready for phone-number pairing.
    if (qr && !state.creds.registered) {
      session.pairingReady = true;
      session.resolveReady?.(true);
      session.resolveReady = null;
    }
    if (isNewLogin && task) markPairingLinked(task);

    if (connection === 'connecting') {
      session.connection = 'connecting';
      refreshPrimarySocket();
      if (task && (task.linked || !task.firstCodeDelivered)) {
        updatePairingStatus('connecting', {}, task.id);
      }
    }

    if (connection === 'open') {
      session.connection = 'open';
      session.pairingReady = true;
      session.resolveReady?.(true);
      session.resolveReady = null;
      clearTimeout(session.reconnectTimer);
      refreshPrimarySocket();

      const connectedNumber = String(sock.user?.id || '').split('@')[0].split(':')[0].replace(/\D/g, '');
      if (connectedNumber) pairingSessionByNumber.set(connectedNumber, session.id);
      console.log(`✅ WhatsApp session ${session.id} is OPEN.`);

      if (task) {
        task.linked = true;
        task.finished = true;
        finishPairingTask(task);
        updatePairingStatus('open', { message: 'Device paired successfully.' }, task.id);
      }

      if (!session.commandsAttached) {
        attachBotCommands(sock);
        session.commandsAttached = true;
      }

      const noticePath = path.join(authDir, '.growbot-online-notice');
      if (!existsSync(noticePath)) {
        try {
          await sendText(sock, sock.user.id, '🟢 GrowBot is online and ready.');
          await writeFile(noticePath, new Date().toISOString(), 'utf8');
        } catch (error) {
          console.warn(`⚠️ Could not send the GrowBot ready notice (${sessionId}):`, error?.message || error);
        }
      }
    }

    if (connection === 'close') {
      session.connection = 'close';
      if (session.socket === sock) session.socket = null;
      refreshPrimarySocket();
      await session.credsSave.catch(() => {});
      const statusCode = Number(lastDisconnect?.error?.output?.statusCode ?? 0);
      const reason = lastDisconnect?.error?.message || 'unknown';
      console.error(`🔌 WhatsApp session ${session.id} closed. status=${statusCode || 'unknown'} reason=${reason}`);

      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const restartRequired = statusCode === DisconnectReason.restartRequired;
      const registered = Boolean(state.creds.registered);

      // An unused pairing code belongs to its old socket. Keep the task alive and issue a fresh code.
      if (task && !task.linked && !registered) {
        session.disposed = true;
        session.resolveReady?.(false);
        session.resolveReady = null;
        if (task.firstCodeDelivered && !task.cancelled && !task.finished) {
          const lived = Date.now() - (task.codeIssuedAt || 0);
          task.fastFailures = lived < PAIRING_FAST_FAIL_MS ? task.fastFailures + 1 : 0;
          regeneratePairingCode(task, `${statusCode || 'closed'}: ${reason}`)
            .catch(error => console.error(`💥 Pairing refresh failed (${session.id}):`, error?.stack || error));
        }
        return;
      }

      if (loggedOut) {
        session.disposed = true;
        socketSessions.delete(sessionId);
        if (number && pairingSessionByNumber.get(number) === sessionId) pairingSessionByNumber.delete(number);
        if (task) failPairingTask(task, `WhatsApp logged out or rejected this session (${statusCode}). Generate a new code.`);
        if (!primary) await rm(authDir, { recursive: true, force: true }).catch(() => {});
        return;
      }

      // A 515 close after pair-success is expected: restart with the same in-memory credentials.
      session.disposed = true;
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = setTimeout(async () => {
        if (socketSessions.get(sessionId)?.connection === 'open') return;
        try {
          const next = await launchSocketSession({
            sessionId,
            authDir,
            number,
            pairingId,
            primary,
            version: activeVersion,
            task,
            authBundle: { state, saveCreds }
          });
          if (task && next) task.session = next;
        } catch (error) {
          console.error(`💥 Session reconnect failed (${sessionId}):`, error?.stack || error);
          if (task && !task.finished) failPairingTask(task, error?.message || 'Could not reconnect to WhatsApp.');
        }
      }, restartRequired ? 250 : 3000);
      session.reconnectTimer.unref?.();
    }
  });

  return session;
}

setPairingController({
  startPairing: startPairingSession,
  cancelPairing: cancelPairingSession
});

// The existing command listener is reused for the original session and every paired session.
function attachBotCommands(sock) {
  sock.ev.on('messages.upsert', async ({ messages = [] } = {}) => {
    // Process each message in event order. A single Baileys upsert can contain
    // more than one message; handling only messages[0] silently missed the rest.
    for (const msg of messages) {
      try {
        if (!msg?.message || !msg?.key?.remoteJid) continue;

        const jid = msg.key.remoteJid;
        const text = getMessageText(msg);
        if (!text) continue;

        const sender = msg.key.participant || msg.key.senderPn || jid;
        if (!isOwnerCommand(msg, jid, sender)) continue;

        await commandContext.run(sock, async () => {
          // =============== COMMANDS ===============
      if (isCommand(text, 'menu')) {
        await sendText(jid, `
  🚀 *GrowBot Menu*
  • ${PREFIX}menu – Show this menu
  • ${PREFIX}setprefix <char> – Change prefix
  • ${PREFIX}groupid – Get current group ID
  • ${PREFIX}mark – Mark this group as source
  • ${PREFIX}unmark – Unmark this group
  • ${PREFIX}growgc <group_id> <amount> – Grow group slowly
  • ${PREFIX}nonget t<amount> – Find big group, add owner as admin
        `.trim());
      }

      if (isCommand(text, 'setprefix')) {
        const newPrefix = text.split(' ')[1];
        if (!newPrefix || newPrefix.length !== 1) {
          return sendText(jid, '❌ Use exactly one character: .setprefix !');
        }
        PREFIX = newPrefix;
        await writeFile(BOT_SETTINGS_FILE, JSON.stringify({ prefix: PREFIX }, null, 2));
        await sendText(jid, `✅ Prefix changed to: ${PREFIX}`);
      }

      if (isCommand(text, 'groupid')) {
        await sendText(jid, `🆔 Group ID:\n${jid}`);
      }

      if (isCommand(text, 'mark')) {
        if (!jid.endsWith('@g.us')) return sendText(jid, '❌ Use this in a group.');
        MARKED_GROUPS.add(jid);
        saveMarked();
        await sendText(jid, `📌 Group marked as source. Total sources: ${MARKED_GROUPS.size}`);
      }

      if (isCommand(text, 'unmark')) {
        MARKED_GROUPS.delete(jid);
        saveMarked();
        await sendText(jid, `🗑️ Group unmarked. Remaining sources: ${MARKED_GROUPS.size}`);
      }

      if (isCommand(text, 'growgc')) {
        const [_, target, amountStr] = text.split(' ');
        const amount = parseInt(amountStr);
        if (!target || !amount || isNaN(amount)) {
          return sendText(jid, '❌ Usage: .growgc <group_id> <amount>');
        }
        await growGroup(sock, target, amount);
      }

      if (isCommand(text, 'nonget')) {
        const match = text.match(/t(\d+)/);
        const amount = match ? parseInt(match[1]) : 100;
        await nonget(sock, amount);
      }
        });
      } catch (error) {
        console.error('💥 GrowBot command handler failed:', error?.stack || error);
      }
    }
  });
}

async function startBot() {
  await mkdir(AUTH_DIR, { recursive: true });
  await mkdir(LINKED_AUTH_DIR, { recursive: true });
  const version = await getWhatsAppVersion();

  const primaryAuth = await useMultiFileAuthState(AUTH_DIR);
  if (primaryAuth.state.creds.registered) {
    await launchSocketSession({ sessionId: 'primary', authDir: AUTH_DIR, primary: true, version, authBundle: primaryAuth });
  } else {
    console.log('🟡 No registered primary GrowBot session; web pairing is ready for new numbers.');
  }

  const entries = await readdir(LINKED_AUTH_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{10,15}$/.test(entry.name)) continue;
    const authDir = path.join(LINKED_AUTH_DIR, entry.name);
    const authBundle = await useMultiFileAuthState(authDir).catch(() => null);
    if (!authBundle?.state?.creds?.registered) continue;
    const sessionId = `linked:${entry.name}`;
    pairingSessionByNumber.set(entry.name, sessionId);
    try {
      await launchSocketSession({ sessionId, authDir, number: entry.name, primary: false, version, authBundle });
    } catch (error) {
      console.error(`💥 Could not restore linked session ${entry.name}:`, error?.stack || error);
    }
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 GrowBot pairing web interface running on port ${PORT}`);
});
server.requestTimeout = 120_000;

startBot().catch(error => {
  console.error('💥 GrowBot startup failed:', error?.stack || error);
});

// Keep the web service responsive on hosts that expect a continuously running process.
setInterval(() => console.log('🫀 Ping...'), 300_000).unref?.();
