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
    return this._page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) throw new Error('element not found: ' + s);
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      el.click();
    }, this._sel);
  }

  async fill(value, options = {}) {
    return this._page.evaluate((s, v) => {
      const el = document.querySelector(s);
      if (!el) throw new Error('element not found: ' + s);
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) nativeSetter.call(el, v);
      else el.value = v;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, this._sel, value);
  }

  async textContent() {
    try {
      return (await this._page.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? (el.textContent ?? '') : '';
      }, this._sel)) ?? '';
    } catch { return ''; }
  }

  async evaluateHandle(fn, ...args) {
    await this._page.evaluate(fn, ...args).catch(() => {});
    return this;
  }
}

class EmbeddedLocator {
  constructor(page, selector) {
    this._page = page;
    this._sel  = selector;
  }
  first() { return this; }
  async isVisible() {
    const el = await this._page.$(this._sel);
    return el ? el.isVisible() : false;
  }
}

class EmbeddedKeyboard {
  constructor(page) { this._page = page; }
  async press(key) {
    return httpRequest('POST', this._page._base + '/api/embedded/keyboard/press', { key });
  }
}

class EmbeddedContext {
  constructor(page) { this._page = page; }
  pages()    { return [this._page]; }
  on(ev, fn) { /* no popup events in embedded mode */ }
  async clearCookies() {
    return httpRequest('POST', this._page._base + '/api/embedded/cookies/clear', {});
  }
}

class EmbeddedPage {
  constructor(baseUrl) {
    this._base    = baseUrl.replace(/\/$/, '');
    this._closed  = false;
    this.keyboard = new EmbeddedKeyboard(this);
  }

  isClosed() { return this._closed; }

  async url() {
    try {
      const r = await httpRequest('GET', this._base + '/api/embedded/url', null);
      return r.url ?? 'about:blank';
    } catch { return 'about:blank'; }
  }

  async goto(url, options = {}) {
    const waitUntil = options.waitUntil ?? 'domcontentloaded';
    const timeout   = options.timeout   ?? 30_000;
    logger.info(`[EMBEDDED_PAGE] goto ${url}`);
    return httpRequest('POST', this._base + '/api/embedded/navigate', { url, waitUntil, timeout });
  }

  async waitForTimeout(ms) {
    await new Promise(r => setTimeout(r, ms));
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
    try {
      const exists = await this.evaluate((s) => !!document.querySelector(s), selector);
      return exists ? new EmbeddedElementHandle(this, selector) : null;
    } catch { return null; }
  }

  async $$(selector) {
    try {
      const count = await this.evaluate((s) => document.querySelectorAll(s).length, selector);
      return Array(count ?? 0).fill(null).map(() => new EmbeddedElementHandle(this, selector));
    } catch { return []; }
  }

  async waitForSelector(selector, options = {}) {
    const timeout  = options.timeout  ?? 30_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = await this.$(selector);
      if (el) return el;
      await this.waitForTimeout(200);
    }
    throw new Error(`waitForSelector timeout: ${selector}`);
  }

  locator(selector) {
    return new EmbeddedLocator(this, selector);
  }

  async close() { this._closed = true; }
}

module.exports = { EmbeddedPage, EmbeddedContext };
