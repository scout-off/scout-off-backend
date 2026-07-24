class MockPool {
  constructor(_config) {
    this._config = _config;
    this._listeners = {};
    this.totalCount = 0;
    this.idleCount = 0;
  }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return this;
  }

  _emit(event, ...args) {
    (this._listeners[event] || []).forEach((fn) => fn(...args));
  }

  async connect() {
    this.totalCount++;
    this.idleCount++;
    return {
      query: async () => ({ rows: [{ '?column?': 1 }] }),
      release: () => {
        this.totalCount = Math.max(0, this.totalCount - 1);
        this.idleCount = Math.max(0, this.idleCount - 1);
      },
    };
  }

  async end() {
    this.totalCount = 0;
    this.idleCount = 0;
  }
}

module.exports = { Pool: MockPool };
