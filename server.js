const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const VERSION = '3.0.4-public-online-hotfix';
const REJOIN_MS = Math.max(1000, Number(process.env.REJOIN_MS) || 30_000);
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const DEFAULT_ORIGINS = [
  'https://pandapidio.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
const ALLOWED_ORIGINS = new Set(
  String(process.env.FRONTEND_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
);

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
      return callback(new Error('Origem não permitida pelo Rei dos Mares.'));
    },
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 5e6,
  perMessageDeflate: { threshold: 1024 },
  httpCompression: true
});

app.get('/', (_req, res) => res.json({
  ok: true,
  service: 'Rei dos Mares Multiplayer',
  version: VERSION
}));
app.get('/health', (_req, res) => res.json({
  ok: true,
  rooms: rooms.size,
  connections: io.engine.clientsCount,
  now: Date.now(),
  version: VERSION
}));

function id(prefix = '') { return prefix + crypto.randomBytes(12).toString('hex'); }
function code6() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Não foi possível gerar código de sala único.');
}
function cleanText(v, fallback, max = 24) {
  const s = String(v ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
  return s || fallback;
}
function cleanToken(v) {
  const s = String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  return s.length >= 12 ? s : id('r_');
}
function cleanProfile(raw = {}) {
  return {
    name: cleanText(raw.name, 'Capitão', 18),
    skinId: cleanText(raw.skinId, 'default', 48),
    portrait: cleanText(raw.portrait, 'assets/portraits/pirate.svg', 180),
    title: cleanText(raw.title, 'Capitão', 48)
  };
}
function sortedPlayers(room) { return [...room.players.values()].sort((a, b) => a.slot - b.slot); }
function connectedPlayers(room) { return sortedPlayers(room).filter(p => p.connected && p.socketId); }
function playerBySocket(room, socketId) { return sortedPlayers(room).find(p => p.socketId === socketId) || null; }
function playerByToken(room, token) { return room.players.get(token) || null; }
function hostPlayer(room) { return room.hostToken ? playerByToken(room, room.hostToken) : null; }
function isHostSocket(room, socket) { const h = hostPlayer(room); return !!h && h.connected && h.socketId === socket.id; }
function extractPlayerState(room, slot) {
  const fromSnap = room.lastSnapshot?.players?.find?.(p => Number(p.id) === Number(slot));
  if (fromSnap) return fromSnap;
  return sortedPlayers(room).find(p => p.slot === slot)?.lastPlayerState || null;
}
function rememberStates(room, snapshot) {
  if (!snapshot?.players) return;
  for (const sp of snapshot.players) {
    const p = sortedPlayers(room).find(x => Number(x.slot) === Number(sp.id));
    if (p) p.lastPlayerState = sp;
  }
}
function roomPayload(room) {
  const hp = hostPlayer(room);
  return {
    code: room.code,
    hostId: hp?.socketId || null,
    hostPlayerId: hp?.playerId || null,
    started: room.started,
    paused: room.paused,
    maxPlayers: 3,
    players: sortedPlayers(room).map(p => ({
      playerId: p.playerId,
      socketId: p.socketId || null,
      slot: p.slot,
      isHost: p.token === room.hostToken,
      connected: !!p.connected,
      reconnectUntil: p.reconnectUntil || 0,
      expired: !!p.expired,
      name: p.profile.name,
      skinId: p.profile.skinId,
      portrait: p.profile.portrait,
      title: p.profile.title
    }))
  };
}
function emitRoom(room) { io.to(room.code).emit('room:state', roomPayload(room)); }
function findRoomOf(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}
function detachSocket(socket, room) {
  try { socket.leave(room.code); } catch (_) { }
  socket.data.roomCode = null;
  socket.data.resumeToken = null;
}
function attachSocket(socket, room, p) {
  p.socketId = socket.id;
  p.connected = true;
  p.expired = false;
  p.reconnectUntil = 0;
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.resumeToken = p.token;
}
function promoteHost(room, preferred = null) {
  const candidates = connectedPlayers(room);
  const next = preferred && preferred.connected ? preferred : candidates[0] || null;
  room.hostToken = next?.token || null;
  return next;
}
function notifyHostMigration(room, departedSlot = null, reason = 'host-migration') {
  const nextHost = promoteHost(room);
  if (!nextHost) return null;
  io.to(room.code).emit('game:host-migrated', {
    hostId: nextHost.socketId,
    hostPlayerId: nextHost.playerId,
    slot: nextHost.slot,
    departedSlot,
    lastSnapshot: room.lastSnapshot || null,
    reason
  });
  io.to(room.code).emit('game:pause-state', { paused: false, by: nextHost.slot, reason: 'host-migration' });
  console.log(`Sala ${room.code}: host migrou para ${nextHost.playerId} / slot ${nextHost.slot}`);
  return nextHost;
}
function scheduleExpiry(room, p) {
  if (p.expireTimer) clearTimeout(p.expireTimer);
  const token = p.token;
  const until = p.reconnectUntil;
  p.expireTimer = setTimeout(() => {
    const liveRoom = rooms.get(room.code);
    const live = liveRoom?.players.get(token);
    if (!liveRoom || !live || live.connected || live.reconnectUntil !== until) return;
    live.expired = true;
    live.reconnectUntil = 0;
    live.expireTimer = null;
    io.to(liveRoom.code).emit('game:player-expired', {
      slot: live.slot,
      playerId: live.playerId,
      name: live.profile.name
    });
    emitRoom(liveRoom);
    // Sala pode ficar em memória enquanto alguém conectado estiver jogando. Se todos expirarem, encerra.
    if (!connectedPlayers(liveRoom).length && sortedPlayers(liveRoom).every(x => x.expired || !x.connected)) {
      rooms.delete(liveRoom.code);
    }
  }, Math.max(10, until - Date.now() + 50));
}
function leaveBeforeStart(socket, room, p, reason) {
  room.players.delete(p.token);
  detachSocket(socket, room);
  if (!room.players.size) { rooms.delete(room.code); return { reconnectUntil: 0 }; }
  const list = sortedPlayers(room);
  list.forEach((x, i) => { x.slot = i; });
  if (p.token === room.hostToken || !hostPlayer(room)?.connected) promoteHost(room);
  io.to(room.code).emit('room:player-left', { playerId: p.playerId, slot: p.slot, reason, started: false });
  emitRoom(room);
  return { reconnectUntil: 0 };
}
function suspendStartedPlayer(socket, room, p, reason) {
  if (!p.connected) return { reconnectUntil: p.reconnectUntil || 0 };
  p.lastPlayerState = extractPlayerState(room, p.slot) || p.lastPlayerState || null;
  p.connected = false;
  p.socketId = null;
  p.expired = false;
  p.reconnectUntil = Date.now() + REJOIN_MS;
  const wasHost = p.token === room.hostToken;
  detachSocket(socket, room);
  room.paused = false;
  io.to(room.code).emit('game:player-left', {
    playerId: p.playerId,
    slot: p.slot,
    reason,
    wasHost,
    temporary: true,
    reconnectUntil: p.reconnectUntil,
    name: p.profile.name
  });
  if (wasHost) notifyHostMigration(room, p.slot, reason);
  else if (!hostPlayer(room)?.connected) notifyHostMigration(room, p.slot, reason);
  scheduleExpiry(room, p);
  emitRoom(room);
  return { reconnectUntil: p.reconnectUntil };
}
function expireStartedPlayer(socket, room, p, reason='finished') {
  if (p.expireTimer) { clearTimeout(p.expireTimer); p.expireTimer = null; }
  p.lastPlayerState = extractPlayerState(room, p.slot) || p.lastPlayerState || null;
  p.connected = false; p.socketId = null; p.expired = true; p.reconnectUntil = 0;
  const wasHost = p.token === room.hostToken;
  detachSocket(socket, room);
  io.to(room.code).emit('game:player-expired', { slot:p.slot, playerId:p.playerId, name:p.profile.name, reason });
  if (wasHost || !hostPlayer(room)?.connected) notifyHostMigration(room, p.slot, reason);
  emitRoom(room);
  if (!connectedPlayers(room).length) rooms.delete(room.code);
  return { reconnectUntil: 0 };
}
function leaveCurrentRoom(socket, reason = 'left', permanent = false) {
  const room = findRoomOf(socket);
  if (!room) return { reconnectUntil: 0 };
  const p = playerBySocket(room, socket.id);
  if (!p) { detachSocket(socket, room); return { reconnectUntil: 0 }; }
  if (!room.started) return leaveBeforeStart(socket, room, p, reason);
  if (permanent) return expireStartedPlayer(socket, room, p, reason);
  return suspendStartedPlayer(socket, room, p, reason);
}
function resumeIntoRoom(socket, payload, cb = () => {}) {
  const code = String(payload?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const token = cleanToken(payload?.resumeToken);
  const room = rooms.get(code);
  if (!room || !room.started) return cb({ ok: false, error: 'Esta viagem não está mais disponível.' });
  const p = playerByToken(room, token);
  if (!p) return cb({ ok: false, error: 'Sessão de retorno inválida.' });
  if (p.connected) return cb({ ok: false, error: 'Este capitão já está conectado.' });
  if (p.expired || !p.reconnectUntil || Date.now() > p.reconnectUntil) {
    p.expired = true; p.reconnectUntil = 0;
    return cb({ ok: false, error: 'O tempo de retorno desta viagem terminou.' });
  }
  leaveCurrentRoom(socket, 'switch-room');
  if (p.expireTimer) { clearTimeout(p.expireTimer); p.expireTimer = null; }
  attachSocket(socket, room, p);
  if (!hostPlayer(room)?.connected) promoteHost(room, p);
  const becameHost = p.token === room.hostToken;
  const ps = p.lastPlayerState || extractPlayerState(room, p.slot) || null;
  io.to(room.code).emit('game:player-rejoined', {
    slot: p.slot,
    playerId: p.playerId,
    name: p.profile.name,
    profile: p.profile,
    playerState: ps,
    becameHost,
    hostPlayerId: hostPlayer(room)?.playerId || null
  });
  emitRoom(room);
  cb({
    ok: true,
    room: roomPayload(room),
    yourSlot: p.slot,
    playerId: p.playerId,
    resumeToken: p.token,
    lastSnapshot: room.lastSnapshot || null,
    playerState: ps,
    becameHost
  });
}

io.on('connection', socket => {
  console.log('Jogador conectado:', socket.id);
  socket.emit('server:hello', { id: socket.id, version: VERSION, reconnectSeconds: Math.round(REJOIN_MS/1000) });

  socket.on('room:create', (payload, cb = () => {}) => {
    try {
      leaveCurrentRoom(socket, 'switch-room');
      const code = code6();
      const token = cleanToken(payload?.resumeToken);
      const p = {
        token,
        playerId: id('p_'),
        socketId: socket.id,
        slot: 0,
        connected: true,
        expired: false,
        reconnectUntil: 0,
        expireTimer: null,
        profile: cleanProfile(payload?.profile),
        lastPlayerState: null
      };
      const room = {
        code,
        hostToken: token,
        players: new Map([[token, p]]),
        started: false,
        paused: false,
        createdAt: Date.now(),
        lastSnapshot: null,
        lastSnapshotAt: 0,
        pendingActions: new Map()
      };
      rooms.set(code, room);
      attachSocket(socket, room, p);
      cb({ ok: true, room: roomPayload(room), yourSlot: 0, playerId: p.playerId, resumeToken: token });
      emitRoom(room);
      console.log(`Sala ${code} criada por ${p.playerId}`);
    } catch (err) {
      cb({ ok: false, error: err.message || 'Erro ao criar sala.' });
    }
  });

  socket.on('room:join', (payload, cb = () => {}) => {
    const code = String(payload?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Sala não encontrada.' });
    if (room.started) return cb({ ok: false, error: 'Esta viagem já começou. Use Retomar Multijogador se esta era sua viagem.' });
    if (sortedPlayers(room).length >= 3) return cb({ ok: false, error: 'A sala já está cheia.' });
    leaveCurrentRoom(socket, 'switch-room');
    const token = cleanToken(payload?.resumeToken);
    if (room.players.has(token)) return cb({ ok: false, error: 'Identidade de sessão já em uso.' });
    const used = new Set(sortedPlayers(room).map(p => p.slot));
    const slot = [0, 1, 2].find(i => !used.has(i));
    const p = {
      token,
      playerId: id('p_'),
      socketId: socket.id,
      slot,
      connected: true,
      expired: false,
      reconnectUntil: 0,
      expireTimer: null,
      profile: cleanProfile(payload?.profile),
      lastPlayerState: null
    };
    room.players.set(token, p);
    attachSocket(socket, room, p);
    cb({ ok: true, room: roomPayload(room), yourSlot: slot, playerId: p.playerId, resumeToken: token });
    emitRoom(room);
    console.log(`${p.playerId} entrou na sala ${code} como slot ${slot}`);
  });

  socket.on('room:resume', (payload, cb = () => {}) => resumeIntoRoom(socket, payload, cb));

  socket.on('room:leave', (payload, cb = () => {}) => {
    const permanent = !!payload?.permanent;
    const result = leaveCurrentRoom(socket, permanent ? 'finished' : 'left', permanent);
    cb({ ok: true, ...result });
  });

  socket.on('room:start', (_payload, cb = () => {}) => {
    const room = findRoomOf(socket);
    if (!room) return cb({ ok: false, error: 'Você não está em uma sala.' });
    if (!isHostSocket(room, socket)) return cb({ ok: false, error: 'Somente o host pode iniciar.' });
    if (connectedPlayers(room).length < 2) return cb({ ok: false, error: 'Aguarde pelo menos mais um capitão.' });
    room.started = true;
    room.paused = false;
    room.lastSnapshot = null;
    room.lastSnapshotAt = 0;
    const payload = roomPayload(room);
    io.to(room.code).emit('game:start', payload);
    emitRoom(room);
    // Solicita um estado completo assim que todos os clientes terminaram o bootstrap.
    setTimeout(() => {
      const live = rooms.get(room.code);
      const h = live && hostPlayer(live);
      if (h?.connected && h.socketId) io.to(h.socketId).emit('game:snapshot-request-host', { reason: 'room-start' });
    }, 180);
    cb({ ok: true });
  });

  socket.on('game:input', payload => {
    const room = findRoomOf(socket);
    if (!room?.started || isHostSocket(room, socket)) return;
    const p = playerBySocket(room, socket.id);
    const h = hostPlayer(room);
    if (!p || !h?.connected) return;
    io.to(h.socketId).emit('game:remote-input', {
      slot: p.slot,
      playerId: p.playerId,
      input: payload?.input || {},
      seq: payload?.seq || 0,
      at: Date.now()
    });
  });

  socket.on('game:snapshot', payload => {
    const room = findRoomOf(socket);
    if (!room?.started || !isHostSocket(room, socket) || !payload) return;
    const isFull = payload?._net?.full !== false || !room.lastSnapshot;
    // Guarda apenas snapshots completos para reconexão/host migration. Lite é descartável.
    if (isFull) {
      room.lastSnapshot = payload;
      room.lastSnapshotAt = Date.now();
      rememberStates(room, payload);
      socket.to(room.code).emit('game:snapshot', payload);
    } else {
      // Snapshots de combate são voláteis: se a conexão estiver ocupada, descarta o frame velho
      // em vez de formar uma fila que deixa o convidado segundos atrás do host.
      socket.to(room.code).volatile.emit('game:snapshot', payload);
    }
  });

  socket.on('game:snapshot-request', payload => {
    const room = findRoomOf(socket);
    if (!room?.started || isHostSocket(room, socket)) return;
    const p = playerBySocket(room, socket.id);
    const h = hostPlayer(room);
    if (!p || !h?.connected || !h.socketId) return;
    if (room.lastSnapshot) {
      const replay = {
        ...room.lastSnapshot,
        _net: { ...(room.lastSnapshot._net || {}), replay: true, replayAt: Date.now() }
      };
      socket.emit('game:snapshot', replay);
    }
    io.to(h.socketId).emit('game:snapshot-request-host', {
      slot: p.slot,
      playerId: p.playerId,
      lastSeq: Number(payload?.lastSeq) || 0,
      reason: cleanText(payload?.reason, 'watchdog', 24)
    });
  });

  socket.on('game:action', payload => {
    const room = findRoomOf(socket);
    if (!room?.started || isHostSocket(room, socket)) return;
    const p = playerBySocket(room, socket.id);
    const h = hostPlayer(room);
    if (!p || !h?.connected) return;
    const requestId = cleanText(payload?.requestId, id('a_'), 80);
    if (!room.pendingActions) room.pendingActions = new Map();
    room.pendingActions.set(requestId,{socketId:socket.id,playerId:p.playerId,slot:p.slot,action:cleanText(payload?.action,'',32),at:Date.now()});
    setTimeout(()=>room.pendingActions?.delete(requestId),5000);
    io.to(h.socketId).emit('game:remote-action', {
      requestId,
      slot: p.slot,
      playerId: p.playerId,
      action: payload?.action,
      payload: payload?.payload || {}
    });
  });

  socket.on('game:action-result', payload => {
    const room = findRoomOf(socket);
    if (!room?.started || !isHostSocket(room, socket)) return;
    const requestId = cleanText(payload?.requestId,'',80);
    const pending = room.pendingActions?.get(requestId);
    if (!pending) return;
    room.pendingActions.delete(requestId);
    io.to(pending.socketId).emit('game:action-result', {
      requestId,
      action: pending.action,
      ok: !!payload?.ok,
      detail: payload?.detail || {}
    });
  });

  socket.on('game:meta-award', payload => {
    const room = findRoomOf(socket);
    if (!room?.started || !isHostSocket(room, socket)) return;
    const slot = Number(payload?.slot);
    const target = sortedPlayers(room).find(p=>p.slot===slot && p.connected && p.socketId);
    const diamonds = Math.max(0,Math.min(50,Math.floor(Number(payload?.diamonds)||0)));
    const gold = Math.max(0,Math.min(5000,Math.floor(Number(payload?.gold)||0)));
    if (!target || (diamonds<=0 && gold<=0)) return;
    io.to(target.socketId).emit('game:meta-award',{gold,diamonds,reason:cleanText(payload?.reason,'chest',24),at:Date.now()});
  });

  socket.on('game:pause-request', payload => {
    const room = findRoomOf(socket);
    const p = room ? playerBySocket(room, socket.id) : null;
    const h = room ? hostPlayer(room) : null;
    if (!room?.started || !p || !h?.connected) return;
    io.to(h.socketId).emit('game:pause-request', { slot: p.slot, playerId: p.playerId, paused: !!payload?.paused });
  });

  socket.on('game:pause-state', payload => {
    const room = findRoomOf(socket);
    if (!room?.started || !isHostSocket(room, socket)) return;
    room.paused = !!payload?.paused;
    io.to(room.code).emit('game:pause-state', { paused: room.paused, by: payload?.by ?? 0 });
  });

  socket.on('game:milestone', payload => {
    const room = findRoomOf(socket);
    if (!room?.started || !isHostSocket(room, socket)) return;
    io.to(room.code).emit('game:milestone', {
      type: cleanText(payload?.type, 'milestone', 32),
      data: payload?.data || {},
      at: Date.now()
    });
  });

  socket.on('disconnect', reason => {
    console.log('Jogador desconectado:', socket.id, reason);
    leaveCurrentRoom(socket, 'disconnect');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==================================');
  console.log(' REI DOS MARES - SERVIDOR PÚBLICO');
  console.log('==================================');
  console.log(`Porta: ${PORT}`);
  console.log(`Versão: ${VERSION}`);
  console.log(`Origens permitidas: ${[...ALLOWED_ORIGINS].join(', ')}`);
  console.log(`Retorno à partida: ${Math.round(REJOIN_MS/1000)} segundos.`);
  console.log('Aguardando jogadores...');
});
