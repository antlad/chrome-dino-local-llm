/**
 * Minimal Chrome DevTools Protocol client, Node built-ins only.
 *
 * Node ships a global WebSocket, so a CDP client is about forty lines and does
 * not justify a dependency. This keeps "check the game in a real browser" free,
 * which matters for a project whose whole premise is zero dependencies.
 */

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const list = this.handlers.get(msg.method);
      if (list) for (const fn of list) fn(msg.params ?? {});
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return this;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const fail = (why) => reject(new Error(`CDP connect failed: ${why}`));
    ws.addEventListener('error', () => fail(url));
    ws.addEventListener('close', (e) => fail(`closed ${e.code ?? ''}`));
    ws.addEventListener('open', () => resolve(new Cdp(ws)));
  });
}
