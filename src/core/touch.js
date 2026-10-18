// On-screen touch controls for tablets / phones (landscape, in-match only). Plain DOM over the canvas; it only writes
// Input.touch (see input.js) and player.js ORs that into the same intent as keys and the gamepad.
//
//   left ~40%   floating joystick: appears under the thumb, follows it (radial dead zone + curve: radialStick)
//   right side  drag anywhere that isn't a button to aim
//   buttons     FIRE (hold) · SWIM (hold) · JUMP (tap) · BOMB (hold = arc, release = throw) · STAR (special)
//               MAP (top right, tap to open / close; tap a teammate pin to Super Jump) · ⏸ (top left, pause)
// Every touch is tracked by pointerId, so stick + aim + FIRE (three fingers) all register at once. A touch that starts
// on a button stays that button's (pointer capture) and never aims; an aim drag never presses a button.
// Shown when settings.touchControls is 'on', or 'auto' on a coarse-pointer device / after the first touch.
import { G } from './ctx.js';
import { radialStick } from './input.js';

const STICK_R = 60;          // px of thumb travel for full deflection
const LEFT_ZONE = 0.4;       // share of the screen width that spawns the joystick

const ICON = {
  fire: '<svg viewBox="0 0 48 48"><path d="M24 3s15 16.5 15 27a15 15 0 0 1-30 0C9 19.5 24 3 24 3z"/><path d="M17 31a7 7 0 0 0 6 6" fill="none" stroke-width="3.5" stroke-linecap="round" class="s e2"/></svg>',
  swim: '<svg viewBox="0 0 48 48"><path d="M24 4c7 6 11 12 11 19 0 3-1 5-3 6l3 13-6-6-2 8-3-8-3 8-2-8-6 6 3-13c-2-1-3-3-3-6 0-7 4-13 11-19z"/><circle cx="19.5" cy="22" r="2.6" class="e"/><circle cx="28.5" cy="22" r="2.6" class="e"/></svg>',
  jump: '<svg viewBox="0 0 48 48"><path d="M24 6 40 24H30v16H18V24H8z"/></svg>',
  bomb: '<svg viewBox="0 0 48 48"><circle cx="22" cy="28" r="14"/><path d="M30 15l5-5m0 0 4 1m-4-1-1-4" fill="none" stroke-width="4" stroke-linecap="round" class="s"/></svg>',
  star: '<svg viewBox="0 0 48 48"><path d="M24 4l6 13 14 1.5-10.5 9.5 3 14L24 35l-12.5 7 3-14L4 18.5 18 17z"/></svg>',
  map: '<svg viewBox="0 0 48 48"><path d="M6 11l11-4 14 5 11-4v29l-11 4-14-5-11 4z M17 7v29 M31 12v29" fill="none" stroke-width="4" stroke-linejoin="round" class="s"/></svg>',
  pause: '<svg viewBox="0 0 48 48"><rect x="12" y="9" width="8" height="30" rx="2"/><rect x="28" y="9" width="8" height="30" rx="2"/></svg>',
};
export const TOUCH_BUTTONS = [
  // key, word, icon, hold?   (the order and words are also the iPad help card's)
  { key: 'fire', word: 'FIRE', help: 'HOLD FIRE to paint!' },
  { key: 'swim', word: 'SWIM', help: 'HOLD SWIM to dive into your ink and refill.' },
  { key: 'jump', word: 'JUMP', help: 'TAP JUMP to hop up.' },
  { key: 'bomb', word: 'BOMB', help: 'HOLD BOMB to aim, let go to throw!' },
  { key: 'star', word: 'STAR', help: 'TAP STAR when it glows for your special!' },
];
export const touchIcon = (k) => ICON[k] || '';

/** Is this a touch device as far as Auto is concerned? (true once a finger has touched the page) */
let sawTouch = false;
export function isTouchDevice() {
  if (sawTouch) return true;
  try { return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches); } catch { return false; }
}
/** settings.touchControls: 'auto' (default) | 'on' | 'off' */
export function touchWanted(settings) {
  const v = settings?.touchControls || 'auto';
  return v === 'on' || (v === 'auto' && isTouchDevice());
}

export class TouchControls {
  constructor(input, { onPause } = {}) {
    this.input = input;
    this.onPause = onPause;
    this.visible = false;
    this.stickId = null; this.aimId = null;
    this.ox = 0; this.oy = 0;              // joystick origin (where the thumb landed)
    this.ax = 0; this.ay = 0;              // last aim position
    this._ready = null; this._team = null;
    window.addEventListener('touchstart', () => { if (!sawTouch) { sawTouch = true; } }, { capture: true, passive: true });

    const btn = (key, word, cls) => {
      const el = document.createElement('div');
      el.className = `iw-tb iw-tb--${key}${cls ? ' ' + cls : ''}`;
      el.innerHTML = `<span class="iw-tb__ico">${ICON[key]}</span>${word ? `<b class="iw-tb__w">${word}</b>` : ''}`;
      return el;
    };
    const root = (this.el = document.createElement('div'));
    root.id = 'iw-touch';
    root.className = 'iw-touch';
    root.setAttribute('aria-hidden', 'true');
    this.base = document.createElement('div'); this.base.className = 'iw-tstick';
    this.knob = document.createElement('div'); this.knob.className = 'iw-tstick__knob';
    this.base.appendChild(this.knob);
    root.appendChild(this.base);
    const cluster = document.createElement('div');
    cluster.className = 'iw-tcluster';
    this.btns = {};
    for (const b of TOUCH_BUTTONS) { const el = btn(b.key, b.word); this.btns[b.key] = el; cluster.appendChild(el); }
    root.appendChild(cluster);
    this.btns.map = btn('map', 'MAP', 'iw-tb--small');
    this.btns.pause = btn('pause', '', 'iw-tb--small');
    root.appendChild(this.btns.map); root.appendChild(this.btns.pause);
    document.body.appendChild(root);

    // ---- buttons: each finger is its own (pointer capture keeps it even if the thumb slides off)
    const T = input.touch;
    const hold = { fire: 'fire', swim: 'squid', bomb: 'sub', jump: 'jump', star: 'special' };
    for (const [key, el] of Object.entries(this.btns)) {
      const ids = new Set();
      const up = (e) => {
        if (!ids.delete(e.pointerId)) return;
        if (!ids.size) { el.classList.remove('is-down'); if (hold[key]) T[hold[key]] = false; }
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
        ids.add(e.pointerId);
        el.classList.add('is-down');
        input.lastDevice = 'touch';
        if (hold[key]) T[hold[key]] = true;
        if (key === 'jump') T.jumpTap = true;
        if (key === 'star') T.specialTap = true;
        if (key === 'map') this._setMap(!T.map);
        if (key === 'pause') { this.onPause?.(); }
      });
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    }

    // ---- the free surface: joystick on the left, aim on the right, pin taps while the map is open
    root.addEventListener('pointerdown', (e) => {
      if (e.target !== root && e.target !== this.base && e.target !== this.knob) return;
      e.preventDefault();
      input.lastDevice = 'touch';
      if (T.map) { T.tap = { x: e.clientX, y: e.clientY }; return; }
      if (e.clientX < innerWidth * LEFT_ZONE) {
        if (this.stickId != null) return;
        this.stickId = e.pointerId; this.ox = e.clientX; this.oy = e.clientY;
        this._stick(e.clientX, e.clientY);
        this.base.classList.add('is-on');
      } else {
        if (this.aimId != null) return;
        this.aimId = e.pointerId; this.ax = e.clientX; this.ay = e.clientY;
      }
      try { root.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
    });
    root.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) { e.preventDefault(); this._stick(e.clientX, e.clientY); }
      else if (e.pointerId === this.aimId) {
        e.preventDefault();
        T.aimDx += e.clientX - this.ax; T.aimDy += e.clientY - this.ay;
        this.ax = e.clientX; this.ay = e.clientY;
      }
    });
    const end = (e) => {
      if (e.pointerId === this.stickId) this._stickOff();
      if (e.pointerId === this.aimId) this.aimId = null;
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('lostpointercapture', end);
    // Safari: no page scroll / pinch / double-tap zoom / callout while playing
    const stop = (e) => { if (this.visible) e.preventDefault(); };
    root.addEventListener('touchstart', stop, { passive: false });
    root.addEventListener('touchmove', stop, { passive: false });
    root.addEventListener('contextmenu', stop);
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('dblclick', stop, { passive: false });
  }

  _stick(x, y) {
    let dx = x - this.ox, dy = y - this.oy;
    const d = Math.hypot(dx, dy);
    // the base follows a thumb that runs past the rim, so letting it drift never leaves the stick stuck at full tilt
    if (d > STICK_R) { const k = (d - STICK_R) / d; this.ox += dx * k; this.oy += dy * k; dx = x - this.ox; dy = y - this.oy; }
    radialStick(dx / STICK_R, dy / STICK_R, this.input.touch.stick, 0.12, 0.96);
    this.base.style.transform = `translate3d(${this.ox.toFixed(1)}px,${this.oy.toFixed(1)}px,0)`;
    this.knob.style.transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0)`;
  }
  _stickOff() {
    this.stickId = null;
    const s = this.input.touch.stick; s.x = s.y = s.mag = 0;
    this.base.classList.remove('is-on');
  }
  _setMap(on) {
    this.input.touch.map = !!on;
    this.btns.map.classList.toggle('is-active', !!on);
    if (on) { this.input.touch.fire = this.input.touch.sub = false; }   // never fire through the map
  }
  /** The map closes after a successful Super Jump (diorama.js). */
  closeMap() { if (this.input.touch.map) this._setMap(false); }

  _release() {
    const T = this.input.touch;
    T.fire = T.squid = T.jump = T.sub = T.special = false;
    T.jumpTap = T.specialTap = false; T.aimDx = T.aimDy = 0; T.tap = null;
    this._setMap(false);
    this._stickOff();
    this.aimId = null;
    for (const el of Object.values(this.btns)) el.classList.remove('is-down');
  }

  /** Per frame (main.js). `show` = a live round is on screen with no menu over it. */
  update(show, settings) {
    const want = touchWanted(settings);
    if (want !== this.input.touchMode) {
      this.input.touchMode = want;
      if (want) this.input.exitLock();
      document.documentElement.classList.toggle('iw-touchmode', want);
    }
    const vis = want && show;
    if (vis !== this.visible) {
      this.visible = vis;
      this.el.classList.toggle('is-on', vis);
      if (!vis) this._release();
    }
    if (!vis) return;
    const me = G.match?.local;
    const ready = !!(me && me.specialReady && me.specialReady());
    if (ready !== this._ready) { this._ready = ready; this.btns.star.classList.toggle('is-ready', ready); }
    const col = me ? G.teamHex?.[me.team] : null;
    if (col && col !== this._team) { this._team = col; this.el.style.setProperty('--tc', col); }
  }
}
