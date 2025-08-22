// client/webrtc.js
const STUN = { urls: 'stun:stun.l.google.com:19302' };
let pc, dc, ws, roomId, peerId;

const listeners = new Map();
const on = (ev, fn) => listeners.set(ev, fn);
const emit = (ev, ...a) => listeners.get(ev)?.(...a);

export async function joinRoom(id) {
  roomId = id;
  ws = new WebSocket(`${location.origin.replace('http','ws')}/ws`);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', roomId })));
  ws.addEventListener('message', async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'room-full') {
      emit('state', 'ルーム満員'); return;
    }
    if (msg.type === 'joined') {
      peerId = msg.peerId; emit('state', `入室: あなた=${peerId}`);
      await ensurePeer(msg.peers.length === 2);
      return;
    }
    if (msg.type === 'peer-joined') {
      emit('state', `相手が入りました`);
      await ensurePeer(true);
      return;
    }
    if (msg.type === 'peer-left') {
      emit('state', '相手が退出');
      return;
    }
    if (msg.type === 'signal') {
      await handleSignal(msg.data);
      return;
    }
    if (msg.type === 'nack' || msg.type === 'slider' || msg.type === 'dc-status') {
      emit('relay', msg);
    }
  });
}

async function ensurePeer(shouldOffer) {
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers: [STUN] });
  window.__pc = pc;

  const opts = { ordered: false, maxRetransmits: 0 };
  if (shouldOffer) {
    dc = pc.createDataChannel('data', opts);
    setupDataChannel(dc);
    window.__dc = dc;
  } else {
    pc.ondatachannel = (e) => { dc = e.channel; setupDataChannel(dc); };
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ kind: 'ice', candidate: e.candidate });
  };

  if (shouldOffer) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ kind: 'offer', sdp: offer });
  }
}

async function handleSignal(data) {
  if (data.kind === 'offer') {
    await ensurePeer(false);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ kind: 'answer', sdp: answer });
  } else if (data.kind === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.kind === 'ice') {
    try { await pc.addIceCandidate(data.candidate); } catch {}
  }
}

function sendSignal(data) {
  ws?.send(JSON.stringify({ type: 'signal', data }));
}

function setupDataChannel(ch) {
  ch.binaryType = 'arraybuffer';
  ch.onopen = () => { emit('state', 'P2P接続'); 
    ws?.send(JSON.stringify({ type: 'dc-status', data: { state: 'open' } }));
  };
  ch.onclose = () => { emit('state', 'P2P切断'); 
    ws?.send(JSON.stringify({ type: 'dc-status', data: { state: 'closed' } }));
  };
  ch.onerror = (e) => {
    ws?.send(JSON.stringify({ type: 'dc-status', data: { state: 'error', message: String(e) } }));
  };
  ch.onmessage = (e) => {
    try { emit('data', JSON.parse(e.data)); }
    catch { /* JSONのみ */ }
  };
}

export function sendP2P(obj) {
  if (dc?.readyState === 'open') {
    dc.send(JSON.stringify(obj));
  }
}

export function onState(fn) { on('state', fn); }
export function onData(fn) { on('data', fn); }
export function onRelay(fn) { on('relay', fn); }
// 管理ログ用: 任意のイベントをWS経由でサーバへ
export function sendServerLog(type, data) {
  try { ws?.send(JSON.stringify({ type, data })); } catch {}
}
