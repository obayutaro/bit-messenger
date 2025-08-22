(() => {
  const rows = document.getElementById('rows');
  const level = document.getElementById('level');
  const room = document.getElementById('room');
  const peer = document.getElementById('peer');
  const event = document.getElementById('event');
  const kw = document.getElementById('kw');

  const es = new EventSource('/admin/logs/stream');
  const buf = [];

  const render = () => {
    const lv = level.value.trim().toLowerCase();
    const rm = room.value.trim();
    const pr = peer.value.trim();
    const ev = event.value.trim();
    const k = kw.value.trim().toLowerCase();

    rows.innerHTML = '';
    for (let i = buf.length - 1; i >= 0; i--) {
      const x = buf[i];
      if (lv && x.level !== lv) continue;
      if (rm && !String(x.roomId || '').includes(rm)) continue;
      if (pr && !String(x.peerId || '').includes(pr)) continue;
      if (ev && !String(x.event || '').includes(ev)) continue;
      const d = JSON.stringify(x.detail || {});
      if (k && !d.toLowerCase().includes(k)) continue;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${x.ts}</td>
        <td>${x.level}</td>
        <td>${x.roomId || ''}</td>
        <td>${x.peerId || ''}</td>
        <td>${x.event || ''}</td>
        <td class="detail">${d}</td>`;
      rows.appendChild(tr);
    }
  };

  es.onmessage = (e) => {
    try { buf.push(JSON.parse(e.data)); } catch {}
    render();
  };

  [level, room, peer, event, kw].forEach((el) => el.addEventListener('input', render));
})();
