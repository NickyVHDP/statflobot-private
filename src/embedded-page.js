'use strict';

const http   = require('http');
const logger = require('./logger');

function httpRequest(method, fullUrl, body) {
  const data = body != null ? JSON.stringify(body) : null;
  const url  = new URL(fullUrl);
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: url.hostname,
      port:     parseInt(url.port, 10) || 80,
      path:     url.pathname + (url.search || ''),
      headers:  {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed);
        } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(35_000, () => { req.destroy(); reject(new Error(`bridge timeout: ${fullUrl}`)); });
    if (data) req.write(data);
    req.end();
  });
}

class EmbeddedElementHandle {
  constructor(page, selector) {
    this._page = page;
    this._sel  = selector;
  }

  async isVisible() {
    try {
      return !!(await this._page.evaluate((s) => {
        const el = document.querySelector(s);
        return !!(el && el.offsetParent !== null && el.offsetHeight > 0 && !el.disabled);
      }, this._sel));
    } catch { return false; }
  }

  async boundingBox() {
    try {
      return await this._page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return null;
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }, this._sel);
    } catch { return null; }
  }

  async click(options = {}) {
    logger.info(`[EMBEDDED_ADAPTER] element.click sel="${this._sel}"`);
    return this._page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) throw new Error('element not found: ' + s);
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      el.click();
    }, this._sel);
  }

  async fill(value, options = {}) {
    logger.info(`[EMBEDDED_ADAPTER] element.fill sel="${this._sel}"`);
    return this._page.evaluate((s, v) => {
      const el = document.querySelector(s);
      if (!el) throw new Error('element not found: ' + s);
      el.focus();
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) nativeSetter.call(el, v);
      else el.value = v;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, this._sel, value);
  }

  async type(text, options = {}) {
    const delay = options.delay ?? 0;
    logger.info(`[EMBEDDED_ADAPTER] element.type sel="${this._sel}" len=${text.length} delay=${delay}`);
    await this._page.evaluate((s, v, d) => {
      return new Promise(resolve => {
        const el = document.querySelector(s);
        if (!el) { resolve(); return; }
        el.focus();
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        let i = 0;
        function next() {
          if (i >= v.length) { resolve(); return; }
          const ch = v[i++];
          const cur = el.value;
          if (nativeSetter) nativeSetter.call(el, cur + ch);
          else el.value = cur + ch;
          el.dispatchEvent(new Event('input',    { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
          if (d > 0) setTimeout(next, d); else next();
        }
        next();
      });
    }, this._sel, text, delay);
  }

  async textContent() {
    try {
      return (await this._page.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? (el.textContent ?? '') : '';
      }, this._sel)) ?? '';
    } catch { return ''; }
  }

  async getAttribute(attr) {
    try {
      return await this._page.evaluate((s, a) => {
        const el = document.querySelector(s);
        return el ? el.getAttribute(a) : null;
      }, this._sel, attr);
    } catch { return null; }
  }

  async evaluateHandle(fn, ...args) {
    await this._page.evaluate(fn, ...args).catch(() => {});
    return this;
  }
}

class EmbeddedLocator {
  constructor(page, selector, index = null) {
    this._page  = page;
    this._sel   = selector;
    this._index = index;
  }

  _resolveEl() {
    // Returns JS expression string for the element — used in evaluate calls
    return null; // evaluate functions handle this inline
  }

  first() { return new EmbeddedLocator(this._page, this._sel, 0); }
  nth(n)  { return new EmbeddedLocator(this._page, this._sel, n); }

  async count() {
    try {
      return (await this._page.evaluate((s) => document.querySelectorAll(s).length, this._sel)) ?? 0;
    } catch { return 0; }
  }

  async isVisible() {
    try {
      return !!(await this._page.evaluate((s, idx) => {
        const el = idx !== null && idx !== undefined
          ? document.querySelectorAll(s)[idx]
          : document.querySelector(s);
        return !!(el && el.offsetParent !== null && el.offsetHeight > 0 && !el.disabled);
      }, this._sel, this._index));
    } catch { return false; }
  }

  async click(options = {}) {
    logger.info(`[EMBEDDED_ADAPTER] locator.click sel="${this._sel}" idx=${this._index}`);
    return this._page.evaluate((s, idx) => {
      const el = idx !== null && idx !== undefined
        ? document.querySelectorAll(s)[idx]
        : document.querySelector(s);
      if (!el) throw new Error('locator element not found: ' + s);
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      el.click();
    }, this._sel, this._index);
  }

  async fill(text) {
    logger.info(`[EMBEDDED_ADAPTER] locator.fill sel="${this._sel}"`);
    return this._page.evaluate((s, idx, v) => {
      const el = idx !== null && idx !== undefined
        ? document.querySelectorAll(s)[idx]
        : document.querySelector(s);
      if (!el) throw new Error('locator element not found: ' + s);
      el.focus();
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) nativeSetter.call(el, v);
      else el.value = v;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, this._sel, this._index, text);
  }

  async textContent() {
    try {
      return (await this._page.evaluate((s, idx) => {
        const el = idx !== null && idx !== undefined
          ? document.querySelectorAll(s)[idx]
          : document.querySelector(s);
        return el ? (el.textContent ?? '') : '';
      }, this._sel, this._index)) ?? '';
    } catch { return ''; }
  }

  async getAttribute(attr) {
    try {
      return await this._page.evaluate((s, idx, a) => {
        const el = idx !== null && idx !== undefined
          ? document.querySelectorAll(s)[idx]
          : document.querySelector(s);
        return el ? el.getAttribute(a) : null;
      }, this._sel, this._index, attr);
    } catch { return null; }
  }

  async waitFor(options = {}) {
    const state   = options.state   ?? 'visible';
    const timeout = options.timeout ?? 30_000;
    const deadline = Date.now() + timeout;
    logger.info(`[EMBEDDED_ADAPTER] locator.waitFor sel="${this._sel}" idx=${this._index} state=${state}`);
    while (Date.now() < deadline) {
      try {
        const visible = await this.isVisible();
        if ((state === 'visible') && visible) return;
        if ((state === 'hidden')  && !visible) return;
        if (state === 'attached') {
          const exists = await this._page.evaluate((s) => !!document.querySelector(s), this._sel);
          if (exists) return;
        }
        if (state === 'detached') {
          const exists = await this._page.evaluate((s) => !!document.querySelector(s), this._sel);
          if (!exists) return;
        }
      } catch { /* retry */ }
      await this._page.waitForTimeout(200);
    }
    throw new Error(`[EMBEDDED_ADAPTER] locator.waitFor timeout: state=${state} sel="${this._sel}"`);
  }

  async evaluateHandle(fn, ...args) {
    await this._page.evaluate(fn, ...args).catch(() => {});
    return this;
  }
}

class EmbeddedKeyboard {
  constructor(page) { this._page = page; }
  async press(key) {
    logger.info(`[EMBEDDED_ADAPTER] keyboard.press key=${key}`);
    return httpRequest('POST', this._page._base + '/api/embedded/keyboard/press', { key });
  }
}

class EmbeddedMouse {
  constructor(page) { this._page = page; }
  async click(x, y, options = {}) {
    logger.info(`[EMBEDDED_ADAPTER] mouse.click x=${x} y=${y}`);
    return this._page.evaluate((px, py) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      el.click();
    }, x, y);
  }
}

class EmbeddedContext {
  constructor(page) { this._page = page; }
  pages()    { return [this._page]; }
  on(ev, fn) { /* no popup events in embedded mode */ }
  async clearCookies() {
    logger.info('[EMBEDDED_ADAPTER] context.clearCookies');
    return httpRequest('POST', this._page._base + '/api/embedded/cookies/clear', {});
  }
}

class EmbeddedPage {
  constructor(baseUrl) {
    this._base       = baseUrl.replace(/\/$/, '');
    this._closed     = false;
    this._cachedUrl  = 'about:blank'; // synchronous URL cache — updated on goto/waitForTimeout
    this.keyboard    = new EmbeddedKeyboard(this);
    this.mouse       = new EmbeddedMouse(this);

    // Proxy: log and throw on any unknown method call so gaps surface immediately
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target || typeof prop === 'symbol') return target[prop];
        const msg = `[EMBEDDED_ADAPTER_MISSING_METHOD] EmbeddedPage.${String(prop)} is not implemented`;
        logger.error(msg);
        return () => { throw new Error(msg); };
      },
    });
  }

  isClosed() { return this._closed; }

  // SYNCHRONOUS url() — safe to call without await, matching Playwright's page.url() contract.
  // Cache is kept fresh: goto() updates it after navigation, waitForTimeout() polls after each delay.
  url() { return this._cachedUrl; }

  async _refreshUrl() {
    try {
      const r = await httpRequest('GET', this._base + '/api/embedded/url', null);
      if (r && r.url) this._cachedUrl = r.url;
    } catch { /* non-fatal — stale cache is acceptable */ }
  }

  async goto(url, options = {}) {
    const waitUntil = options.waitUntil ?? 'domcontentloaded';
    const timeout   = options.timeout   ?? 30_000;
    logger.info(`[EMBEDDED_ADAPTER] page.goto url=${url}`);
    const result = await httpRequest('POST', this._base + '/api/embedded/navigate', { url, waitUntil, timeout });
    // Update URL cache from navigate response (which includes the final post-redirect URL)
    if (result && result.url) this._cachedUrl = result.url;
    logger.info(`[EMBEDDED_ADAPTER] page.goto done — cachedUrl=${this._cachedUrl}`);
    return result;
  }

  async waitForTimeout(ms) {
    await new Promise(r => setTimeout(r, ms));
    // Refresh URL cache after every sleep so synchronous url() callers see the live URL
    await this._refreshUrl();
  }

  async evaluate(fn, ...args) {
    const r = await httpRequest('POST', this._base + '/api/embedded/evaluate', {
      fn:   fn.toString(),
      args: args,
    });
    return r.result ?? null;
  }

  async evaluateHandle(fn, ...args) {
    await this.evaluate(fn, ...args).catch(() => {});
    return {};
  }

  async $(selector) {
    logger.info(`[EMBEDDED_ADAPTER] page.$ sel="${selector}"`);
    try {
      const exists = await this.evaluate((s) => !!document.querySelector(s), selector);
      return exists ? new EmbeddedElementHandle(this, selector) : null;
    } catch { return null; }
  }

  async $$(selector) {
    logger.info(`[EMBEDDED_ADAPTER] page.$$ sel="${selector}"`);
    try {
      const count = await this.evaluate((s) => document.querySelectorAll(s).length, selector);
      return Array(count ?? 0).fill(null).map(() => new EmbeddedElementHandle(this, selector));
    } catch { return []; }
  }

  async waitForSelector(selector, options = {}) {
    const timeout  = options.timeout  ?? 30_000;
    const state    = options.state    ?? 'visible';
    const deadline = Date.now() + timeout;
    logger.info(`[EMBEDDED_ADAPTER] page.waitForSelector sel="${selector}" state=${state}`);
    while (Date.now() < deadline) {
      try {
        if (state === 'hidden' || state === 'detached') {
          const exists = await this.evaluate((s) => !!document.querySelector(s), selector);
          if (!exists) return null;
          if (state === 'hidden') {
            const vis = await this.evaluate((s) => {
              const el = document.querySelector(s);
              return !!(el && el.offsetParent !== null && el.offsetHeight > 0 && !el.disabled);
            }, selector);
            if (!vis) return null;
          }
        } else {
          // 'visible' or 'attached'
          const el = await this.$(selector);
          if (!el) { await this.waitForTimeout(200); continue; }
          if (state === 'attached') return el;
          const vis = await el.isVisible();
          if (vis) return el;
        }
      } catch { /* retry */ }
      await this.waitForTimeout(200);
    }
    throw new Error(`[EMBEDDED_ADAPTER] waitForSelector timeout: state=${state} sel="${selector}"`);
  }

  async waitForLoadState(state = 'load', options = {}) {
    logger.info(`[EMBEDDED_ADAPTER] page.waitForLoadState state=${state}`);
    // Navigation already waits for domcontentloaded/load in navigateAndWait.
    // This is a short settle pause for SPAs that update DOM after load events.
    await this.waitForTimeout(500);
  }

  async waitForURL(pattern, options = {}) {
    const timeout  = options.timeout ?? 30_000;
    const deadline = Date.now() + timeout;
    logger.info(`[EMBEDDED_ADAPTER] page.waitForURL pattern=${pattern}`);
    while (Date.now() < deadline) {
      const cur = this.url();
      const match = typeof pattern === 'string'
        ? cur.includes(pattern)
        : (pattern instanceof RegExp ? pattern.test(cur) : false);
      if (match) return;
      await this.waitForTimeout(500);
    }
    throw new Error(`[EMBEDDED_ADAPTER] waitForURL timeout: pattern=${pattern}`);
  }

  async selectOption(selector, option) {
    const value = typeof option === 'string' ? option : (option.value ?? option.label ?? '');
    logger.info(`[EMBEDDED_ADAPTER] page.selectOption sel="${selector}" value="${value}"`);
    return this.evaluate((s, v) => {
      const el = document.querySelector(s);
      if (!el) throw new Error('selectOption: element not found: ' + s);
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }, selector, value);
  }

  async $eval(selector, fn, ...args) {
    logger.info(`[EMBEDDED_ADAPTER] page.$eval sel="${selector}"`);
    return this.evaluate((s, fnSrc, a) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const f = eval('(' + fnSrc + ')'); // eslint-disable-line no-eval
      return f(el, ...a);
    }, selector, fn.toString(), args);
  }

  async goBack(options = {}) {
    logger.info('[EMBEDDED_ADAPTER] page.goBack');
    await this.evaluate(() => window.history.back());
    const settle = Math.min(options.timeout ?? 4000, 2000);
    await this.waitForTimeout(settle);
  }

  locator(selector) {
    logger.info(`[EMBEDDED_ADAPTER] page.locator sel="${selector}"`);
    return new EmbeddedLocator(this, selector);
  }

  async close() {
    logger.info('[EMBEDDED_ADAPTER] page.close');
    this._closed = true;
  }
}

module.exports = { EmbeddedPage, EmbeddedContext };
