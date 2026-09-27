// Touch (landscape, two thumbs) + mouse/keyboard input. No allocation per event in hot paths.
export interface InputState {
  moveX: number; moveY: number;          // -1..1 (x right, y forward)
  lookDX: number; lookDY: number;        // accumulated pixels since last frame
  swatQueued: boolean;                   // swing request
  swatScreen: { x: number; y: number } | null; // aim point in CSS px (null = crosshair)
  interactQueued: boolean;
  keys: Set<string>;
}

export interface InputOptions { leftHanded: boolean; lookSensitivity: number; invertY: boolean; }

export class Input {
  state: InputState = { moveX: 0, moveY: 0, lookDX: 0, lookDY: 0, swatQueued: false, swatScreen: null, interactQueued: false, keys: new Set() };
  opts: InputOptions = { leftHanded: false, lookSensitivity: 1, invertY: false };
  enabled = false;
  private stickId: number | null = null; private stickOx = 0; private stickOy = 0;
  private lookId: number | null = null; private lookX = 0; private lookY = 0; private lookStartX = 0; private lookStartY = 0; private lookStartT = 0; private lookMoved = 0;
  private mouseDown = false; private mouseX = 0; private mouseY = 0; private mouseMoved = 0; private mouseT = 0;
  onStick?: (active: boolean, ox: number, oy: number, dx: number, dy: number) => void;

  constructor(private el: HTMLElement, private swatBtn: HTMLElement, private doorBtn: HTMLElement) {
    el.addEventListener('pointerdown', this.down, { passive: false });
    el.addEventListener('pointermove', this.move, { passive: false });
    el.addEventListener('pointerup', this.up, { passive: false });
    el.addEventListener('pointercancel', this.up, { passive: false });
    swatBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); if (this.enabled) { this.state.swatQueued = true; this.state.swatScreen = null; } });
    doorBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); if (this.enabled) this.state.interactQueued = true; });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = e.code;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(k)) e.preventDefault();
      if (k === 'Space' && !e.repeat) { this.state.swatQueued = true; this.state.swatScreen = null; }
      if (k === 'KeyE' && !e.repeat) this.state.interactQueued = true;
      this.state.keys.add(k);
    });
    window.addEventListener('keyup', (e) => this.state.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());
  }

  reset() {
    this.stickId = this.lookId = null; this.mouseDown = false;
    this.state.moveX = this.state.moveY = this.state.lookDX = this.state.lookDY = 0;
    this.state.swatQueued = false; this.state.swatScreen = null; this.state.interactQueued = false; this.state.keys.clear();
    this.onStick?.(false, 0, 0, 0, 0);
  }

  private isStickSide(x: number) { const w = this.el.clientWidth; return this.opts.leftHanded ? x > w * 0.5 : x < w * 0.5; }

  private down = (e: PointerEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    if (e.pointerType === 'mouse') {
      this.mouseDown = true; this.mouseX = e.clientX; this.mouseY = e.clientY; this.mouseMoved = 0; this.mouseT = performance.now();
      this.el.setPointerCapture(e.pointerId); return;
    }
    if (this.isStickSide(e.clientX) && this.stickId === null) {
      this.stickId = e.pointerId; this.stickOx = e.clientX; this.stickOy = e.clientY;
      this.onStick?.(true, this.stickOx, this.stickOy, 0, 0);
    } else if (this.lookId === null) {
      this.lookId = e.pointerId; this.lookX = this.lookStartX = e.clientX; this.lookY = this.lookStartY = e.clientY; this.lookStartT = performance.now(); this.lookMoved = 0;
    }
    try { this.el.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
  };

  private move = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse') {
      if (!this.mouseDown) return;
      const dx = e.clientX - this.mouseX, dy = e.clientY - this.mouseY;
      this.mouseX = e.clientX; this.mouseY = e.clientY; this.mouseMoved += Math.abs(dx) + Math.abs(dy);
      this.state.lookDX += dx; this.state.lookDY += dy; return;
    }
    if (e.pointerId === this.stickId) {
      const R = Math.min(70, this.el.clientHeight * 0.16);
      let dx = e.clientX - this.stickOx, dy = e.clientY - this.stickOy;
      const l = Math.hypot(dx, dy);
      if (l > R) { // floating stick follows the thumb
        this.stickOx += dx * (1 - R / l); this.stickOy += dy * (1 - R / l); dx = e.clientX - this.stickOx; dy = e.clientY - this.stickOy;
      }
      this.state.moveX = dx / R; this.state.moveY = -dy / R;
      this.onStick?.(true, this.stickOx, this.stickOy, dx, dy);
    } else if (e.pointerId === this.lookId) {
      const dx = e.clientX - this.lookX, dy = e.clientY - this.lookY;
      this.lookX = e.clientX; this.lookY = e.clientY; this.lookMoved += Math.abs(dx) + Math.abs(dy);
      this.state.lookDX += dx; this.state.lookDY += dy;
    }
  };

  private up = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') {
      if (this.mouseDown && this.mouseMoved < 6 && performance.now() - this.mouseT < 350 && this.enabled) {
        this.state.swatQueued = true; this.state.swatScreen = { x: e.clientX, y: e.clientY };
      }
      this.mouseDown = false; return;
    }
    if (e.pointerId === this.stickId) {
      this.stickId = null; this.state.moveX = this.state.moveY = 0; this.onStick?.(false, 0, 0, 0, 0);
    } else if (e.pointerId === this.lookId) {
      // a short tap (little movement) on the look side = swat toward the tapped point
      if (this.lookMoved < 10 && performance.now() - this.lookStartT < 280 && this.enabled) {
        this.state.swatQueued = true; this.state.swatScreen = { x: this.lookStartX, y: this.lookStartY };
      }
      this.lookId = null;
    }
  };

  /** Keyboard contribution to movement (merged each frame). */
  keyMove(): [number, number] {
    const k = this.state.keys;
    const x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    return [x, y];
  }
}
