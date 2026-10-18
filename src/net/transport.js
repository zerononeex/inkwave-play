// Play Together link: device-to-device WebRTC data connections via PeerJS (vendor/peerjs, loaded by a classic script
// tag as globalThis.Peer). PeerJS's default public cloud broker only introduces two browsers that share a room code;
// after that every byte flows directly between the devices. There is no game server, no room list and no discovery:
// the only way into a room is its code.
//
// Star topology: the device that creates the room is the HOST PEER (PeerJS id = ROOM_PREFIX + code). Guests open one
// reliable data connection to it. The host does what the old relay did — assigns ids, sends the welcome, tracks
// membership (join / leave), refuses joins while locked, answers pings and fans out game payloads. Wire format on a
// data connection (strings; game payloads stay raw JSON, never re-parsed by the host when forwarding):
//   guest → host   {"t":"hello","name","v"}  "b|<json>" broadcast  "s|<to>|<json>" to one member  "ping"
//   host → guest   {"t":"welcome","id","host","members":[{id,name}]}  {"t":"join","m":{id,name}}  {"t":"leave","id","host"}
//                  {"t":"err","e":"…"} (then close)  "m|<from>|<json>" relayed payload  "pong"

export const PROTO = 1;
export const ROOM_PREFIX = 'inkwave-family-';
const MAX = 8;
// A guest whose pings stop is a player whose connection died without closing (Wi-Fi gone, iPad locked): drop them so
// their squidkid is handed to a bot instead of standing frozen. A hidden tab still pings (throttled), so the lobby
// allowance is generous. Same numbers the old relay used.
const SILENT_MATCH = 20000, SILENT_LOBBY = 150000, SWEEP = 4000;
const PONG_WAIT = 25000;          // guest: an unanswered ping this old means the host is gone
const CONNECT_WAIT = 12000;
// player-facing messages (menus.js JOIN_ERR keys)
export const ERR = {
  net: 'Could not connect',             // shown as "Couldn't connect. Check the Wi-Fi and try again."
  notFound: 'Room not found',
  taken: 'Room code taken',
  full: 'Room is full',
  busy: 'Match in progress',
  browser: 'Browser not supported',
  update: 'Please refresh the page — the game was updated',
};

// Debug: simulate a real connection on localhost — ?netlag=ms (extra one-way delay on everything received),
// &netjitter=ms (random extra, delivered in order like TCP: late packets bunch up) and &netspike=p (chance per
// message of a 250 ms Wi-Fi hiccup that holds everything behind it).
const SIM = (() => {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const lag = +q.get('netlag') || 0, jit = +q.get('netjitter') || 0, spike = +q.get('netspike') || 0;
  return lag || jit || spike ? { lag, jit, spike, last: 0 } : null;
})();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const cleanName = (n) => String(n || 'Player').replace(/[^\p{L}\p{N} ._\-!?']/gu, '').slice(0, 16) || 'Player';
const NET_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable']);

export class Transport {
  constructor() {
    this.peer = null;
    this.conn = null;        // guest: the link to the host
    this.id = null;
    this.onControl = null;   // (obj) => void   welcome / join / leave
    this.onMessage = null;   // (from, obj) => void
    this.onClose = null;     // (reason) => void
    this.rtt = 0;            // smoothed round trip to the host, ms (0 on the host itself)
    this._pingT = null; this._pingSent = 0;
    this.bytesIn = 0; this.bytesOut = 0;
    // host side
    this.isHostPeer = false;
    this._members = new Map();   // id → { id, name, conn (null for the host), seen, seq }
    this._locked = false;
    this._sweepT = null;
    this._closed = false;
  }

  /** Resolves with the welcome frame, rejects with an Error carrying a player-facing message. */
  connect(code, name, create) {
    const Peer = globalThis.Peer;
    if (typeof Peer !== 'function') return Promise.reject(new Error(ERR.net));
    return create ? this._host(Peer, code, cleanName(name)) : this._guest(Peer, code, cleanName(name));
  }

  // ------------------------------------------------------------------ host
  _host(Peer, code, name) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      let peer;
      try { peer = new Peer(ROOM_PREFIX + code); } catch { reject(new Error(ERR.net)); return; }
      this.peer = peer;
      this.isHostPeer = true;
      const timer = setTimeout(() => { done(reject, new Error(ERR.net)); this.close(); }, CONNECT_WAIT);
      peer.on('open', () => {
        if (settled) return;
        this.id = this._newId();
        this._members.set(this.id, { id: this.id, name, conn: null, seen: now() });
        const welcome = { t: 'welcome', id: this.id, host: this.id, members: [{ id: this.id, name }] };
        this._sweepT = setInterval(() => this._sweep(), SWEEP);
        done(resolve, welcome);
        this.onControl?.(welcome);
      });
      peer.on('connection', (conn) => this._accept(conn));
      // the broker link dropping doesn't touch live data connections — only new joins need it, so dial back in
      peer.on('disconnected', () => { if (settled && !this._closed && !peer.destroyed) { try { peer.reconnect(); } catch { /* retried next drop */ } } });
      peer.on('error', (e) => {
        if (settled) return;
        const t = e && e.type;
        const err = t === 'unavailable-id' ? ERR.taken : t === 'browser-incompatible' ? ERR.browser : ERR.net;
        done(reject, new Error(err));
        this.close();
      });
    });
  }

  _newId() {
    let id;
    do { id = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X'); } while (this._members.has(id));
    return id;
  }

  _accept(conn) {
    let member = null;
    const refuse = (e) => {
      const bye = () => { try { conn.send(JSON.stringify({ t: 'err', e })); } catch { /* closing */ } setTimeout(() => { try { conn.close(); } catch { /* gone */ } }, 250); };
      if (conn.open) bye(); else conn.on('open', bye);
    };
    if (this._closed) { refuse(ERR.notFound); return; }
    if (this._locked) { refuse(ERR.busy); return; }                 // match running: nobody new gets in
    if (this._members.size >= MAX) { refuse(ERR.full); return; }
    conn.on('data', (raw) => {
      const s = typeof raw === 'string' ? raw : '';
      if (!s) return;
      this.bytesIn += s.length;
      if (!member) {                                               // first frame must be the hello
        let o; try { o = JSON.parse(s); } catch { return; }
        if (o.t !== 'hello') return;
        if (+o.v !== PROTO) { refuse(ERR.update); return; }
        if (this._locked) { refuse(ERR.busy); return; }
        if (this._members.size >= MAX) { refuse(ERR.full); return; }
        const id = this._newId(), nm = cleanName(o.name);
        member = { id, name: nm, conn, seen: now() };
        const others = [...this._members.values()];
        this._members.set(id, member);
        this._sendConn(conn, JSON.stringify({ t: 'welcome', id, host: this.id, members: [...others, member].map(({ id, name }) => ({ id, name })) }));
        const j = JSON.stringify({ t: 'join', m: { id, name: nm } });
        for (const m of others) if (m.conn) this._sendConn(m.conn, j);
        this.onControl?.({ t: 'join', m: { id, name: nm } });
        return;
      }
      member.seen = now();
      this._fromGuest(member, s);
    });
    const gone = () => { if (member) this._gone(member); };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  _fromGuest(member, s) {
    if (s === 'ping') { this._sendConn(member.conn, 'pong'); return; }
    const c = s.charCodeAt(0);
    if (c === 98 /* b */ && s.charCodeAt(1) === 124) {
      const payload = s.slice(2), out = 'm|' + member.id + '|' + payload;
      for (const m of this._members.values()) if (m.conn && m !== member) this._sendConn(m.conn, out);
      this._deliver(member.id, payload);
      return;
    }
    if (c === 115 /* s */ && s.charCodeAt(1) === 124) {
      const k = s.indexOf('|', 2);
      if (k < 0) return;
      const to = s.slice(2, k), payload = s.slice(k + 1);
      if (to === this.id) { this._deliver(member.id, payload); return; }
      const m = this._members.get(to);
      if (m && m.conn) this._sendConn(m.conn, 'm|' + member.id + '|' + payload);
    }
  }

  _gone(member) {
    if (!this._members.has(member.id) || this._members.get(member.id) !== member) return;
    this._members.delete(member.id);
    try { member.conn.close(); } catch { /* gone */ }
    if (this._closed) return;
    const out = JSON.stringify({ t: 'leave', id: member.id, host: this.id });
    for (const m of this._members.values()) if (m.conn) this._sendConn(m.conn, out);
    this.onControl?.({ t: 'leave', id: member.id, host: this.id });
  }

  _sweep() {
    const t = now(), limit = this._locked ? SILENT_MATCH : SILENT_LOBBY;
    for (const m of [...this._members.values()]) if (m.conn && t - m.seen > limit) this._gone(m);
  }

  // ------------------------------------------------------------------ guest
  _guest(Peer, code, name) {
    return new Promise((resolve, reject) => {
      let settled = false, brokerOk = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const fail = (msg) => { done(reject, new Error(msg)); this.close(); };
      let peer;
      try { peer = new Peer(); } catch { reject(new Error(ERR.net)); return; }
      this.peer = peer;
      // reached the broker but the host never answered → most likely a wrong code; no broker at all → the Wi-Fi
      const timer = setTimeout(() => fail(brokerOk ? ERR.notFound : ERR.net), CONNECT_WAIT);
      let closeReason = null;
      peer.on('open', () => {
        brokerOk = true;
        if (settled) return;
        const conn = (this.conn = peer.connect(ROOM_PREFIX + code, { reliable: true, serialization: 'raw' }));
        conn.on('open', () => this._sendConn(conn, JSON.stringify({ t: 'hello', name, v: PROTO })));
        const handle = (s) => {
          if (this.conn !== conn) return;
          if (s === 'pong') {
            if (this._pingSent) { const r = now() - this._pingSent; this._pingSent = 0; this.rtt = this.rtt ? this.rtt + (r - this.rtt) * 0.3 : r; }
            return;
          }
          if (s.charCodeAt(0) === 109 && s.charCodeAt(1) === 124) {            // "m|from|json"
            const k = s.indexOf('|', 2);
            let obj; try { obj = JSON.parse(s.slice(k + 1)); } catch { return; }
            this.onMessage?.(s.slice(2, k), obj);
            return;
          }
          let o; try { o = JSON.parse(s); } catch { return; }
          if (o.t === 'err') { closeReason = o.e; if (!settled) fail(o.e || ERR.net); return; }
          if (o.t === 'welcome') { this.id = o.id; this._startPing(); done(resolve, o); }
          this.onControl?.(o);
        };
        conn.on('data', (raw) => {
          const s = typeof raw === 'string' ? raw : '';
          if (!s) return;
          this.bytesIn += s.length;
          if (!SIM) { handle(s); return; }
          const t = Math.max(now() + SIM.lag + Math.random() * SIM.jit + (Math.random() < SIM.spike ? 250 : 0), SIM.last);
          SIM.last = t;
          setTimeout(() => handle(s), t - now());
        });
        const lost = () => {
          if (this.conn !== conn) return;
          if (!settled) { fail(closeReason || ERR.notFound); return; }
          this._stopPing();
          this.conn = null;
          try { peer.destroy(); } catch { /* gone */ }
          this.onClose?.(closeReason || 'Disconnected');
        };
        conn.on('close', lost);
        conn.on('error', lost);
      });
      peer.on('error', (e) => {
        if (settled) return;
        const t = e && e.type;
        fail(t === 'peer-unavailable' ? ERR.notFound : t === 'browser-incompatible' ? ERR.browser : NET_ERRORS.has(t) ? ERR.net : ERR.net);
      });
    });
  }

  _startPing() {
    this._stopPing();
    const ping = () => {
      // a ping the host never answered: it's gone (a phone locked mid-match closes nothing cleanly)
      if (this._pingSent && now() - this._pingSent > PONG_WAIT) {
        const conn = this.conn; this.conn = null; this._stopPing();
        try { conn?.close(); } catch { /* gone */ }
        try { this.peer?.destroy(); } catch { /* gone */ }
        this.onClose?.('Connection timed out');
        return;
      }
      if (!this._pingSent) this._pingSent = now();   // time the oldest unanswered one (pongs come in order)
      this._raw('ping');
    };
    ping();
    this._pingT = setInterval(ping, 2000);
  }
  _stopPing() { if (this._pingT) clearInterval(this._pingT); this._pingT = null; }

  // ------------------------------------------------------------------ sending
  _sendConn(conn, s) {
    if (!conn || !conn.open) return false;
    try { conn.send(s); } catch { return false; }
    this.bytesOut += s.length;
    return true;
  }
  _raw(s) { return this._sendConn(this.conn, s); }
  // host: hand a guest's payload to our own session (async, like a message arriving off the wire)
  _deliver(from, payload) {
    let obj; try { obj = JSON.parse(payload); } catch { return; }
    if (!SIM) { this.onMessage?.(from, obj); return; }
    const t = Math.max(now() + SIM.lag + Math.random() * SIM.jit + (Math.random() < SIM.spike ? 250 : 0), SIM.last);
    SIM.last = t;
    setTimeout(() => { if (!this._closed) this.onMessage?.(from, obj); }, t - now());
  }

  broadcast(obj) {
    if (!this.isHostPeer) return this._raw('b|' + JSON.stringify(obj));
    if (!this.open) return false;
    const out = 'm|' + this.id + '|' + JSON.stringify(obj);
    for (const m of this._members.values()) if (m.conn) this._sendConn(m.conn, out);
    return true;
  }
  sendTo(id, obj) {
    if (!this.isHostPeer) return this._raw('s|' + id + '|' + JSON.stringify(obj));
    if (!this.open) return false;
    const json = JSON.stringify(obj);
    if (id === this.id) { queueMicrotask(() => this._deliver(this.id, json)); return true; }
    const m = this._members.get(id);
    return !!(m && m.conn && this._sendConn(m.conn, 'm|' + this.id + '|' + json));
  }
  lock(v) {
    if (!this.isHostPeer) return false;
    this._locked = !!v;
    return true;
  }
  get open() {
    if (this.isHostPeer) return !this._closed && !!this.peer && !this.peer.destroyed && !!this.id;
    return !!this.conn && !!this.conn.open;
  }

  close() {
    this._closed = true;
    this._stopPing();
    clearInterval(this._sweepT); this._sweepT = null;
    if (this.isHostPeer) {
      const bye = JSON.stringify({ t: 'err', e: 'The host closed the room' });
      for (const m of this._members.values()) if (m.conn) { this._sendConn(m.conn, bye); try { m.conn.close(); } catch { /* gone */ } }
      this._members.clear();
    }
    const conn = this.conn; this.conn = null;
    try { conn?.close(); } catch { /* gone */ }
    const peer = this.peer; this.peer = null;
    try { peer?.destroy(); } catch { /* gone */ }
  }
}
