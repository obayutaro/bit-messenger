// server/rooms.js
import { randomUUID } from 'crypto';

export class RoomManager {
  constructor(logger) {
    this.logger = logger;
    this.rooms = new Map(); // roomId -> Map(peerId, ws)
  }

  join(ws, roomId) {
    const peerId = randomUUID();
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.rooms.set(roomId, room);
    }
    if (room.size >= 2) {
      ws.send(JSON.stringify({ type: 'room-full' }));
      ws.close(1008, 'room full');
      this.logger.warn({ roomId, peerId: 'n/a', event: 'room-full' });
      return null;
    }
    room.set(peerId, ws);
    ws._roomId = roomId; // 片付け用
    ws._peerId = peerId;

    this.logger.info({ roomId, peerId, event: 'peer-join' });

    const peers = [...room.keys()];
    ws.send(JSON.stringify({ type: 'joined', peerId, peers }));

    for (const [otherId, otherWs] of room) {
      if (otherId !== peerId) {
        otherWs.send(JSON.stringify({ type: 'peer-joined', peerId }));
      }
    }

    ws.on('close', () => this._leave(ws, 'close'));
    ws.on('error', () => this._leave(ws, 'error'));
    return peerId;
  }

  _leave(ws, reason = 'leave') {
    const roomId = ws._roomId; const peerId = ws._peerId;
    if (!roomId || !peerId) return;
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.delete(peerId);
    this.logger.info({ roomId, peerId, event: 'peer-leave', detail: { reason } });
    for (const [otherId, otherWs] of room) {
      otherWs.send(JSON.stringify({ type: 'peer-left', peerId }));
    }
    if (room.size === 0) this.rooms.delete(roomId);
  }

  relay(ws, msg) {
    const roomId = ws._roomId; const from = ws._peerId;
    if (!roomId || !from) return;
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const [peerId, peerWs] of room) {
      if (peerId !== from && peerWs.readyState === 1) {
        peerWs.send(JSON.stringify({ ...msg, from }));
      }
    }
  }
}
