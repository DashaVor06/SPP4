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
const USERS_FILE = path.join(__dirname, 'users.json');

// ---------------------------------------------------------------------------
// Игровые константы
// ---------------------------------------------------------------------------

const SIZE = 10;
const LETTERS = 'АБВГДЕЖЗИК'.split('');
// Классический русский флот: 1 четырёхпалубный, 2 трёхпалубных,
// 3 двухпалубных, 4 однопалубных.
const SHIP_SIZES = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

// Общие ограничения
const MAX_NAME_LENGTH = 20;      // максимальная длина имени игрока
const PLACEMENT_ATTEMPTS = 1000; // попыток случайно расставить корабль

// Авторизация
const MIN_USERNAME_LENGTH = 3;   // минимальная длина логина
const MAX_USERNAME_LENGTH = 20;  // максимальная длина логина
const MIN_PASSWORD_LENGTH = 4;   // минимальная длина пароля
const PASSWORD_KEY_BYTES = 64;   // длина scrypt-хеша пароля (байт)
const SALT_BYTES = 16;           // длина соли (байт)
const TOKEN_BYTES = 16;          // длина случайного токена (байт)
const USERNAME_PATTERN = new RegExp(
  `^[a-zA-Zа-яА-Я0-9_-]{${MIN_USERNAME_LENGTH},${MAX_USERNAME_LENGTH}}$`
);

// ---------------------------------------------------------------------------
// Состояние и сохранение на диск
// ---------------------------------------------------------------------------

// games: id -> { id, status, turn, winner, createdAt, updatedAt, players[] }
// player: { id, token, name, ws, connected, grid, ships, shots }
const state = { games: {} };

// Восстанавливает сохранённые партии из games.json в память при старте сервера.
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

// Сериализует все партии в games.json (вызывается после каждого действия).
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
// Пользователи, авторизация и таблица результатов
// ---------------------------------------------------------------------------

// users: username -> { salt, hash, results: [{ opponent, result, date }] }
const users = {};
// authToken -> username (сессии живут в памяти; пользователи и результаты — на диске)
const sessions = new Map();

// Загружает пользователей и их результаты из users.json при старте.
function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for (const [name, u] of Object.entries(data)) users[name] = u;
    console.log(`[auth] Загружено пользователей: ${Object.keys(users).length}`);
  } catch (e) {
    // файла нет — начнём с пустого списка
  }
}

// Сохраняет пользователей и их результаты в users.json.
function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error('[auth] Ошибка сохранения пользователей:', e.message);
  }
}

// Хеширование пароля: scrypt с солью (встроенный модуль crypto).
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, PASSWORD_KEY_BYTES).toString('hex');
}

// Создаёт токен сессии и связывает его с логином (хранится в памяти).
function issueToken(username) {
  const token = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(TOKEN_BYTES).toString('hex');
  sessions.set(token, username);
  return token;
}

// Формирует ответ auth: логин, свежий токен и таблицу результатов пользователя.
function authPayload(username) {
  const u = users[username] || { results: [] };
  return { type: 'auth', ok: true, username, authToken: issueToken(username), results: u.results || [] };
}

// Обработчик регистрации: проверяет логин и пароль, создаёт аккаунт.
function onRegister(ws, msg) {
  const username = String(msg.username || '').trim();
  const password = String(msg.password || '');
  if (!USERNAME_PATTERN.test(username)) {
    ws.send(JSON.stringify({ type: 'auth', ok: false,
      error: `Логин: ${MIN_USERNAME_LENGTH}–${MAX_USERNAME_LENGTH} символов (буквы, цифры, «_», «-»).` }));
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    ws.send(JSON.stringify({ type: 'auth', ok: false,
      error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.` }));
    return;
  }
  if (users[username]) {
    ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Такой логин уже занят.' }));
    return;
  }
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  users[username] = { salt, hash: hashPassword(password, salt), results: [] };
  saveUsers();
  ws.send(JSON.stringify(authPayload(username)));
}

// Обработчик входа: сверяет хеш введённого пароля с сохранённым.
function onLogin(ws, msg) {
  const username = String(msg.username || '').trim();
  const password = String(msg.password || '');
  const u = users[username];
  if (!u) {
    ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Пользователь не найден.' }));
    return;
  }
  // Хешируем введённый пароль с той же солью и сравниваем хеши.
  const expected = Buffer.from(u.hash, 'hex');
  const actual = Buffer.from(hashPassword(password, u.salt), 'hex');
  // timingSafeEqual сравнивает за константное время (защита от атаки по времени).
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Неверный пароль.' }));
    return;
  }
  ws.send(JSON.stringify(authPayload(username)));
}

// Восстанавливает сессию по authToken (после перезагрузки страницы).
function onRestore(ws, msg) {
  const username = sessions.get(msg.authToken);
  if (!username) {
    ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Сессия истекла, войдите заново.' }));
    return;
  }
  ws.send(JSON.stringify(authPayload(username)));
}

// Удаляет токен сессии из памяти (выход из аккаунта).
function onLogout(ws, msg) {
  sessions.delete(msg.authToken);
}

// По запросу клиента отправляет ему его таблицу результатов.
function onResults(ws, msg) {
  const username = sessions.get(msg.authToken);
  if (!username) {
    ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Сессия истекла, войдите заново.' }));
    return;
  }
  sendResults(ws, username);
}

// Отправляет сообщение results с таблицей результатов конкретного пользователя.
function sendResults(ws, username) {
  const u = users[username];
  ws.send(JSON.stringify({ type: 'results', results: (u && u.results) || [] }));
}

// Записывает результат завершённой партии в таблицы обоих игроков.
function recordResult(game) {
  // Ничья не предусмотрена: без победителя записывать нечего.
  if (game.winner === null) return;
  // Добавляем запись в таблицу каждого авторизованного участника.
  for (let i = 0; i < game.players.length; i++) {
    const p = game.players[i];
    if (!p.authUsername) continue; // гость играл без аккаунта — результат не сохраняем
    const u = users[p.authUsername];
    if (!u) continue;
    if (!u.results) u.results = [];
    // Победителю — 'win', проигравшему — 'loss'.
    u.results.push({
      opponent: game.players[1 - i].name,
      result: i === game.winner ? 'win' : 'loss',
      date: Date.now(),
    });
  }
  saveUsers();
}

// Рассылает обновлённую таблицу результатов авторизованным участникам.
function broadcastResults(game) {
  for (const p of game.players) {
    if (p.authUsername && p.ws) sendResults(p.ws, p.authUsername);
  }
}

// ---------------------------------------------------------------------------
// Логика «Морского боя»
// ---------------------------------------------------------------------------

// Генерирует случайную расстановку кораблей по правилам (корабли не касаются).
function randomBoard() {
  // Сетка поля: каждая клетка хранит id корабля или null (пустая клетка).
  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  const ships = [];
  let shipId = 0;

  // Клетка свободна для нового корабля, если она сама и все 8 её соседей
  // не заняты другими кораблями (корабли не должны касаться даже углами).
  const cellFree = (x, y) => {
    // Квадрат 3×3 вокруг клетки: dx и dy пробегают от -1 до 1 (включая саму клетку).
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

  // Ставим корабли по одному, от самого большого к самым маленьким.
  for (const size of SHIP_SIZES) {
    let placed = false;
    // Несколько случайных попыток, пока не найдём место, где корабль помещается.
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && !placed; attempt++) {
      const horizontal = Math.random() < 0.5; // ориентация: горизонтально или вертикально
      // Стартовая клетка с учётом, что корабль должен целиком влезть в поле.
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
    // На поле 10×10 места всегда хватает; сдвигаем id, чтобы не было «дыр» в нумерации.
    if (!placed) shipId++;
  }
  return { grid, ships };
}

// Заполняет игроку доску: случайная расстановка кораблей + пустая история выстрелов.
function setupBoard(player) {
  const b = randomBoard();
  player.grid = b.grid;
  player.ships = b.ships;
  player.shots = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

// Возвращает число ещё не потопленных кораблей игрока.
function countShipsLeft(player) {
  return player.ships.filter((s) => s.hits < s.size).length;
}

// Преобразует координаты (x, y) в человекочитаемый вид, например «А5».
function coords(x, y) {
  return `${LETTERS[x]}${y + 1}`;
}

// Ищет игрока по игровому токену по всем партиям; возвращает {game, idx} или null.
function findPlayerByToken(token) {
  for (const g of Object.values(state.games)) {
    for (let i = 0; i < g.players.length; i++) {
      if (g.players[i].token === token) return { game: g, idx: i };
    }
  }
  return null;
}

// Ищет игрока по его WebSocket-соединению; возвращает {game, idx} или null.
function findPlayerByWs(ws) {
  for (const g of Object.values(state.games)) {
    for (let i = 0; i < g.players.length; i++) {
      if (g.players[i].ws === ws) return { game: g, idx: i };
    }
  }
  return null;
}

// Отправляет JSON-сообщение конкретному игроку партии (если он подключён).
function sendToPlayer(game, idx, obj) {
  const p = game.players[idx];
  if (p && p.ws) p.ws.send(JSON.stringify(obj));
}

// Отправляет JSON-сообщение всем подключённым игрокам партии.
function sendToGame(game, obj) {
  for (const p of game.players) if (p.ws) p.ws.send(JSON.stringify(obj));
}

// Строит персональное представление партии для игрока idx.
// Важно: на поле противника чужие корабли не раскрываются — видны только
// результаты выстрелов (hit/miss/sunk) и «ореолы» потопленных кораблей.
function viewFor(game, idx) {
  const me = game.players[idx];
  const opp = game.players[1 - idx];

  // Множества потопленных кораблей (по id) для обоих игроков.
  const sunkMe = new Set(me.ships.filter((s) => s.hits >= s.size).map((s) => s.id));
  const sunkOpp = new Set(opp.ships.filter((s) => s.hits >= s.size).map((s) => s.id));

  // Клетки-«ореолы» вокруг потопленных кораблей противника: по правилам игры
  // рядом с кораблём не может быть другого корабля, поэтому эти клетки помечаются
  // как заведомо пустые (по ним не нужно стрелять).
  const haloOpp = new Set();
  for (const s of opp.ships) {
    if (!sunkOpp.has(s.id)) continue;
    for (const [x, y] of s.cells) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
            haloOpp.add(ny * SIZE + nx);
          }
        }
      }
    }
  }

  const yourBoard = [];
  const enemyBoard = [];
  for (let y = 0; y < SIZE; y++) {
    const ra = [];
    const rb = [];
    for (let x = 0; x < SIZE; x++) {
      const myShipId = me.grid[y][x];
      ra.push({
        ship: myShipId !== null,
        sunk: myShipId !== null && sunkMe.has(myShipId),
        shot: me.shots[y][x],
      });

      const oppShot = opp.shots[y][x];
      let shot = oppShot; // 'hit' | 'miss' | null
      if (oppShot === 'hit') {
        const oppShipId = opp.grid[y][x];
        if (oppShipId !== null && sunkOpp.has(oppShipId)) shot = 'sunk';
      } else if (oppShot === null && haloOpp.has(y * SIZE + x)) {
        shot = 'halo';
      }
      rb.push({ shot });
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

// Рассылает каждому игроку его персональное состояние партии.
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

// Обработчик входа в игру: переподключение по токену или подбор соперника.
function onJoin(ws, msg) {
  const token = msg.token || null;
  const authUsername = (msg.authToken && sessions.get(msg.authToken)) || null;
  // Игрок, прошедший авторизацию, выступает под своим логином.
  const name = authUsername || String(msg.name || 'Игрок').slice(0, MAX_NAME_LENGTH) || 'Игрок';

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
      if (authUsername) player.authUsername = authUsername;
      if (msg.name || authUsername) player.name = name;
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
    authUsername,
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

// Обработчик выстрела: валидирует ход, применяет его и рассылает результат.
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

  // Применяем выстрел к полю противника.
  const cell = opp.grid[y][x];
  let result;
  if (cell === null) {
    // Мимо: в клетке пусто.
    opp.shots[y][x] = 'miss';
    result = 'miss';
  } else {
    // Попадание: находим корабль по id и увеличиваем счётчик попаданий.
    opp.shots[y][x] = 'hit';
    const ship = opp.ships.find((s) => s.id === cell);
    ship.hits++;
    // Все палубы подбиты — корабль потоплен.
    result = ship.hits >= ship.size ? 'sunk' : 'hit';
  }

  // Формируем текст события для стрелявшего и для его соперника.
  let evShooter;
  let evOpp;
  if (result === 'miss') {
    evShooter = `Мимо (${coords(x, y)}).`;
    evOpp = `Противник промахнулся (${coords(x, y)}).`;
    game.turn = 1 - idx; // промах — ход переходит сопернику
  } else if (result === 'hit') {
    evShooter = `Попадание (${coords(x, y)})!`;
    evOpp = `В ваш корабль попали (${coords(x, y)})!`;
    // Попадание — ход сохраняется, тот же игрок стреляет ещё раз.
  } else {
    evShooter = `Корабль потоплен (${coords(x, y)})!`;
    evOpp = `Ваш корабль потоплен (${coords(x, y)})!`;
  }

  // Проверка победы: потоплены ли все корабли противника.
  if (opp.ships.every((s) => s.hits >= s.size)) {
    game.status = 'finished';
    game.winner = idx;
    recordResult(game); // записать результат в таблицы авторизованных игроков
  }

  game.updatedAt = Date.now();
  saveState();

  sendToPlayer(game, idx, { type: 'event', text: evShooter });
  sendToPlayer(game, 1 - idx, { type: 'event', text: evOpp });
  sendAllState(game);
  if (game.status === 'finished') broadcastResults(game); // обновить таблицы результатов
}

// Перезапускает партию: новая расстановка кораблей и случайный первый ход.
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

// Точка входа для всех сообщений клиента: разбираем JSON и маршрутизируем по типу.
function handleMessage(ws, raw) {
  let msg;
  // Некорректный JSON (например, обрыв на середине кадра) просто игнорируем.
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'join': return onJoin(ws, msg);
    case 'shoot': return onShoot(ws, msg);
    case 'restart': return onRestart(ws);
    case 'register': return onRegister(ws, msg);
    case 'login': return onLogin(ws, msg);
    case 'restore': return onRestore(ws, msg);
    case 'logout': return onLogout(ws, msg);
    case 'results': return onResults(ws, msg);
    default: return;
  }
}

// Вызывается при закрытии WebSocket-соединения.
function handleDisconnect(ws) {
  // Ищем, какому игроку принадлежал закрывшийся сокет.
  for (const g of Object.values(state.games)) {
    for (let i = 0; i < g.players.length; i++) {
      const p = g.players[i];
      if (p.ws === ws) {
        // Помечаем игрока отключённым, но НЕ удаляем из партии:
        // он сможет переподключиться по токену и продолжить игру.
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

// Битовые маски кадра WebSocket (RFC 6455)
const WS_FIN_BIT = 0x80;         // бит 7 байта 0: кадр финальный
const WS_MASK_BIT = 0x80;        // бит 7 байта 1: данные маскированы
const WS_OPCODE_MASK = 0x0f;     // младшие 4 бита байта 0 — тип кадра
const WS_LEN_MASK = 0x7f;        // младшие 7 бит байта 1 — короткая длина

// Типы кадров (opcode)
const WS_OP_TEXT = 0x1;          // текстовый кадр
const WS_OP_CLOSE = 0x8;         // закрытие соединения
const WS_OP_PING = 0x9;          // ping
const WS_OP_PONG = 0xA;          // pong

// Длины и границы кадра
const WS_LEN_16BIT = 126;        // маркер: длина в следующих 2 байтах
const WS_LEN_64BIT = 127;        // маркер: длина в следующих 8 байтах
const WS_BASE_HEADER_BYTES = 2;  // размер базового заголовка (2 байта)
const WS_LEN_16BIT_BYTES = 2;    // размер 16-битной расширенной длины
const WS_LEN_64BIT_BYTES = 8;    // размер 64-битной расширенной длины
const WS_MASK_KEY_BYTES = 4;     // размер ключа маски
const WS_MAX_16BIT = 65536;      // 2^16 — граница 16-битной длины

class WS {
  // Создаёт WebSocket-обёртку над TCP-сокетом и подписывается на его события.
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

  // Помечает соединение закрытым и вызывает onclose ровно один раз.
  _closed() {
    if (this._didClose) return;
    this._didClose = true;
    if (this.onclose) this.onclose();
  }

  // Добавляет пришедший кусок данных в буфер и пытается разобрать кадры.
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._parse();
  }

  // Разбирает накопленные байты на кадры. Кадр = заголовок (2 байта)
  // + опциональная расширенная длина + опциональный ключ маски + payload.
  _parse() {
    // Цикл, пока в буфере есть хотя бы базовый заголовок нового кадра.
    while (this.buffer.length >= WS_BASE_HEADER_BYTES) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & WS_OPCODE_MASK;
      const masked = (b1 & WS_MASK_BIT) !== 0;
      let len = b1 & WS_LEN_MASK;
      let offset = WS_BASE_HEADER_BYTES;

      // len 126/127 — маркеры, означающие, что реальная длина лежит
      // в следующих 2 или 8 байтах соответственно.
      if (len === WS_LEN_16BIT) {
        if (this.buffer.length < offset + WS_LEN_16BIT_BYTES) return;
        len = this.buffer.readUInt16BE(offset);
        offset += WS_LEN_16BIT_BYTES;
      } else if (len === WS_LEN_64BIT) {
        if (this.buffer.length < offset + WS_LEN_64BIT_BYTES) return;
        len = Number(this.buffer.readBigUInt64BE(offset));
        offset += WS_LEN_64BIT_BYTES;
      }

      // Если кадр маскирован (клиент обязан маскировать), читаем 4-байтный ключ.
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + WS_MASK_KEY_BYTES) return;
        mask = this.buffer.slice(offset, offset + WS_MASK_KEY_BYTES);
        offset += WS_MASK_KEY_BYTES;
      }

      if (this.buffer.length < offset + len) return;

      let payload = this.buffer.slice(offset, offset + len);
      if (masked && mask) {
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % WS_MASK_KEY_BYTES];
        payload = un;
      }
      this.buffer = this.buffer.slice(offset + len);

      if (opcode === WS_OP_TEXT) {
        // текстовый кадр (для наших сообщений фрагментация не используется)
        if (this.onmessage) this.onmessage(payload.toString('utf8'));
      } else if (opcode === WS_OP_CLOSE) {
        this._sendFrame(payload, WS_OP_CLOSE); // close
        this._closed();
        return;
      } else if (opcode === WS_OP_PING) {
        this._sendFrame(payload, WS_OP_PONG); // ping -> pong
      }
    }
  }

  // Собирает и отправляет кадр. Сервер шлёт кадры без маски, с битом FIN=1.
  _sendFrame(payload, opcode) {
    const len = payload.length;
    let header;
    if (len < WS_LEN_16BIT) {
      header = Buffer.from([WS_FIN_BIT | opcode, len]);
    } else if (len < WS_MAX_16BIT) {
      header = Buffer.alloc(WS_BASE_HEADER_BYTES + WS_LEN_16BIT_BYTES);
      header[0] = WS_FIN_BIT | opcode;
      header[1] = WS_LEN_16BIT;
      header.writeUInt16BE(len, WS_BASE_HEADER_BYTES);
    } else {
      header = Buffer.alloc(WS_BASE_HEADER_BYTES + WS_LEN_64BIT_BYTES);
      header[0] = WS_FIN_BIT | opcode;
      header[1] = WS_LEN_64BIT;
      header.writeBigUInt64BE(BigInt(len), WS_BASE_HEADER_BYTES);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  // Отправляет текстовое сообщение (кадр opcode = text).
  send(text) {
    this._sendFrame(Buffer.from(text, 'utf8'), WS_OP_TEXT);
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

// HTTP-обработчик: раздаёт статические файлы из public/ (с защитой от выхода за каталог).
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

// Обработчик WebSocket-рукопожатия: отвечаем «101» и переключаемся на WebSocket.
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
loadUsers();
server.listen(PORT, () => {
  console.log(`Морской бой запущен: http://localhost:${PORT}`);
  console.log('Откройте адрес в двух вкладках, чтобы сыграть вдвоём.');
});
