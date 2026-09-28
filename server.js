'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const ROOM_STALE_MS = 30 * 60 * 1000; // ลบห้องที่ไม่มีใครออนไลน์เกิน 30 นาที

const rooms = {}; // code -> room

/* ===================== deck utilities ===================== */
const COLORS = ['R', 'Y', 'G', 'B'];
const COLOR_NAMES = { R: 'แดง', Y: 'เหลือง', G: 'เขียว', B: 'น้ำเงิน' };

function buildDeck() {
  const d = [];
  for (const c of COLORS) {
    d.push(c + '0');
    for (let n = 1; n <= 9; n++) { d.push(c + n); d.push(c + n); }
    for (const v of ['SKIP', 'REV', 'D2']) { d.push(c + v); d.push(c + v); }
  }
  for (let i = 0; i < 4; i++) { d.push('WILD'); d.push('WILD4'); }
  return d;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function isWild(c) { return c === 'WILD' || c === 'WILD4'; }
function colorOf(c) { return isWild(c) ? null : c[0]; }
function valueOf(c) { return isWild(c) ? c : c.slice(1); }
function cardPlayable(c, topColor, topValue) {
  if (isWild(c)) return true;
  if (colorOf(c) === topColor) return true;
  if (valueOf(c) === topValue) return true;
  return false;
}
function cardText(card) {
  if (card === 'WILD') return 'Wild (เลือกสี)';
  if (card === 'WILD4') return 'Wild +4 (เลือกสี)';
  const col = COLOR_NAMES[colorOf(card)];
  const v = valueOf(card);
  const vLabel = v === 'SKIP' ? 'ข้ามตา' : v === 'REV' ? 'ย้อนกลับ' : v === 'D2' ? 'บวก 2' : v;
  return col + ' ' + vLabel;
}
function mod(a, n) { return ((a % n) + n) % n; }
function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function appendLog(room, msg) {
  room.log = room.log || [];
  room.log.push({ msg, ts: Date.now() });
  if (room.log.length > 15) room.log = room.log.slice(-15);
}

/* ===================== room helpers ===================== */
function newRoom(code, hostId) {
  return {
    code, status: 'waiting', hostId,
    players: [], hands: {},
    turnOrder: [], currentIndex: 0, direction: 1,
    deck: [], discard: [], currentColor: null, pendingDraw: 0,
    unoState: {}, winner: null, log: [],
  };
}
function publicState(room) {
  return {
    code: room.code, status: room.status, hostId: room.hostId,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, connected: p.connected,
      cardCount: (room.hands[p.id] || []).length,
    })),
    turnOrder: room.turnOrder, currentIndex: room.currentIndex, direction: room.direction,
    discard: room.discard, currentColor: room.currentColor, deckCount: room.deck.length,
    pendingDraw: room.pendingDraw, unoState: room.unoState, winner: room.winner, log: room.log,
  };
}
function broadcastRoom(code) {
  const room = rooms[code]; if (!room) return;
  io.to(code).emit('state', publicState(room));
}
function sendHand(room, playerId) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p || !p.socketId) return;
  io.to(p.socketId).emit('hand', { cards: room.hands[playerId] || [] });
}
function sendAllHands(room) {
  room.players.forEach((p) => sendHand(room, p.id));
}
function drawOne(room) {
  if (room.deck.length === 0) {
    if (room.discard.length <= 1) return null;
    const top = room.discard.pop();
    room.deck = shuffle(room.discard);
    room.discard = [top];
  }
  return room.deck.shift();
}
function startDeal(room) {
  room.deck = shuffle(buildDeck());
  room.hands = {};
  room.turnOrder.forEach((id) => { room.hands[id] = []; });
  for (let r = 0; r < 7; r++) {
    room.turnOrder.forEach((id) => { room.hands[id].push(room.deck.shift()); });
  }
  let discardCard = null, guard = 0;
  const setAside = [];
  while (room.deck.length && guard < room.deck.length + 2) {
    const c = room.deck.shift();
    if (!isWild(c)) { discardCard = c; break; }
    setAside.push(c); guard++;
  }
  room.deck = room.deck.concat(setAside);
  if (!discardCard) discardCard = 'R0';
  room.discard = [discardCard];
  room.currentColor = colorOf(discardCard);
  room.currentIndex = 0; room.direction = 1; room.pendingDraw = 0;
  room.status = 'playing';
  appendLog(room, 'แจกไพ่ครบแล้ว เริ่มเกม! เปิดไพ่: ' + cardText(discardCard));
}

/* ===================== socket handlers ===================== */
io.on('connection', (socket) => {
  socket.on('create_room', ({ name, clientId }) => {
    if (!clientId) return;
    const code = randomCode();
    const room = newRoom(code, clientId);
    const safeName = (name || 'ผู้เล่น').toString().slice(0, 20);
    room.players.push({ id: clientId, name: safeName, connected: true, socketId: socket.id });
    room.hands[clientId] = [];
    rooms[code] = room;
    socket.join(code);
    socket.data.clientId = clientId; socket.data.code = code;
    appendLog(room, safeName + ' สร้างห้อง');
    socket.emit('joined', { code });
    broadcastRoom(code);
  });

  socket.on('join_room', ({ code, name, clientId }) => {
    if (!clientId) return;
    code = (code || '').toString().toUpperCase();
    const room = rooms[code];
    if (!room) { socket.emit('error_msg', 'ไม่พบห้องนี้ครับ ลองเช็คโค้ดอีกครั้ง'); return; }
    let p = room.players.find((x) => x.id === clientId);
    const safeName = (name || 'ผู้เล่น').toString().slice(0, 20);
    if (!p) {
      if (room.status !== 'waiting') { socket.emit('error_msg', 'เกมห้องนี้เริ่มไปแล้ว เข้าร่วมใหม่ไม่ได้ครับ'); return; }
      if (room.players.length >= MAX_PLAYERS) { socket.emit('error_msg', 'ห้องนี้เต็มแล้วครับ (สูงสุด ' + MAX_PLAYERS + ' คน)'); return; }
      p = { id: clientId, name: safeName, connected: true, socketId: socket.id };
      room.players.push(p);
      room.hands[clientId] = room.hands[clientId] || [];
      appendLog(room, safeName + ' เข้าร่วมห้อง');
    } else {
      p.connected = true; p.socketId = socket.id; p.name = safeName;
    }
    socket.join(code);
    socket.data.clientId = clientId; socket.data.code = code;
    socket.emit('joined', { code });
    sendHand(room, clientId);
    broadcastRoom(code);
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code]; if (!room || room.status !== 'waiting') return;
    if (room.players.length < 2) return;
    room.turnOrder = room.players.map((p) => p.id);
    startDeal(room);
    sendAllHands(room);
    broadcastRoom(code);
  });

  socket.on('play_card', ({ code, cardIndex, chosenColor }) => {
    const room = rooms[code]; if (!room || room.status !== 'playing') return;
    const clientId = socket.data.clientId;
    if (room.turnOrder[room.currentIndex] !== clientId) return;
    if (room.pendingDraw > 0) return;
    const hand = room.hands[clientId] || [];
    const card = hand[cardIndex]; if (!card) return;
    const topVal = valueOf(room.discard[room.discard.length - 1]);
    if (!cardPlayable(card, room.currentColor, topVal)) return;
    if (isWild(card) && !chosenColor) { socket.emit('need_color', { cardIndex }); return; }

    hand.splice(cardIndex, 1);
    const n = room.turnOrder.length;
    let dir = room.direction, idxNext = room.currentIndex, pending = 0;
    const color = isWild(card) ? chosenColor : colorOf(card);
    const v = valueOf(card);
    if (v === 'REV') {
      if (n === 2) { idxNext = mod(idxNext + 2 * dir, n); }
      else { dir = -dir; idxNext = mod(idxNext + dir, n); }
    } else if (v === 'SKIP') { idxNext = mod(idxNext + 2 * dir, n); }
    else if (v === 'D2') { pending = 2; idxNext = mod(idxNext + dir, n); }
    else if (card === 'WILD4') { pending = 4; idxNext = mod(idxNext + dir, n); }
    else { idxNext = mod(idxNext + dir, n); }

    room.discard.push(card);
    if (room.discard.length > 30) room.discard = room.discard.slice(-30);
    room.currentColor = color; room.direction = dir; room.currentIndex = idxNext; room.pendingDraw = pending;

    const p = room.players.find((x) => x.id === clientId);
    if (hand.length === 1) room.unoState[clientId] = 'vulnerable'; else delete room.unoState[clientId];
    appendLog(room, (p ? p.name : 'ผู้เล่น') + ' เล่น ' + cardText(card));
    if (hand.length === 0) {
      room.status = 'finished'; room.winner = clientId;
      appendLog(room, (p ? p.name : 'ผู้เล่น') + ' ชนะแล้ว! 🎉');
    }
    sendHand(room, clientId);
    broadcastRoom(code);
  });

  socket.on('draw_card', ({ code }) => {
    const room = rooms[code]; if (!room || room.status !== 'playing') return;
    const clientId = socket.data.clientId;
    if (room.turnOrder[room.currentIndex] !== clientId || room.pendingDraw > 0) return;
    const card = drawOne(room); if (!card) return;
    room.hands[clientId] = room.hands[clientId] || [];
    room.hands[clientId].push(card);
    const n = room.turnOrder.length;
    room.currentIndex = mod(room.currentIndex + room.direction, n);
    const p = room.players.find((x) => x.id === clientId);
    appendLog(room, (p ? p.name : 'ผู้เล่น') + ' จั่วไพ่ 1 ใบ');
    sendHand(room, clientId);
    broadcastRoom(code);
  });

  socket.on('resolve_forced_draw', ({ code }) => {
    const room = rooms[code]; if (!room || room.status !== 'playing') return;
    const clientId = socket.data.clientId;
    if (room.turnOrder[room.currentIndex] !== clientId || room.pendingDraw <= 0) return;
    let need = room.pendingDraw; const drawn = [];
    while (need > 0) { const c = drawOne(room); if (!c) break; drawn.push(c); need--; }
    room.hands[clientId] = (room.hands[clientId] || []).concat(drawn);
    room.pendingDraw = 0;
    const n = room.turnOrder.length;
    room.currentIndex = mod(room.currentIndex + room.direction, n);
    const p = room.players.find((x) => x.id === clientId);
    appendLog(room, (p ? p.name : 'ผู้เล่น') + ' จั่ว ' + drawn.length + ' ใบ (โดนบังคับ)');
    sendHand(room, clientId);
    broadcastRoom(code);
  });

  socket.on('declare_uno', ({ code }) => {
    const room = rooms[code]; if (!room) return;
    const clientId = socket.data.clientId;
    if ((room.hands[clientId] || []).length !== 1) return;
    room.unoState[clientId] = 'safe';
    const p = room.players.find((x) => x.id === clientId);
    appendLog(room, (p ? p.name : 'ผู้เล่น') + ' ตะโกน UNO! 🔥');
    broadcastRoom(code);
  });

  socket.on('catch_uno', ({ code, targetId }) => {
    const room = rooms[code]; if (!room) return;
    if (room.unoState[targetId] !== 'vulnerable') return;
    delete room.unoState[targetId];
    const drawn = []; for (let i = 0; i < 2; i++) { const c = drawOne(room); if (c) drawn.push(c); }
    room.hands[targetId] = (room.hands[targetId] || []).concat(drawn);
    const catcher = room.players.find((x) => x.id === socket.data.clientId);
    const target = room.players.find((x) => x.id === targetId);
    appendLog(room, (catcher ? catcher.name : 'ผู้เล่น') + ' จับได้ว่า ' + (target ? target.name : 'คู่แข่ง') + ' ลืมพูด UNO! โดนจั่วเพิ่ม 2 ใบ');
    sendHand(room, targetId);
    broadcastRoom(code);
  });

  socket.on('play_again', ({ code }) => {
    const room = rooms[code]; if (!room || room.status !== 'finished') return;
    room.status = 'waiting'; room.deck = []; room.discard = []; room.currentColor = null; room.pendingDraw = 0;
    room.unoState = {}; room.winner = null; room.currentIndex = 0;
    room.players.forEach((p) => { room.hands[p.id] = []; });
    appendLog(room, 'เริ่มเกมใหม่อีกรอบ');
    sendAllHands(room);
    broadcastRoom(code);
  });

  socket.on('leave_room', ({ code }) => {
    const room = rooms[code]; if (!room) return;
    const clientId = socket.data.clientId;
    if (room.status === 'waiting') {
      room.players = room.players.filter((p) => p.id !== clientId);
      delete room.hands[clientId];
      appendLog(room, 'มีผู้เล่นออกจากห้อง');
      broadcastRoom(code);
    }
    socket.leave(code);
  });

  socket.on('disconnect', () => {
    const code = socket.data.code; const clientId = socket.data.clientId;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const p = room.players.find((x) => x.id === clientId);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      broadcastRoom(code);
    }
  });
});

// ล้างห้องที่ไม่มีใครออนไลน์นานเกินไป กันหน่วยความจำรั่ว
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach((code) => {
    const room = rooms[code];
    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected) {
      room._staleSince = room._staleSince || now;
      if (now - room._staleSince > ROOM_STALE_MS) delete rooms[code];
    } else {
      delete room._staleSince;
    }
  });
}, 5 * 60 * 1000);

server.listen(PORT, () => console.log('UNO server listening on port ' + PORT));
