'use strict';

/**
 * «Морской бой» по сети — многопользовательская игра в реальном времени.
 *
 * Чистый Node.js, без внешних библиотек и фреймворков:
 *  - HTTP-сервер раздаёт статику из папки public/;
 *  - WebSocket реализован вручную по RFC 6455 (рукопожатие + кадры);
 *  - состояние игр сохраняется в games.json и восстанавливается после перезапуска;
 *  - клиент хранит токен в localStorage и восстанавливает игру после переподключения.
 *
 * Запуск:  node server.js   (открыть http://localhost:3000 в двух вкладках/браузерах)
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAVE_FILE = path.join(__dirname, 'games.json');

// ---------------------------------------------------------------------------
// Игровые константы
// ---------------------------------------------------------------------------

const SIZE = 10;
const LETTERS = 'АБВГДЕЖЗИК'.split('');
// Классический русский флот: 1 четырёхпалубный, 2 трёхпалубных,
// 3 двухпалубных, 4 однопалубных.
const SHIP_SIZES = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

// ---------------------------------------------------------------------------
// Состояние и сохранение на диск
// ---------------------------------------------------------------------------

// games: id -> { id, status, turn, winner, createdAt, updatedAt, players[] }
// player: { id, token, name, ws, connected, grid, ships, shots }
const state = { games: {} };

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (data && data.games) {
      for (const [id, g] of Object.entries(data.games)) {
        for (const p of g.players) {
          p.ws = null;
          p.connected = false; // после рестарта все считаются отключёнными
        }
        state.games[id] = g;
      }
      console.log(`[persist] Восстановлено игр из ${SAVE_FILE}: ${Object.keys(state.games).length}`);
    }
  } catch (e) {
    // файла нет или он повреждён — начинаем с чистого листа
  }
}

function saveState() {
  const savable = {};
  for (const [id, g] of Object.entries(state.games)) {
    savable[id] = {
      id: g.id,
      status: g.status,
      turn: g.turn,
      winner: g.winner,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      players: g.players.map((p) => ({
        id: p.id,
        token: p.token,
        name: p.name,
        grid: p.grid,
        ships: p.ships,
        shots: p.shots,
        connected: false, // статус соединения восстанавливать не нужно
      })),
    };
  }
  try {
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ games: savable }, null, 2));
  } catch (e) {
    console.error('[persist] Ошибка сохранения:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Логика «Морского боя»
// ---------------------------------------------------------------------------

function randomBoard() {
  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  const ships = [];
  let shipId = 0;

  // Клетка свободна для нового корабля, если она сама и все 8 её соседей
  // не заняты другими кораблями (корабли не должны касаться даже углами).
  const cellFree = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && grid[ny][nx] !== null) {
          return false;
        }
      }
    }
    return true;
  };

  for (const size of SHIP_SIZES) {
    let placed = false;
    for (let attempt = 0; attempt < 1000 && !placed; attempt++) {
      const horizontal = Math.random() < 0.5;
      const x = Math.floor(Math.random() * (horizontal ? SIZE - size + 1 : SIZE));
      const y = Math.floor(Math.random() * (horizontal ? SIZE : SIZE - size + 1));
      const cells = [];
      for (let i = 0; i < size; i++) cells.push(horizontal ? [x + i, y] : [x, y + i]);
      // каждая клетка корабля (включая её «ореол» из соседей) должна быть пустой
      if (cells.every(([cx, cy]) => cellFree(cx, cy))) {
        cells.forEach(([cx, cy]) => (grid[cy][cx] = shipId));
        ships.push({ id: shipId, size, cells, hits: 0 });
        shipId++;
        placed = true;
      }
    }
    if (!placed) shipId++; // теоретически не случается на поле 10x10
  }
  return { grid, ships };
}

function setupBoard(player) {
  const b = randomBoard();
  player.grid = b.grid;
  player.ships = b.ships;
  player.shots = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function countShipsLeft(player) {
  return player.ships.filter((s) => s.hits < s.size).length;
}

function coords(x, y) {
  return `${LETTERS[x]}${y + 1}`;
}

function findPlayerByToken(token) {
  for (const g of Object.values(state.games)) {
    for (let i = 0; i < g.players.length; i++) {
      if (g.players[i].token === token) return { game: g, idx: i };
    }
  }
  return null;
}

function findPlayerByWs(ws) {
  for (const g of Object.values(state.games)) {
    for (let i = 0; i < g.players.length; i++) {
      if (g.players[i].ws === ws) return { game: g, idx: i };
    }
  }
  return null;
}

function sendToPlayer(game, idx, obj) {
  const p = game.players[idx];
  if (p && p.ws) p.ws.send(JSON.stringify(obj));
}

function sendToGame(game, obj) {
  for (const p of game.players) if (p.ws) p.ws.send(JSON.stringify(obj));
}

// Представление игры для конкретного игрока (без чужих кораблей).
function viewFor(game, idx) {
  const me = game.players[idx];
  const opp = game.players[1 - idx];
  const yourBoard = [];
  const enemyBoard = [];
  for (let y = 0; y < SIZE; y++) {
    const ra = [];
    const rb = [];
    for (let x = 0; x < SIZE; x++) {
      ra.push({ ship: me.grid[y][x] !== null, shot: me.shots[y][x] });
      rb.push({ shot: opp.shots[y][x] });
    }
    yourBoard.push(ra);
    enemyBoard.push(rb);
  }
  return {
    type: 'state',
    status: game.status,
    turn: game.turn,
    yourIndex: idx,
    yourName: me.name,
    opponentName: opp.name,
    opponentConnected: opp.connected,
    yourBoard,
    enemyBoard,
    yourShipsLeft: countShipsLeft(me),
    opponentShipsLeft: countShipsLeft(opp),
    winner: game.winner,
  };
}

function sendAllState(game) {
  // В игре «ожидание» соперника ещё нет и доска не расставлена — слать состояние нечего.
  if (game.status === 'waiting' || game.players.length < 2) return;
  for (let i = 0; i < game.players.length; i++) {
    if (game.players[i].ws) {
      game.players[i].ws.send(JSON.stringify(viewFor(game, i)));
    }
  }
}

// ---------------------------------------------------------------------------
// Обработчики сообщений от клиентов
// ---------------------------------------------------------------------------

function onJoin(ws, msg) {
  const name = String(msg.name || 'Игрок').slice(0, 20) || 'Игрок';
  const token = msg.token || null;

  // 1) Попытка восстановить игрока по токену (переподключение).
  if (token) {
    const ref = findPlayerByToken(token);
    if (ref) {
      const { game, idx } = ref;
      const player = game.players[idx];
      if (player.ws && player.ws !== ws) {
        player.ws.onclose = null; // старый сокет больше не управляет состоянием
        try { player.ws.socket.end(); } catch (e) {}
      }
      player.ws = ws;
      player.connected = true;
      if (msg.name) player.name = name;
      ws.send(JSON.stringify({ type: 'joined', token: player.token, playerId: player.id }));
      if (game.status === 'waiting') {
        // соперник ещё не пришёл — снова ждём
        ws.send(JSON.stringify({ type: 'waiting' }));
      } else {
        sendAllState(game);
        sendToPlayer(game, 1 - idx, { type: 'event', text: `${player.name} снова в игре` });
      }
      return;
    }
  }

  // 2) Новый игрок.
  const player = {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
    token: (crypto.randomUUID && crypto.randomUUID()) || String(Math.random() + Date.now()),
    name,
    ws,
    connected: true,
    grid: null,
    ships: null,
    shots: null,
  };

  // Ищем ожидающую игру (с уже подключённым первым игроком).
  let game = null;
  for (const g of Object.values(state.games)) {
    if (g.status === 'waiting' && g.players.length === 1 && g.players[0].connected) {
      game = g;
      break;
    }
  }

  if (game) {
    game.players.push(player);
    game.players.forEach(setupBoard);
    game.status = 'playing';
    game.turn = Math.random() < 0.5 ? 0 : 1;
    game.updatedAt = Date.now();
    ws.send(JSON.stringify({ type: 'joined', token: player.token, playerId: player.id }));
    sendToGame(game, { type: 'event', text: 'Соперник найден — бой начался!' });
    sendAllState(game);
    saveState();
  } else {
    game = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
      status: 'waiting',
      turn: 0,
      winner: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      players: [player],
    };
    state.games[game.id] = game;
    ws.send(JSON.stringify({ type: 'joined', token: player.token, playerId: player.id }));
    ws.send(JSON.stringify({ type: 'waiting' }));
    saveState();
  }
}

function onShoot(ws, msg) {
  const ref = findPlayerByWs(ws);
  if (!ref) return;
  const { game, idx } = ref;

  if (game.status !== 'playing') {
    ws.send(JSON.stringify({ type: 'error', message: 'Игра сейчас не идёт.' }));
    return;
  }
  if (game.turn !== idx) {
    ws.send(JSON.stringify({ type: 'error', message: 'Сейчас ход противника.' }));
    return;
  }
  const x = msg.x;
  const y = msg.y;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
    ws.send(JSON.stringify({ type: 'error', message: 'Некорректные координаты.' }));
    return;
  }

  const opp = game.players[1 - idx];
  // Конкурентный доступ: повторный выстрел в одну клетку блокируется на сервере.
  if (opp.shots[y][x] !== null) {
    ws.send(JSON.stringify({ type: 'error', message: 'В эту клетку уже стреляли.' }));
    return;
  }

  const cell = opp.grid[y][x];
  let result;
  if (cell === null) {
    opp.shots[y][x] = 'miss';
    result = 'miss';
  } else {
    opp.shots[y][x] = 'hit';
    const ship = opp.ships.find((s) => s.id === cell);
    ship.hits++;
    result = ship.hits >= ship.size ? 'sunk' : 'hit';
  }

  let evShooter;
  let evOpp;
  if (result === 'miss') {
    evShooter = `Мимо (${coords(x, y)}).`;
    evOpp = `Противник промахнулся (${coords(x, y)}).`;
    game.turn = 1 - idx; // промах — ход переходит
  } else if (result === 'hit') {
    evShooter = `Попадание (${coords(x, y)})!`;
    evOpp = `В ваш корабль попали (${coords(x, y)})!`;
    // попадание — тот же игрок стреляет ещё раз
  } else {
    evShooter = `Корабль потоплен (${coords(x, y)})!`;
    evOpp = `Ваш корабль потоплен (${coords(x, y)})!`;
  }

  if (opp.ships.every((s) => s.hits >= s.size)) {
    game.status = 'finished';
    game.winner = idx;
  }

  game.updatedAt = Date.now();
  saveState();

  sendToPlayer(game, idx, { type: 'event', text: evShooter });
  sendToPlayer(game, 1 - idx, { type: 'event', text: evOpp });
  sendAllState(game);
}

function onRestart(ws) {
  const ref = findPlayerByWs(ws);
  if (!ref) return;
  const { game } = ref;
  if (game.status !== 'finished' && game.status !== 'playing') return;
  game.players.forEach(setupBoard);
  game.status = 'playing';
  game.winner = null;
  game.turn = Math.random() < 0.5 ? 0 : 1;
  game.updatedAt = Date.now();
  saveState();
  sendToGame(game, { type: 'event', text: 'Новая партия началась!' });
  sendAllState(game);
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'join': return onJoin(ws, msg);
    case 'shoot': return onShoot(ws, msg);
    case 'restart': return onRestart(ws);
    default: return;
  }
}

function handleDisconnect(ws) {
  for (const g of Object.values(state.games)) {
    for (let i = 0; i < g.players.length; i++) {
      const p = g.players[i];
      if (p.ws === ws) {
        p.ws = null;
        p.connected = false;
        const opp = g.players[1 - i];
        if (opp && opp.ws) {
          opp.ws.send(JSON.stringify({ type: 'event', text: 'Противник отключился.' }));
          if (g.status === 'playing' || g.status === 'finished') {
            opp.ws.send(JSON.stringify(viewFor(g, 1 - i)));
          }
        }
        saveState();
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Минимальный WebSocket-сервер (RFC 6455)
// ---------------------------------------------------------------------------

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WS {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onmessage = null;
    this.onclose = null;
    this._didClose = false;
    socket.on('data', (chunk) => this._onData(chunk));
    // 'end' ловит обрыв TCP-соединения (в т.ч. без корректного close-кадра),
    // 'close' — полное закрытие сокета; обрабатываем отключение ровно один раз.
    socket.on('close', () => this._closed());
    socket.on('end', () => this._closed());
    socket.on('error', () => {});
  }

  _closed() {
    if (this._didClose) return;
    this._didClose = true;
    if (this.onclose) this.onclose();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._parse();
  }

  _parse() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        len = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + len) return;

      let payload = this.buffer.slice(offset, offset + len);
      if (masked && mask) {
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4];
        payload = un;
      }
      this.buffer = this.buffer.slice(offset + len);

      if (opcode === 0x1) {
        // текстовый кадр (для наших сообщений фрагментация не используется)
        if (this.onmessage) this.onmessage(payload.toString('utf8'));
      } else if (opcode === 0x8) {
        this._sendFrame(payload, 0x8); // close
        this._closed();
        return;
      } else if (opcode === 0x9) {
        this._sendFrame(payload, 0xA); // ping -> pong
      }
    }
  }

  _sendFrame(payload, opcode) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) {
    this._sendFrame(Buffer.from(text, 'utf8'), 0x1);
  }
}

// ---------------------------------------------------------------------------
// HTTP-сервер + upgrade
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    urlPath = '/';
  }
  if (urlPath === '/') urlPath = '/index.html';

  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket, head) => {
  if (!req.headers['sec-websocket-key']) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + WS_MAGIC)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  const ws = new WS(socket);
  ws.onmessage = (text) => handleMessage(ws, text);
  ws.onclose = () => handleDisconnect(ws);
  // Байты, пришедшие вместе с рукопожатием (если клиент отправил первый кадр сразу),
  // не должны теряться.
  if (head && head.length) ws._onData(head);
});

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

loadState();
server.listen(PORT, () => {
  console.log(`Морской бой запущен: http://localhost:${PORT}`);
  console.log('Откройте адрес в двух вкладках, чтобы сыграть вдвоём.');
});
