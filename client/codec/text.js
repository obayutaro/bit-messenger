// client/codec/text.js
export function textToUtf8Bytes(str) {
  return new TextEncoder().encode(str);
}
export function utf8BytesToText(bytes) {
  return new TextDecoder().decode(bytes);
}
export function bytesToBitString(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(2).padStart(8, '0');
  return s;
}
export function checksumUint8(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return sum;
}
// パケット構造（簡易JSON・学習用）
// { t:'pkt', seq, total, payloadLen, checksum, payload (base64) }
export function packetize(bytes, chunkSize = 12) {
  const total = Math.ceil(bytes.length / chunkSize) || 1;
  const packets = [];
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const slice = bytes.slice(start, start + chunkSize);
    const checksum = checksumUint8(slice);
    packets.push({
      t: 'pkt',
      seq: i + 1,
      total,
      payloadLen: slice.length,
      checksum,
      payload: btoa(String.fromCharCode(...slice)),
    });
  }
  return packets;
}

export function depacketize(packets) {
  const arr = packets.slice().sort((a, b) => a.seq - b.seq);
  const bytes = [];
  for (const p of arr) {
    const payloadBytes = Uint8Array.from(atob(p.payload), c => c.charCodeAt(0));
    bytes.push(...payloadBytes);
  }
  return new Uint8Array(bytes);
}

export function findMissingAndBad(packets) {
  if (packets.length === 0) return { total: 0, missing: [], bad: [] };
  // すべての total と seq を見て最大をとる（順序/残留の影響を受けにくくする）
  const maxSeq = Math.max(...packets.map(p => p.seq || 0));
  const maxTotal = Math.max(...packets.map(p => p.total || 0), 0);
  const total = Math.max(maxSeq, maxTotal);
  const bySeq = new Map();
  const bad = [];
  for (const p of packets) {
    const payloadBytes = Uint8Array.from(atob(p.payload), c => c.charCodeAt(0));
    const ok = checksumUint8(payloadBytes) === p.checksum;
    if (!ok) bad.push(p.seq);
    if (!bySeq.has(p.seq)) bySeq.set(p.seq, p); // 重複は最初を採用
  }
  const missing = [];
  for (let s = 1; s <= total; s++) if (!bySeq.has(s)) missing.push(s);
  return { total, missing, bad, bySeq };
}
