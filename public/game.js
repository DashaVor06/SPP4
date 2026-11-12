'use strict';

/* Клиент «Морского боя»: чистый JavaScript, без фреймворков. */

const LETTERS = 'АБВГДЕЖИК'.split('');

let ws = null;
// Токен храним в sessionStorage: у каждой вкладки он свой (иначе две вкладки
// с одним токеном из localStorage «дерутся» за одного игрока и бесконечно
// переподключаются). При этом sessionStorage переживает обновление страницы (F5),
// поэтому восстановление после обрыва связи в пределах вкладки работает.
let token = sessionStorage.getItem('bs_token') || null;
let state = null;
let myIndex = 0;
let reconnectTimer = null;

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

nameInput.value = localStorage.getItem('bs_name') || '';

function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    setConnStatus('Подключено');
    send({
      type: 'join',
      name: nameInput.value.trim() || 'Игрок',
      token: token,
    });
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    handle(msg);
  };

  ws.onclose = () => {
    setConnStatus('Соединение потеряно. Переподключение…');
    reconnectTimer = setTimeout(connect, 2000);
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

function handle(msg) {
  switch (msg.type) {
    case 'joined':
      token = msg.token;
      sessionStorage.setItem('bs_token', token);
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

  renderBoard(yourBoardEl, state.yourBoard, 'your', false, myTurn);
  renderBoard(enemyBoardEl, state.enemyBoard, 'enemy', playing && myTurn, myTurn);
}

function renderBoard(container, cells, kind, clickable, myTurn) {
  container.innerHTML = '';
  container.classList.toggle('clickable', clickable);

  // пустая угловая клетка + буквы столбцов
  const corner = document.createElement('div');
  corner.className = 'label';
  container.appendChild(corner);
  for (let x = 0; x < 10; x++) {
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = LETTERS[x];
    container.appendChild(l);
  }

  for (let y = 0; y < 10; y++) {
    const nl = document.createElement('div');
    nl.className = 'label';
    nl.textContent = y + 1;
    container.appendChild(nl);

    for (let x = 0; x < 10; x++) {
      const cell = cells[y][x];
      const el = document.createElement('div');
      el.className = 'cell';

      if (kind === 'your') {
        if (cell.ship) el.classList.add('ship');
        if (cell.shot === 'hit') el.classList.add('hit');
        else if (cell.shot === 'miss') el.classList.add('miss');
      } else {
        if (cell.shot === 'hit') el.classList.add('hit');
        else if (cell.shot === 'miss') el.classList.add('miss');
        else if (clickable) {
          el.addEventListener('click', () => shoot(x, y));
        }
      }

      container.appendChild(el);
    }
  }
}

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

connectBtn.addEventListener('click', () => {
  localStorage.setItem('bs_name', nameInput.value.trim() || 'Игрок');
  connect();
});

restartBtn.addEventListener('click', () => {
  send({ type: 'restart' });
});

// Автоподключение, если у пользователя уже был токен.
if (token) connect();
