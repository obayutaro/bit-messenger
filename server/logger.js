// server/logger.js
import { EventEmitter } from 'events';

export class Logger extends EventEmitter {
  constructor({ capacity = 2000 } = {}) {
    super();
    this.capacity = capacity;
    this.buffer = [];
  }

  log(level, { roomId = '-', peerId = '-', event = '-', detail = {} } = {}) {
    const ts = new Date().toISOString();
    // プライバシ: 本文は既定でマスク
    const maskedDetail = this._maskDetail(detail);
    const entry = { ts, level, roomId, peerId, event, detail: maskedDetail };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.emit('log', entry);
    // 標準出力へ1行1JSON
    process.stdout.write(JSON.stringify(entry) + '\n');
  }

  info(ctx) { this.log('info', ctx); }
  warn(ctx) { this.log('warn', ctx); }
  error(ctx) { this.log('error', ctx); }

  _maskDetail(detail) {
    const d = { ...detail };
    if (typeof d.message === 'string') {
      d.messageMasked = true;
      d.messageLength = d.message.length;
      delete d.message; // 本文は表示しない
    }
    return d;
  }

  // SSE購読: 既存バッファを払い出し、その後はpush
  sseSubscribe(res) {
    for (const entry of this.buffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    const onLog = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    this.on('log', onLog);
    return () => this.off('log', onLog);
  }
}
