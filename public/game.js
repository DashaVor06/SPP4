'use strict';

/* Клиент «Морского боя»: чистый JavaScript, без фреймворков. */

const LETTERS = 'АБВГДЕЖИК'.split('');
const BOARD_SIZE = 10;           // размер игрового поля (10×10)
const RECONNECT_DELAY_MS = 2000; // задержка перед авто-переподключением
const MAX_RESULTS_SHOWN = 20;    // сколько последних записей показывать

let ws = null;
// Игровой токен — в sessionStorage (свой у каждой вкладки).
let gameToken = sessionStorage.getItem('bs_token') || null;
// Токен авторизации и логин — в localStorage (общие для всех вкладок).
let authToken = localStorage.getItem('bs_auth') || null;
let authUser = localStorage.getItem('bs_user') || null;
let state = null;
let myIndex = 0;
let reconnectTimer = null;
let pendingJoin = false;
let restoringSession = false;

const $ = (id) => document.getElementById(id);
const nameInput = $('nameInput');
const connectBtn = $('connectBtn');
const connectPanel = $('connectPanel');
const gamePanel = $('gamePanel');
const connStatus = $('connStatus');
const gameStatus = $('gameStatus');
const restartBtn = $('restartBtn');
const yourBoardEl = $('yourBoard');
const enemyBoardEl = $('enemyBoard');
const yourTitle = $('yourTitle');
const enemyTitle = $('enemyTitle');
const yourShipsEl = $('yourShips');
const enemyShipsEl = $('enemyShips');
const logEl = $('log');

const authForm = $('authForm');
const authInfo = $('authInfo');
const authUserEl = $('authUser');
const authStatusEl = $('authStatus');
const usernameInput = $('usernameInput');
const passwordInput = $('passwordInput');
const loginBtn = $('loginBtn');
const registerBtn = $('registerBtn');
const logoutBtn = $('logoutBtn');
const resultsPanel = $('resultsPanel');
const resultsSummary = $('resultsSummary');
const resultsTableBody = document.querySelector('#resultsTable tbody');
const resultsEmpty = $('resultsEmpty');

nameInput.value = localStorage.getItem('bs_name') || '';

function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    setConnStatus('Подключено');
    if (authToken) {
      restoringSession = true;
      send({ type: 'restore', authToken }); // восстановить сессию и результаты
    }
    if (pendingJoin || gameToken) joinGame(); // автоподключение к игре
    updateAuthUI();
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    handle(msg);
  };

  ws.onclose = () => {
    setConnStatus('Соединение потеряно. Переподключение…');
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  };

  ws.onerror = () => {};
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setConnStatus(text) {
  connStatus.textContent = text;
  connStatus.classList.toggle('muted', false);
}

function setAuthStatus(text) {
  authStatusEl.textContent = text;
}

function joinGame() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    pendingJoin = false;
    const name = authUser || nameInput.value.trim() || 'Игрок';
    localStorage.setItem('bs_name', name);
    send({ type: 'join', name, token: gameToken, authToken });
  } else {
    pendingJoin = true;
  }
}

function updateAuthUI() {
  const loggedIn = !!authUser;
  authForm.classList.toggle('hidden', loggedIn);
  authInfo.classList.toggle('hidden', !loggedIn);
  resultsPanel.classList.toggle('hidden', !loggedIn);
  authUserEl.textContent = authUser || '';
  if (loggedIn) {
    nameInput.value = authUser;
    nameInput.disabled = true; // авторизованный игрок выступает под логином
  } else {
    nameInput.disabled = false;
  }
}

// Заполняет таблицу результатов: сводка (всего/побед/поражений) + список партий.
function renderResults(results) {
  resultsTableBody.innerHTML = '';
  // Сыгранных партий ещё нет — показываем заглушку.
  if (!results || results.length === 0) {
    resultsSummary.innerHTML = '';
    resultsEmpty.classList.remove('hidden');
    return;
  }
  resultsEmpty.classList.add('hidden');
  const wins = results.filter((r) => r.result === 'win').length;
  const losses = results.length - wins;
  resultsSummary.innerHTML =
    `Всего партий: <b>${results.length}</b> · Побед: <b>${wins}</b> · Поражений: <b>${losses}</b>`;

  // Новые записи показываем сверху (reverse) и ограничиваем количество.
  results.slice().reverse().slice(0, MAX_RESULTS_SHOWN).forEach((r, i) => {
    const tr = document.createElement('tr');
    const tdN = document.createElement('td');
    tdN.textContent = i + 1;
    const tdD = document.createElement('td');
    tdD.textContent = new Date(r.date).toLocaleString('ru-RU');
    const tdO = document.createElement('td');
    tdO.textContent = r.opponent;
    const tdR = document.createElement('td');
    tdR.textContent = r.result === 'win' ? 'Победа' : 'Поражение';
    tdR.className = r.result === 'win' ? 'resWin' : 'resLoss';
    tr.append(tdN, tdD, tdO, tdR);
    resultsTableBody.appendChild(tr);
  });
}

function handle(msg) {
  switch (msg.type) {
    case 'auth':
      if (msg.ok) {
        authToken = msg.authToken;
        authUser = msg.username;
        localStorage.setItem('bs_auth', authToken);
        localStorage.setItem('bs_user', authUser);
        nameInput.value = authUser;
        setAuthStatus('');
        renderResults(msg.results || []);
      } else {
        if (restoringSession) {
          // сессия истекла — показываем форму входа
          authToken = null;
          authUser = null;
          localStorage.removeItem('bs_auth');
          localStorage.removeItem('bs_user');
        }
        setAuthStatus(msg.error || 'Ошибка авторизации.');
      }
      restoringSession = false;
      updateAuthUI();
      break;

    case 'results':
      renderResults(msg.results || []);
      break;

    case 'joined':
      gameToken = msg.token;
      sessionStorage.setItem('bs_token', gameToken);
      break;

    case 'waiting':
      gameStatus.textContent = 'Ожидание второго игрока…';
      gamePanel.classList.remove('hidden');
      addLog('Вы в очереди. Откройте игру во второй вкладке/браузере.');
      break;

    case 'state':
      state = msg;
      myIndex = msg.yourIndex;
      gamePanel.classList.remove('hidden');
      render();
      break;

    case 'event':
      addLog(msg.text);
      break;

    case 'error':
      addLog('⚠ ' + msg.message);
      break;
  }
}

// Перерисовывает весь интерфейс по последнему состоянию, присланному сервером.
function render() {
  if (!state) return;

  const playing = state.status === 'playing';
  const finished = state.status === 'finished';
  const myTurn = playing && state.turn === myIndex;

  yourTitle.textContent = state.yourName;
  enemyTitle.textContent = state.opponentName + (state.opponentConnected ? '' : ' (офлайн)');
  yourShipsEl.textContent = state.yourShipsLeft;
  enemyShipsEl.textContent = state.opponentShipsLeft;

  if (finished) {
    const won = state.winner === myIndex;
    gameStatus.textContent = won ? '🏆 Победа!' : '💀 Поражение';
    addLog(won ? 'Вы победили!' : 'Вы проиграли.', true);
    restartBtn.classList.remove('hidden');
  } else if (playing) {
    gameStatus.textContent = myTurn ? 'Ваш ход' : 'Ход противника';
    restartBtn.classList.add('hidden');
  } else {
    gameStatus.textContent = 'Ожидание второго игрока…';
    restartBtn.classList.add('hidden');
  }

  renderBoard(yourBoardEl, state.yourBoard, 'your', false);
  renderBoard(enemyBoardEl, state.enemyBoard, 'enemy', playing && myTurn);
}

// Рисует одно поле 10×10 (своё или противника) в заданный контейнер.
// kind: 'your' — своё поле (корабли видны), 'enemy' — поле противника (корабли скрыты).
function renderBoard(container, cells, kind, clickable) {
  // Очищаем контейнер и включаем/выключаем режим кликабельности клеток.
  container.innerHTML = '';
  container.classList.toggle('clickable', clickable);

  // Верхняя строка: пустой угол + буквы столбцов (А–К).
  const corner = document.createElement('div');
  corner.className = 'label';
  container.appendChild(corner);
  for (let x = 0; x < BOARD_SIZE; x++) {
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = LETTERS[x];
    container.appendChild(l);
  }

  for (let y = 0; y < BOARD_SIZE; y++) {
    const nl = document.createElement('div');
    nl.className = 'label';
    nl.textContent = y + 1;
    container.appendChild(nl);

    for (let x = 0; x < BOARD_SIZE; x++) {
      const cell = cells[y][x];
      const el = document.createElement('div');
      el.className = 'cell';

      // Назначаем CSS-классы в зависимости от состояния клетки.
      if (kind === 'your') {
        if (cell.sunk) {
          el.classList.add('sunk'); // полностью потопленный корабль
        } else if (cell.ship) {
          el.classList.add('ship'); // живой корабль
          if (cell.shot === 'hit') el.classList.add('hit'); // подбитая палуба
        }
        if (!cell.ship && cell.shot === 'miss') el.classList.add('miss');
      } else {
        if (cell.shot === 'sunk') el.classList.add('sunk');
        else if (cell.shot === 'hit') el.classList.add('hit');
        else if (cell.shot === 'miss') el.classList.add('miss');
        else if (cell.shot === 'halo') el.classList.add('halo');
        else if (clickable) {
          el.addEventListener('click', () => shoot(x, y));
        }
      }

      container.appendChild(el);
    }
  }
}

// Отправляет выстрел; корректность (чей ход, занята ли клетка) проверит сервер.
function shoot(x, y) {
  if (!state || state.status !== 'playing' || state.turn !== myIndex) return;
  send({ type: 'shoot', x, y });
}

function addLog(text, win) {
  const div = document.createElement('div');
  if (win) div.className = 'win';
  div.textContent = '• ' + text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

connectBtn.addEventListener('click', joinGame);

restartBtn.addEventListener('click', () => {
  send({ type: 'restart' });
});

loginBtn.addEventListener('click', () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) { setAuthStatus('Введите логин и пароль.'); return; }
  send({ type: 'login', username, password });
});

registerBtn.addEventListener('click', () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) { setAuthStatus('Введите логин и пароль.'); return; }
  send({ type: 'register', username, password });
});

logoutBtn.addEventListener('click', () => {
  if (authToken) send({ type: 'logout', authToken });
  authToken = null;
  authUser = null;
  localStorage.removeItem('bs_auth');
  localStorage.removeItem('bs_user');
  updateAuthUI();
});

// Сразу отражаем сохранённый вход (если есть), затем подключаем WebSocket.
updateAuthUI();
connect();
