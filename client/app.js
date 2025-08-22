// client/app.js
import { textToUtf8Bytes, utf8BytesToText, bytesToBitString, packetize, depacketize, findMissingAndBad, checksumUint8 } from './codec/text.js';
import { joinRoom, onState, onData, onRelay, sendP2P, sendServerLog } from './webrtc.js';

// ==== 要素参照 ====
const joinBtn = document.getElementById('joinBtn');
const roomIdEl = document.getElementById('roomId');
const connState = document.getElementById('connState');
const delay = document.getElementById('delay');
const delayOut = document.getElementById('delayOut');
const loss = document.getElementById('loss');
const lossOut = document.getElementById('lossOut');
const textEl = document.getElementById('text');
const sendBtn = document.getElementById('sendBtn');

const textView = document.getElementById('textView');
const bitsView = document.getElementById('bitsView'); // ← 修正済み
const pktGen = document.getElementById('pktGen');
const road = document.getElementById('road');
const arrival = document.getElementById('arrival');
const board = document.getElementById('board');
const status = document.getElementById('status');

// ==== 状態 ====
let lastPackets = [];
let sendIndex = 0;
let boardSlots = 0;
let bySeq = new Map();
let arrived = []; // 到着順可視化
let currentRecvRid = null; // 受信中メッセージのID
let currentSendRid = null; // 送信中メッセージのID（progressフィルタ用）

// ユーティリティ
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (base) => Math.floor(Math.random() * (base * 0.5));

// === 表示ヘルパー（payload可視化用） ===
function bytesFromB64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function bytesToHex(u8) {
  return Array.from(u8, b => b.toString(16).padStart(2, '0')).join(' ');
}
function renderPktCard(p) {
  const d = document.createElement('div'); d.className = 'pkt';
  const hdr = document.createElement('div'); hdr.className = 'hdr';
  hdr.textContent = `seq ${p.seq}/${p.total} · len ${p.payloadLen} · 中身チェック=${p.checksum}`;
  const pay = document.createElement('div'); pay.className = 'pay';
  const bytes = bytesFromB64(p.payload);
  const text = new TextDecoder().decode(bytes); // 部分文字は�で表示
  const textDiv = document.createElement('div'); textDiv.className = 't'; textDiv.textContent = text;
  const hexDiv = document.createElement('div'); hexDiv.className = 'hex'; hexDiv.title = 'バイト列(16進)';
  hexDiv.textContent = bytesToHex(bytes);
  pay.append(textDiv, hexDiv);
  d.append(hdr, pay);
  return d;
}

// ==== レイアウト（画面高にフィット） ====
function applyViewportVars() {
  const top = document.querySelector('.topbar');
  const topH = top ? top.offsetHeight + 18 /* .viz の margin-top */ : 120;
  const vhPx = (window.visualViewport?.height || window.innerHeight);
  document.documentElement.style.setProperty('--vh', `${vhPx * 0.01}px`);
  document.documentElement.style.setProperty('--topbarH', `${topH}px`);
}

// 画面に全体を収めるための縮尺（--ui-scale）を自動調整
function fitToScreen() {
  if (window.matchMedia('(max-width: 768px)').matches) {  // スマホでは縮小しない
    document.documentElement.style.setProperty('--ui-scale', '1');
    return;
  }
  const top = document.querySelector('.topbar');
  const viz = document.querySelector('.viz');
  if (!top || !viz) return;
  const vh = (window.visualViewport?.height || window.innerHeight);
  const need = top.offsetHeight + 16 /*余白*/ + viz.scrollHeight;
  const scale = Math.min(1, Math.max(0.65, (vh - 4) / need)); // 0.65〜1.00
  document.documentElement.style.setProperty('--ui-scale', scale.toFixed(3));
}

// 2つまとめて呼ぶ関数に差し替え
const relayout = () => { applyViewportVars(); fitToScreen(); };
window.addEventListener('resize', relayout);
window.addEventListener('orientationchange', relayout);
window.visualViewport && window.visualViewport.addEventListener('resize', relayout);
document.addEventListener('DOMContentLoaded', relayout);
relayout();

// アクセシビリティ: 値表示
const updateSliders = () => {
  delayOut.textContent = `${delay.value}ms`;
  lossOut.textContent = `${loss.value}%`;
};
updateSliders();
[delay, loss].forEach(el => el.addEventListener('input', updateSliders));

// ルーム入室
joinBtn.addEventListener('click', async () => {
  joinBtn.disabled = true;
  await joinRoom(roomIdEl.value.trim() || 'demo');
});

onState((s) => { connState.textContent = s; });

// P2P中継の補助（NACK/スライダ変更ログ等）
onRelay((msg) => {
  if (msg.type === 'slider') {
    // 受信のみログ用途（今回はUI反映なし）
  }
});

// 受信処理
onData(async (obj) => {
  if (obj.t === 'pkt') {
    // --- 新メッセージ開始かどうかを判定（rid 変化 or ボード未初期化/総数変化） ---
    const isNewByRid   = !!(obj.rid && obj.rid !== currentRecvRid);
    const isNewByBoard = (board.children.length === 0 || boardSlots !== (obj.total || 0));
    if (isNewByRid || isNewByBoard) {
      if (isNewByRid) currentRecvRid = obj.rid;
      resetViz(obj.total || 1);
      // 受信側の上段3欄を必ずクリア（rid の有無に関わらず）
      document.getElementById('textView').textContent = '（受信中…）';
      document.getElementById('bitsView').textContent = '';
      document.getElementById('pktGen').innerHTML = '';
    }
    onPacketArrive(obj);
  } else if (obj.t === 'nack') {
    markReDelivery();
    const need = lastPackets.filter(p => obj.seqs.includes(p.seq));
    for (const p of need) sendWithSimulatedNetwork(p, true);
  } else if (obj.t === 'progress') {
    // 自分が送っているメッセージの progress 以外は無視
    if (obj.rid && currentSendRid && obj.rid !== currentSendRid) return;
    const s = obj.status || {};
    if (board.children.length === 0 || boardSlots !== (s.total || 0)) {
      resetViz(s.total || 1);
    }
    // いったん全枠を missing に戻す
    for (let i = 1; i <= (s.total || 0); i++) {
      const cell = board.querySelector(`.slot[data-seq="${i}"]`);
      if (cell) cell.className = 'slot missing';
    }
    // ok / bad を反映
    (s.ok || []).forEach(seq => {
      const cell = board.querySelector(`.slot[data-seq="${seq}"]`);
      if (cell) cell.classList.add('ok') , cell.classList.remove('missing');
    });
    (s.bad || []).forEach(seq => {
      const cell = board.querySelector(`.slot[data-seq="${seq}"]`);
      if (cell) cell.classList.add('bad') , cell.classList.remove('missing');
    });
    // ステータス表示
    if ((s.missing || []).length === 0 && (s.bad || []).length === 0 && (s.total || 0) > 0) {
      status.className = 'ok';
      status.textContent = 'ぜんぶ届いたよ！ ✅';
    } else {
      status.className = '';
      status.textContent = `未達/要再配達: 欠落 ${ (s.missing||[]).join(',') || 'なし' }, 中身チェック⚠️ ${ (s.bad||[]).join(',') || 'なし' }`;
    }
  }
});

function markReDelivery() {
  status.textContent = '再配達🔁 中…';
  // 送信側は完了を観測できないので、一定時間後に自動クリア（受信側は完了時に ok 表示で上書き）
  const token = Symbol();
  markReDelivery._token = token;
  setTimeout(() => {
    if (markReDelivery._token === token && !status.classList.contains('ok')) {
      status.textContent = '';
    }
  }, 2000);
}

function resetViz(total) {
  arrival.innerHTML = '';
  board.innerHTML = '';
  status.className = '';
  status.textContent = '';
  arrived = [];
  bySeq = new Map();
  boardSlots = total;
  for (let i = 1; i <= total; i++) {
    const d = document.createElement('div');
    d.className = 'slot missing';
    d.dataset.seq = String(i);
    d.textContent = i;
    board.appendChild(d);
  }
  board.scrollTop = 0;
}

function renderArrival(pkt) {
  const li = document.createElement('li');
  li.textContent = `#${pkt.seq} len=${pkt.payloadLen}`;

  // すでに同 seq が到着済みなら重複（視覚弱め：任意）
  if (bySeq?.has && bySeq.has(pkt.seq)) {
    li.classList.add('dup');
    li.title = '重複到着（最初の1つを採用）';
  }

  // チェックサム検査：不一致なら赤表示
  try {
    const bytes = Uint8Array.from(atob(pkt.payload), c => c.charCodeAt(0));
    const ok = checksumUint8(bytes) === pkt.checksum;
    if (!ok) {
      li.classList.add('bad');
      li.title = '中身チェック不一致（自動で再配達を依頼します）';
    }
  } catch { /* payload パース不可時は素通し */ }

  arrival.appendChild(li);
  arrival.scrollTop = arrival.scrollHeight;
}


function renderBoard() {
  for (const d of board.querySelectorAll('.slot')) {
    d.className = 'slot missing';
  }
  for (const [seq, p] of bySeq.entries()) {
    const cell = board.querySelector(`.slot[data-seq="${seq}"]`);
    if (!cell) continue;
    const ok = (() => {
      const bytes = Uint8Array.from(atob(p.payload), c => c.charCodeAt(0));
      const sum = bytes.reduce((a,b) => (a + b) & 0xff, 0);
      return sum === p.checksum;
    })();
    cell.textContent = seq;
    cell.classList.remove('missing');
    cell.classList.add(ok ? 'ok' : 'bad');
  }
}

function checkCompletion() {
  const { total, missing, bad } = findMissingAndBad([...bySeq.values()]);
  for (let s = 1; s <= total; s++) {
    const cell = board.querySelector(`.slot[data-seq="${s}"]`);
    if (!cell) continue;
    if (!bySeq.has(s)) cell.className = 'slot missing';
  }
  if (missing.length || bad.length) {
    if (total > 0) {
      const seqs = [...new Set([...missing, ...bad])];
      sendP2P({ t: 'nack', seqs });
      // 管理ログにも反映（relay:nack が /admin/logs に出る）
      sendServerLog('nack', { seqs });
    }
    status.className = '';
    status.textContent = `未達/要再配達: 欠落 ${missing.join(',') || 'なし'}, 中身チェック⚠️ ${bad.join(',') || 'なし'}`;
    return false;
  }
  status.className = 'ok';
  status.textContent = 'ぜんぶ届いたよ！ ✅';
  const bytes = depacketize([...bySeq.values()]);
  const text = utf8BytesToText(bytes);
  document.getElementById('textView').textContent = text;
  // 受信側ビット列の確定表示（長文は先頭のみ＋titleに全量）
  const bits = bytesToBitString(bytes).replace(/(.{8})/g, '$1 ').trim();
  const limit = 8 * 48;
  const bv = document.getElementById('bitsView');
  if (bits.length > limit) { bv.textContent = bits.slice(0, limit) + ' …（省略）'; bv.title = bits; }
  else { bv.textContent = bits; bv.removeAttribute('title'); }
  return true;
}

function onPacketArrive(pkt) {
  arrived.push(pkt);
  renderArrival(pkt);

  if (!bySeq.has(pkt.seq)) bySeq.set(pkt.seq, pkt);
  renderBoard();
  checkCompletion();

  const { total, missing, bad, bySeq: map } = findMissingAndBad([...bySeq.values()]);
  const ok = [...map.keys()].filter(s => !bad.includes(s));
  // 受信中の rid（pkt.rid が無ければ currentRecvRid）を必ず同報
  sendP2P({ t: 'progress', rid: pkt.rid || currentRecvRid, status: { total, ok, bad, missing } });
  // client/app.js の onPacketArrive の末尾に追加
  pktGen.appendChild(renderPktCard(pkt));

}

// 疑似ネットワーク適用して送信
function sendWithSimulatedNetwork(pkt, isRetransmit = false) {
  const base = Number(delay.value);
  const d = base + jitter(base);
  const lost = Math.random() < Number(loss.value) / 100;

  const car = document.createElement('div');
  car.className = 'truck';
  car.textContent = `📦#${pkt.seq}`;
  road.appendChild(car);

  const dist = road.clientWidth + 120;
  car.animate([
    { transform: 'translateX(0px)', offset: 0 },
    { transform: `translateX(${dist}px)`, offset: 1 }
  ], { duration: Math.max(2000, d), easing: 'ease-in-out' });

  setTimeout(() => {
    if (lost) {
      car.classList.add('lost');
      return; // 未達: 送信しない
    }
    sendP2P(pkt); // DataChannelへ（JSON）
  }, d);
}

async function runVisualization(text) {
  // ① 文字
  textView.textContent = text;
  await sleep(1000);

  // ② ビット列
  const bytes = textToUtf8Bytes(text);
  const bits = bytesToBitString(bytes);
  const prettyBits = bits.replace(/(.{8})/g, '$1 ').trim();
  // 長文は自動折りたたみ（仕様準拠）。全量は title に保持
  if (prettyBits.length > 8 * 48) { // 目安: 48バイト分
    bitsView.textContent = prettyBits.slice(0, 8 * 48) + ' …（省略）';
    bitsView.title = prettyBits;
  } else {
    bitsView.textContent = prettyBits;
    bitsView.removeAttribute('title');
  }
  await sleep(1000);

  // ③ パケット化
  const rid = Date.now() + '-' + Math.random().toString(36).slice(2);
  currentSendRid = rid;
  lastPackets = packetize(bytes, 12).map(p => ({ ...p, rid }));
  pktGen.innerHTML = '';
  for (const p of lastPackets) {
    pktGen.appendChild(renderPktCard(p));
  }
  await sleep(1000);

  // ④ 配達レーン初期化
  road.innerHTML = '<div class="path"></div>';

  // ⑤ 並べ直しボード準備
  resetViz(lastPackets[0]?.total || 1);

  // 疑似ネットワーク送信
  sendIndex = 0;
  for (const p of lastPackets) {
    sendWithSimulatedNetwork(p);
    await sleep(120);
  }
}

sendBtn.addEventListener('click', async () => {
  const text = textEl.value.trim();
  if (!text) return;
  await runVisualization(text);
});

// （備考）スライダ変更をサーバログへ送りたければ、/ws経由の中継を追加してもOK
