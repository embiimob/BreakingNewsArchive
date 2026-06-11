
  (() => {
    'use strict';

    const P2FK_VER = 0x6f;
    const P2FK_CHUNK = 20;
    const P2FK_PAD = '#';
    const P2FK_SIGVER = '88';
    const DUST = 546;
    const FEE_DEFAULT = 10;
    const FEE_MIN = 2;
    const CHANGE_COUNT = 2;
    const CHANGE_PREFIX = 'sup:testnet3:change:';
    const AMOUNT_PER = DUST / 1e8;
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const DELIMITERS = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    const CID_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/i;
    const IPFS_PATH_RE = /^\/?ipfs\/([a-zA-Z0-9]+)(?:\/(.*))?$/i;
    const UNSAFE_RE = /[^a-zA-Z0-9._-]/g;
    const ADDR_RE = /^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/;
    const TXID_RE = /^[0-9a-fA-F]{64}$/;
    const HEADLINE_PADDING_MAX = 14;
    const STORY_TEXT_MAX = 1000;
    const MIN_SUBSTANTIVE_CHARS = 220;
    const MIN_SUBSTANTIVE_WORDS = 45;
    const MIN_PUNCTUATED_WORDS = 25;
    const MIN_PARAGRAPH_LENGTH = 60;
    const MAX_PARAGRAPHS_FOR_FALLBACK = 8;
    const MAX_TEXT_LENGTH_VARIANCE = 40;
    const URL_DECODE_ATTEMPTS = 2;
    const LINK_PRIORITY_AP = 0;
    const LINK_PRIORITY_OTHER = 1;
    const LINK_PRIORITY_GOOGLE = 2;
    const MAX_VISIBLE_CONFIRMED = 5;
    const BALANCE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
    const DEFAULT_FEED_SOURCES = [
      'https://feeds.npr.org/1001/rss.xml',
      'https://www.aljazeera.com/xml/rss/all.xml',
      'https://www.theguardian.com/world/rss',
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://rss.dw.com/rdf/rss-en-top',
    ];

    const S = {
      priv: null,
      addr: '',
      keyring: null,
      lastChangeOutputAddr: '',
      kwCache: new Map(),
      keywordAddress: '',
      keyword: '',
      p2fkItems: [],
      feedItems: [],
      comparisonRows: [],
      syncQueue: [],
      syncRunning: false,
      syncTimer: null,
      nextScanTimer: null,
      syncBusy: false,
      lastBroadcastTxid: '',
      lastCompletedScanAt: 0,
      syncStateById: new Map(),
      recentConfirmedIds: [],
      lastBalanceCheckAt: 0,
      lastPendingWalletActivity: false,
    };

    const $ = id => document.getElementById(id);
    const norm = v => typeof v === 'string' ? v.trim() : '';
    const esc = t => String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const sanitize = msg => norm(String(msg ?? '')).replace(/<<([^>]+)>>/g, '##L$1R##').replace(/[<>]/g, ' ').replace(/##L(.*?)R##/g, '<<$1>>');
    const utf8len = v => new TextEncoder().encode(String(v ?? '')).length;
    const isAddr = v => ADDR_RE.test(norm(v));
    const shortAddr = v => { const t = norm(v); return t.length > 16 ? `${t.slice(0,8)}…${t.slice(-5)}` : t; };
    const shortText = (v, n = 110) => { const t = norm(v).replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
    const fmtTez = sat => `${(Number(sat || 0) / 1e8).toFixed(8)} tBTC`;
    const parseHashtags = msg => {
      const m = norm(msg).match(/#[^\s]{1,64}/g) || [];
      return [...new Set(m.map(t => t.replace(/^#+/, '').trim()).filter(Boolean))];
    };
    const unique = arr => [...new Set(arr.filter(Boolean))];
    const cleanKeyword = value => norm(value).replace(/^#/, '');
    const parseTimestamp = value => {
      const parsed = Date.parse(String(value || ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const fmtPublished = value => {
      const timestamp = parseTimestamp(value);
      return timestamp ? new Date(timestamp).toLocaleString() : 'Unknown';
    };
    const isImageUrl = value => {
      try {
        const u = new URL(value);
        return /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(u.pathname);
      } catch {
        return false;
      }
    };

    function appendLog(message, kind = 'info') {
      const line = `[${new Date().toLocaleTimeString()}] ${message}`;
      const log = $('log');
      const div = document.createElement('div');
      div.textContent = line;
      if (kind === 'bad') div.style.color = '#ffc0c0';
      if (kind === 'warn') div.style.color = '#ffe1a5';
      if (kind === 'good') div.style.color = '#bff3db';
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }

    function setStatus(id, text, kind = '') {
      const el = $(id);
      el.textContent = text;
      el.className = `status${kind ? ` ${kind}` : ''}`;
    }

    function getApiBase() { return norm($('apiBaseInput').value) || 'https://p2fk.io'; }
    function getMempoolApi() { return norm($('mempoolInput').value) || 'https://mempool.space/testnet/api'; }
    function parseFeedUrlList(value) {
      return unique(String(value || '').split(/[\n,]/).map(norm).filter(Boolean));
    }
    function getFeedUrls() {
      const configured = parseFeedUrlList($('feedUrlInput').value);
      return configured.length ? configured : DEFAULT_FEED_SOURCES;
    }
    function getFeedProxyTemplate() { return norm($('feedProxyInput').value) || 'https://corsproxy.io/?key=f136e028&url={{url}}'; }
    function isGoogleCall(url) {
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        return hostname === 'news.google.com' || hostname.endsWith('.news.google.com');
      } catch {
        return false;
      }
    }
    function isApNewsUrl(url) {
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        return hostname === 'apnews.com' || hostname.endsWith('.apnews.com');
      } catch {
        return false;
      }
    }
    function unwrapGoogleNewsUrl(url) {
      const source = norm(url);
      if (!source) return '';
      if (!isGoogleCall(source)) return source;
      try {
        const parsed = new URL(source);
        for (const key of ['url', 'u', 'q']) {
          const value = norm(parsed.searchParams.get(key));
          if (!value) continue;
          let candidate = value;
          for (let i = 0; i < URL_DECODE_ATTEMPTS; i++) {
            try {
              candidate = decodeURIComponent(candidate);
            } catch {
              break;
            }
          }
          try {
            const parsedCandidate = new URL(candidate);
            if (parsedCandidate.protocol === 'http:' || parsedCandidate.protocol === 'https:') return parsedCandidate.toString();
          } catch {
            // continue checking other params
          }
        }
      } catch {
        return '';
      }
      return '';
    }
    function buildCorsProxyUrl(url) {
      return `https://corsproxy.io/?key=f136e028&url=${encodeURIComponent(url)}`;
    }
    function buildTemplateProxyUrl(url, template = getFeedProxyTemplate()) {
      if (!template) return '';
      return template.includes('{{url}}')
        ? template.replace('{{url}}', encodeURIComponent(url))
        : `${template}?url=${encodeURIComponent(url)}`;
    }
    function getScanDelayMs() {
      const minutes = Math.max(1, Number($('pollMinutesInput').value || 5) || 5);
      return minutes * 60 * 1000;
    }

    function renderSummary() {
      const rows = S.comparisonRows || [];
      const totals = {
        p2fk: S.p2fkItems.length,
        feed: S.feedItems.length,
        matched: rows.filter(r => r.hasFeed && r.hasP2fk).length,
        missing: rows.filter(r => r.hasFeed && !r.hasP2fk).length,
        chainOnly: rows.filter(r => !r.hasFeed && r.hasP2fk).length,
        queued: rows.filter(r => r.syncState?.status === 'queued').length,
        synced: rows.filter(r => ['broadcasted','confirmed'].includes(r.syncState?.status)).length,
      };
      const items = [
        ['Keyword address', S.keywordAddress || '—'],
        ['p2fk refs', totals.p2fk],
        ['Feed stories', totals.feed],
        ['Matched', totals.matched],
        ['Missing on p2fk', totals.missing],
        ['p2fk only', totals.chainOnly],
        ['Queued/sent', `${totals.queued}/${totals.synced}`],
        ['Next rescan', S.nextScanTimer ? 'Scheduled' : 'Idle'],
      ];
      $('summaryGrid').innerHTML = items.map(([k, v]) => `<div class="summary-item"><span class="muted">${esc(k)}</span><strong>${esc(String(v))}</strong></div>`).join('');
    }

    function getSyncState(identifier) {
      const state = S.syncStateById.get(identifier) || {};
      return state;
    }

    function rememberConfirmed(identifier) {
      if (!identifier) return;
      S.recentConfirmedIds = [identifier, ...S.recentConfirmedIds.filter(id => id !== identifier)].slice(0, MAX_VISIBLE_CONFIRMED);
    }

    function pruneSyncState() {
      const keep = new Set([
        ...(S.comparisonRows || [])
          .filter(row => row.hasFeed && !row.hasP2fk)
          .map(row => row.identifier),
        ...S.syncQueue,
        ...S.recentConfirmedIds,
      ]);
      for (const [identifier, state] of S.syncStateById.entries()) {
        if (['queued', 'syncing', 'broadcasted'].includes(state.status)) keep.add(identifier);
      }
      [...S.syncStateById.keys()].forEach(identifier => {
        if (!keep.has(identifier)) S.syncStateById.delete(identifier);
      });
    }

    function getVisibleComparisonRows() {
      const recentConfirmed = new Set(S.recentConfirmedIds || []);
      return (S.comparisonRows || []).filter(row => {
        const status = getSyncState(row.identifier).status;
        if (row.hasFeed && !row.hasP2fk) return true;
        if (['queued', 'syncing', 'broadcasted'].includes(status)) return true;
        return status === 'confirmed' && recentConfirmed.has(row.identifier);
      });
    }

    function setSyncState(identifier, patch) {
      const next = { ...(S.syncStateById.get(identifier) || {}), ...patch };
      S.syncStateById.set(identifier, next);
      if (next.status === 'confirmed') rememberConfirmed(identifier);
      const row = (S.comparisonRows || []).find(item => item.identifier === identifier);
      if (row) row.syncState = next;
      pruneSyncState();
      renderComparison();
      renderSummary();
    }

    function renderComparison() {
      const body = $('comparisonBody');
      const rows = getVisibleComparisonRows();
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6" class="muted">No queued, missing, or recent confirmed stories right now.</td></tr>';
        renderSummary();
        return;
      }
      body.innerHTML = rows.map(row => {
        const article = row.feedItems[0] || null;
        const p2fk = row.p2fkItems[0] || null;
        const state = row.syncState || {};
        const statusPills = [];
        if (row.hasFeed && row.hasP2fk) statusPills.push('<span class="pill good">Matched</span>');
        if (row.hasFeed && !row.hasP2fk) statusPills.push('<span class="pill warn">Missing on p2fk</span>');
        if (!row.hasFeed && row.hasP2fk) statusPills.push('<span class="pill bad">Only on p2fk</span>');
        if (state.status === 'queued') statusPills.push('<span class="pill warn">Queued</span>');
        if (state.status === 'syncing') statusPills.push('<span class="pill warn">Syncing</span>');
        if (state.status === 'broadcasted') statusPills.push('<span class="pill warn">Broadcasted</span>');
        if (state.status === 'confirmed') statusPills.push('<span class="pill good">Confirmed</span>');
        if (state.status === 'error') statusPills.push(`<span class="pill bad">${esc(shortText(state.error || 'Error', 50))}</span>`);
        return `
          <tr>
            <td>
              <code>${esc(row.identifier)}</code>
              ${article?.guid ? `<div class="mini">${esc(shortText(article.guid, 70))}</div>` : ''}
            </td>
            <td>
              <div><strong>${esc(article?.title || '—')}</strong></div>
              <div class="mini">${esc(fmtPublished(article?.publishedAt))}</div>
              ${getPreferredArticleLink(article) ? `<div class="mini"><a href="${esc(getPreferredArticleLink(article))}" target="_blank" rel="noreferrer">Open AP story</a></div>` : ''}
            </td>
            <td>
              <div>${esc(shortText(article?.description || '', 220) || 'No description')}</div>
              ${article?.image ? `<div class="mini">${esc(isImageUrl(article.image) ? `Image attachment: ${shortText(article.image, 96)}` : `Image link: ${shortText(article.image, 96)}`)}</div>` : '<div class="mini">No image found in feed.</div>'}
            </td>
            <td>
              ${p2fk ? `<div class="stack"><div><code>${esc(p2fk.txId || '')}</code></div><div>${esc(shortText(p2fk.message || '', 180) || 'Message only')}</div></div>` : '<span class="muted">No matching AP identifier found at keyword.</span>'}
              <div class="mini">Hits: ${row.p2fkItems.length}</div>
            </td>
            <td>
              ${statusPills.join('') || '<span class="pill">Unknown</span>'}
              ${state.txid ? `<div class="mini">Latest tx: <code>${esc(state.txid)}</code></div>` : ''}
            </td>
            <td>
              <div class="btn-row">
                <button class="small-btn" data-sync-id="${esc(row.identifier)}" ${(!row.hasFeed || row.hasP2fk) ? 'disabled' : ''}>Etch one</button>
                <button class="small-btn" data-open-link="${esc(row.identifier)}" ${!getPreferredArticleLink(article) ? 'disabled' : ''}>Open AP</button>
              </div>
            </td>
          </tr>`;
      }).join('');
      body.querySelectorAll('[data-sync-id]').forEach(btn => btn.addEventListener('click', () => syncArticle(btn.dataset.syncId)));
      body.querySelectorAll('[data-open-link]').forEach(btn => btn.addEventListener('click', () => {
        const row = (S.comparisonRows || []).find(item => item.identifier === btn.dataset.openLink);
        const url = getPreferredArticleLink(row?.feedItems?.[0]);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      }));
      renderSummary();
    }

    function renderWalletInfo(entries = []) {
      const box = $('walletInfo');
      if (!entries.length) {
        box.innerHTML = '<div class="wallet-line"><span class="muted">No unlocked wallet.</span></div>';
        return;
      }
      box.innerHTML = entries.map(entry => `
        <div class="wallet-line">
          <div><strong>${esc(entry.label)}</strong></div>
          <code>${esc(entry.addr)}</code>
          <div class="mini">Confirmed: ${esc(fmtTez(entry.confirmed))} · Unconfirmed incoming: ${esc(fmtTez(entry.unconfirmed))}</div>
        </div>
      `).join('');
    }

    async function fetchJ(url, timeout = 20000, options = {}) {
      const ac = new AbortController();
      const id = setTimeout(() => ac.abort(), timeout);
      try {
        const res = await fetch(url, { cache: 'no-store', signal: ac.signal, ...options });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(id);
      }
    }

    async function fetchFeedText(url) {
      const template = getFeedProxyTemplate();
      const targets = unique([buildTemplateProxyUrl(url, template), buildCorsProxyUrl(url), url]);
      let lastError = new Error('Failed to fetch feed from any available source');
      for (const target of targets) {
        if (!target) continue;
        const ac = new AbortController();
        const id = setTimeout(() => ac.abort(), 30000);
        try {
          const res = await fetch(target, { cache: 'no-store', signal: ac.signal });
          if (!res.ok) throw new Error(`Feed request failed with HTTP ${res.status}`);
          const text = await res.text();
          if (/^\s*\{/.test(text)) {
            const payload = JSON.parse(text);
            if (typeof payload?.contents === 'string' && payload.contents.trim()) return payload.contents;
          }
          if (text.trim()) return text;
          throw new Error('Feed response was empty');
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(id);
        }
      }
      throw lastError;
    }

    function parseMsg(text) {
      const dec = String(text ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const attachments = [], links = [], salts = [];
      const clean = dec.replace(/<<[^>]+>>/g, '').trim();
      const refs = dec.match(/<<[^>]+>>/g) || [];
      refs.forEach(ref => {
        const inner = ref.slice(2, -2).trim();
        if (!inner) return;
        if (/^-?\d+$/.test(inner)) { salts.push(parseInt(inner, 10)); return; }
        if (TXID_RE.test(inner)) return;
        if (/^https?:\/\//i.test(inner)) links.push(inner);
        else if (/^IPFS:/i.test(inner) || /^[0-9a-fA-F]{64}[\\/]/.test(inner) || /^(BTC|LTC|DOG|MZC):[0-9a-fA-F]{64}[\\/]/i.test(inner)) attachments.push(inner);
      });
      return { clean, attachments, links, salts };
    }

    function normalizeRoot(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const rawMsg = raw.Message ?? raw['Message'] ?? '';
      const message = Array.isArray(rawMsg) ? rawMsg.join('\n') : String(rawMsg ?? '');
      const signedBy = norm(raw['Signed By'] ?? raw.SignedBy ?? raw.FromAddress ?? '');
      const blockDate = raw['Block Date'] ?? raw.BlockDate ?? '';
      const txId = norm(raw['Transaction Id'] ?? raw.TransactionId ?? raw['Transaction ID'] ?? '').toLowerCase();
      const outputObj = raw.Output ?? raw['Output'];
      let toAddrs = [];
      if (outputObj) {
        const outputAddrs = Object.keys(outputObj || {});
        toAddrs = outputAddrs.length > 1 ? outputAddrs.slice(Math.max(0, outputAddrs.length - 3), outputAddrs.length - 1) : [];
      }
      const rawFile = raw.File ?? raw['File'] ?? null;
      const files = (rawFile && typeof rawFile === 'object' && !Array.isArray(rawFile)) ? Object.keys(rawFile).filter(f => f && f !== 'SIG') : [];
      return { message, fromAddr: signedBy, toAddrs, blockDate, txId, files, raw };
    }

    async function getBalance(addr) {
      const res = await fetch(`${getMempoolApi()}/address/${encodeURIComponent(addr)}`);
      if (!res.ok) throw new Error(`Balance lookup failed ${res.status}`);
      const payload = await res.json();
      const cs = payload?.chain_stats || {};
      const ms = payload?.mempool_stats || {};
      return {
        confirmed: (Number(cs.funded_txo_sum || 0) - Number(cs.spent_txo_sum || 0)) - Number(ms.spent_txo_sum || 0),
        unconfirmed: Number(ms.funded_txo_sum || 0),
        mempoolSpent: Number(ms.spent_txo_sum || 0),
      };
    }

    function b2bi(b) { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; }
    function bi2b32(n) { const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(n & 0xffn); n >>= 8n; } return o; }
    function b2h(b) { return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(''); }
    function h2b(h) { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; }
    async function sha256(b) { return new Uint8Array(await crypto.subtle.digest('SHA-256', b)); }
    async function sha256hex(t) { return b2h(await sha256(new TextEncoder().encode(t))); }
    function encVI(n) { if (n < 0xfd) return new Uint8Array([n]); if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]); return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]); }
    async function msgHash(text) {
      const magic = new TextEncoder().encode('Bitcoin Signed Message:\n');
      const msg = new TextEncoder().encode(text);
      const ml = encVI(msg.length);
      const env = new Uint8Array(1 + magic.length + ml.length + msg.length);
      env[0] = magic.length;
      env.set(magic, 1);
      env.set(ml, 1 + magic.length);
      env.set(msg, 1 + magic.length + ml.length);
      return sha256(await sha256(env));
    }
    function encB58(b) {
      if (!(b instanceof Uint8Array)) b = new Uint8Array(b);
      let z = 0; while (z < b.length && b[z] === 0) z++;
      let v = 0n; for (const x of b) v = (v << 8n) + BigInt(x);
      let s = '';
      while (v > 0n) { const r = Number(v % 58n); v /= 58n; s = B58[r] + s; }
      return B58[0].repeat(z) + (s || (z ? '' : B58[0]));
    }
    async function encB58C(b) {
      const p = b instanceof Uint8Array ? b : new Uint8Array(b);
      const h = await sha256(await sha256(p));
      const out = new Uint8Array(p.length + 4);
      out.set(p);
      out.set(h.slice(0, 4), p.length);
      return encB58(out);
    }
    function decB58(s) {
      let n = 0n;
      for (const c of s) {
        const i = B58.indexOf(c);
        if (i < 0) throw new Error('Invalid base58');
        n = n * 58n + BigInt(i);
      }
      let z = 0;
      for (const c of s) { if (c !== B58[0]) break; z++; }
      const out = [];
      while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
      return new Uint8Array([...new Array(z).fill(0), ...out]);
    }
    async function decB58C(s) {
      const r = decB58(s);
      if (r.length < 5) throw new Error('Base58Check payload too short');
      const p = r.slice(0, -4);
      const c = r.slice(-4);
      const h = await sha256(await sha256(p));
      for (let i = 0; i < 4; i++) if (c[i] !== h[i]) throw new Error('Invalid checksum');
      return p;
    }

    const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
    const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
    const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
    const sP = n => ((n % P) + P) % P;
    const sN = n => ((n % N) + N) % N;
    function sInv(a, m) { let [r, s, rr, ss] = [m, 0n, ((a % m) + m) % m, 1n]; while (rr !== 0n) { const q = r / rr; [r, s, rr, ss] = [rr, ss, r - q * rr, s - q * ss]; } return ((s % m) + m) % m; }
    function jDbl(X, Y, Z) { if (Y === 0n) return [0n, 1n, 0n]; const Y2 = sP(Y * Y), S2 = sP(4n * X * Y2), M = sP(3n * X * X), X2 = sP(M * M - 2n * S2); return [X2, sP(M * (S2 - X2) - 8n * Y2 * Y2), sP(2n * Y * Z)]; }
    function jAdd(X1, Y1, Z1, X2, Y2, Z2) { if (Z1 === 0n) return [X2, Y2, Z2]; if (Z2 === 0n) return [X1, Y1, Z1]; const z1s = sP(Z1 * Z1), z2s = sP(Z2 * Z2), U1 = sP(X1 * z2s), U2 = sP(X2 * z1s), S1 = sP(Y1 * z2s * Z2), S2 = sP(Y2 * z1s * Z1), H = sP(U2 - U1), R = sP(S2 - S1); if (H === 0n) return R === 0n ? jDbl(X1, Y1, Z1) : [0n, 1n, 0n]; const Hs = sP(H * H), Hc = sP(H * Hs), X3 = sP(R * R - Hc - 2n * U1 * Hs); return [X3, sP(R * (U1 * Hs - X3) - S1 * Hc), sP(H * Z1 * Z2)]; }
    function jAff(X, Y, Z) { const zi = sInv(Z, P), zi2 = sP(zi * zi); return [sP(X * zi2), sP(Y * sP(zi2 * zi))]; }
    function sMul(k) { let [rx, ry, rz] = [0n, 1n, 0n], [ax, ay, az] = [Gx, Gy, 1n], sc = ((k % N) + N) % N; while (sc > 0n) { if (sc & 1n) [rx, ry, rz] = jAdd(rx, ry, rz, ax, ay, az); [ax, ay, az] = jDbl(ax, ay, az); sc >>= 1n; } return [rx, ry, rz]; }
    function priv2pub(pb) { const [jx, jy, jz] = sMul(b2bi(pb)); const [x, y] = jAff(jx, jy, jz); return new Uint8Array([(y & 1n) ? 0x03 : 0x02, ...bi2b32(x)]); }
    async function rfc6979k(priv, mh) {
      const hmac = async (key, ...parts) => {
        const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const size = parts.reduce((sum, p) => sum + p.length, 0);
        const msg = new Uint8Array(size);
        let off = 0;
        for (const p of parts) { msg.set(p, off); off += p.length; }
        return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
      };
      let V = new Uint8Array(32).fill(1), K = new Uint8Array(32).fill(0);
      K = await hmac(K, V, new Uint8Array([0]), priv, mh); V = await hmac(K, V);
      K = await hmac(K, V, new Uint8Array([1]), priv, mh); V = await hmac(K, V);
      for (;;) { V = await hmac(K, V); const k = b2bi(V); if (k >= 1n && k < N) return k; K = await hmac(K, V, new Uint8Array([0])); V = await hmac(K, V); }
    }
    async function ecSign(priv, mhb) { const d = b2bi(priv), z = b2bi(mhb), k = await rfc6979k(priv, mhb); const [rx, ry] = jAff(...sMul(k)); const r = sN(rx); let s = sN(sInv(k, N) * (z + r * d)); let rid = Number(ry & 1n) | (rx >= N ? 2 : 0); if (s > N / 2n) { s = N - s; rid ^= 1; } return { r, s, recoveryId: rid }; }
    function derEnc(r, s) { const mb = n => { const b = []; let t = n; while (t > 0n) { b.unshift(Number(t & 0xffn)); t >>= 8n; } if (b[0] & 0x80) b.unshift(0); return b; }; const rb = mb(r), sb = mb(s); return new Uint8Array([0x30, rb.length + sb.length + 4, 0x02, rb.length, ...rb, 0x02, sb.length, ...sb]); }
    function ripemd160(data) {
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      const rl32 = (x, n) => (x << n) | (x >>> (32 - n));
      const ff = (j, x, y, z) => j < 16 ? x ^ y ^ z : j < 32 ? (x & y) | (~x & z) : j < 48 ? (x | ~y) ^ z : j < 64 ? (x & z) | (y & ~z) : x ^ (y | ~z);
      const KL = [0, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E];
      const KR = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0];
      const RL = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
      const RR = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
      const SL = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
      const SR = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
      const ml = bytes.length, pl = ml % 64 < 56 ? 56 - (ml % 64) : 120 - (ml % 64);
      const pd = new Uint8Array(ml + pl + 8); pd.set(bytes); pd[ml] = 0x80;
      const bl = ml * 8; for (let i = 0; i < 4; i++) pd[ml + pl + i] = (bl >>> (i * 8)) & 0xff;
      const view = new DataView(pd.buffer);
      let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
      for (let off = 0; off < pd.length; off += 64) {
        const X = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true));
        let al = h0, bl_ = h1, cl = h2, dl = h3, el = h4, ar = h0, br = h1, cr = h2, dr = h3, er = h4;
        for (let j = 0; j < 80; j++) {
          const qi = j >> 4;
          let t = (rl32((al + ff(j, bl_, cl, dl) + X[RL[j]] + KL[qi]) | 0, SL[j]) + el) | 0;
          al = el; el = dl; dl = rl32(cl, 10); cl = bl_; bl_ = t;
          t = (rl32((ar + ff(79 - j, br, cr, dr) + X[RR[j]] + KR[qi]) | 0, SR[j]) + er) | 0;
          ar = er; er = dr; dr = rl32(cr, 10); cr = br; br = t;
        }
        const t = (h1 + cl + dr) | 0;
        h1 = (h2 + dl + er) | 0; h2 = (h3 + el + ar) | 0; h3 = (h4 + al + br) | 0; h4 = (h0 + bl_ + cr) | 0; h0 = t;
      }
      const out = new Uint8Array(20), dv = new DataView(out.buffer);
      [h0, h1, h2, h3, h4].forEach((v, i) => dv.setUint32(i * 4, v, true));
      return out;
    }

    async function wif2priv(wif) {
      const p = await decB58C(norm(wif));
      if (p[0] !== 0xef) throw new Error('Only testnet3 WIF supported');
      if (p.length === 34) return p.slice(1, 33);
      if (p.length === 33) return p.slice(1);
      throw new Error('Unexpected WIF length');
    }
    async function priv2addr(pb) {
      const pub = priv2pub(pb), h = ripemd160(await sha256(pub));
      return encB58C(new Uint8Array([P2FK_VER, ...h]));
    }
    async function deriveChangeKey(base, label) {
      const seedPfx = new TextEncoder().encode(`${CHANGE_PREFIX}${norm(label)}:`);
      const bsc = b2bi(base);
      const ctr = new Uint8Array(4);
      for (let c = 0; c <= 0xffffffff; c++) {
        ctr[0] = (c >>> 24) & 0xff; ctr[1] = (c >>> 16) & 0xff; ctr[2] = (c >>> 8) & 0xff; ctr[3] = c & 0xff;
        const seed = new Uint8Array(seedPfx.length + base.length + 4);
        seed.set(seedPfx); seed.set(base, seedPfx.length); seed.set(ctr, seedPfx.length + base.length);
        const tw = sN(b2bi(await sha256(seed)));
        if (tw === 0n) continue;
        const d = sN(bsc + tw);
        if (d === 0n) continue;
        return bi2b32(d);
      }
      throw new Error('Could not derive change key');
    }
    function buildP2PKH(h160) { return new Uint8Array([0x76, 0xa9, 0x14, ...h160, 0x88, 0xac]); }
    async function addrPayout(addr) {
      const p = await decB58C(norm(addr));
      if (p.length !== 21 || p[0] !== 0x6f) throw new Error(`Not a testnet3 legacy address: ${addr}`);
      return buildP2PKH(p.slice(1));
    }
    async function buildSignerEntry(pb, label) { const pub = priv2pub(pb), h = ripemd160(await sha256(pub)), addr = await encB58C(new Uint8Array([P2FK_VER, ...h])); return { label, pb, pub, script: buildP2PKH(h), addr }; }
    async function buildKeyring(base) {
      const main = await buildSignerEntry(base, 'main');
      const changes = [];
      for (let i = 0; i < CHANGE_COUNT; i++) {
        const d = await deriveChangeKey(base, `slot-${i + 1}`);
        changes.push(await buildSignerEntry(d, `change-${i + 1}`));
      }
      return { main, changes, all: [main, ...changes] };
    }
    function serializeTx(inputs, outputs, sigIdx = -1, sigScript = null) {
      const u32 = v => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
      const u64 = v => { const n = BigInt(Math.round(v)); return [...u32(Number(n & 0xffffffffn)), ...u32(Number((n >> 32n) & 0xffffffffn))]; };
      const vi = n => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 0xff, (n >> 8) & 0xff] : [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
      const out = [...u32(1), ...vi(inputs.length)];
      for (let i = 0; i < inputs.length; i++) {
        out.push(...Array.from(h2b(inputs[i].txid)).reverse(), ...u32(inputs[i].vout));
        const sc = sigIdx >= 0 ? (i === sigIdx ? sigScript : new Uint8Array([])) : inputs[i].scriptSig || new Uint8Array([]);
        out.push(...vi(sc.length), ...sc, ...u32(0xffffffff));
      }
      out.push(...vi(outputs.length));
      for (const o of outputs) out.push(...u64(o.sat), ...vi(o.script.length), ...o.script);
      out.push(...u32(0));
      return new Uint8Array(out);
    }
    async function buildTx(utxos, outputs) {
      const inputs = utxos.map(u => ({ txid: u.txid, vout: u.vout, signer: u.signer, scriptSig: new Uint8Array([]) }));
      const finalOuts = await Promise.all(outputs.map(async o => ({ sat: o.sat, script: await addrPayout(o.addr) })));
      for (let i = 0; i < inputs.length; i++) {
        const sg = inputs[i].signer;
        const pre = new Uint8Array([...serializeTx(inputs, finalOuts, i, sg.script), 1, 0, 0, 0]);
        const sh = await sha256(await sha256(pre));
        const { r, s } = await ecSign(sg.pb, sh);
        const der = derEnc(r, s);
        inputs[i].scriptSig = new Uint8Array([der.length + 1, ...der, 0x01, sg.pub.length, ...sg.pub]);
      }
      return b2h(serializeTx(inputs, finalOuts));
    }
    async function broadcastTx(outputs) {
      if (!S.priv) throw new Error('Wallet is locked');
      const kr = S.keyring || await buildKeyring(S.priv);
      if (!S.keyring) S.keyring = kr;
      const [cA, cB] = kr.changes;

      const balances = await Promise.all(kr.all.map(async sg => ({
        signer: sg,
        ...await getBalance(sg.addr)
      })));

      const totalsByAddr = balances.reduce((m, b) => m.set(b.signer.addr, b.confirmed), new Map());
      const totalConfirmed = Array.from(totalsByAddr.values()).reduce((a, b) => a + b, 0);
      if (totalConfirmed <= 0) throw new Error('No confirmed funds available');

      let feeRate = FEE_DEFAULT;
      try {
        const fr = await fetch(`${getMempoolApi()}/v1/fees/recommended`);
        const fp = await fr.json();
        feeRate = Math.max(Number(fp?.halfHourFee || FEE_DEFAULT), FEE_MIN);
      } catch {}

      const estFee = (inputs, outputsCount) => Math.ceil((10 + 148 * inputs + 34 * outputsCount) * feeRate);
      const outSats = outputs.map(o => ({ addr: o.addr, sat: Math.round(o.amount * 1e8) }));
      const totalOut = outSats.reduce((s, o) => s + o.sat, 0);

      const fetchUtxos = async (sg) => {
        try {
          const res = await fetch(`${getMempoolApi()}/address/${encodeURIComponent(sg.addr)}/utxo`);
          if (!res.ok) {
            console.warn(`UTXO fetch failed for ${sg.label}`);
            return [];
          }
          const items = await res.json();
          return items.filter(u => u.status?.confirmed).map(u => ({ ...u, srcAddr: sg.addr, signer: sg }));
        } catch (err) {
          console.warn(`UTXO fetch error for ${sg.label}: ${err.message}`);
          return [];
        }
      };

      const candidates = [kr.main, cA, cB].sort((a, b) => (totalsByAddr.get(b.addr) || 0) - (totalsByAddr.get(a.addr) || 0));
      let selected = null, selectedUtxos = [], selectedTotal = 0;
      let allFetchedUtxos = [];
      const fetchedAddrs = new Set();

      for (const src of candidates) {
        if ((totalsByAddr.get(src.addr) || 0) <= 0) continue;

        let pool = allFetchedUtxos.filter(u => u.srcAddr === src.addr);
        if (!fetchedAddrs.has(src.addr)) {
            pool = await fetchUtxos(src);
            allFetchedUtxos.push(...pool);
            fetchedAddrs.add(src.addr);
        }

        pool = pool.sort((a, b) => b.value - a.value);

        let local = [], total = 0;
        for (const u of pool) {
          local.push(u); total += u.value;
          if (total >= totalOut + estFee(local.length, outSats.length + 1)) {
            selected = src; selectedUtxos = local; selectedTotal = total; break;
          }
        }
        if (selectedUtxos.length) break;
      }

      if (!selectedUtxos.length) {
        for (const src of candidates) {
            if ((totalsByAddr.get(src.addr) || 0) > 0 && !fetchedAddrs.has(src.addr)) {
                const pool = await fetchUtxos(src);
                allFetchedUtxos.push(...pool);
                fetchedAddrs.add(src.addr);
            }
        }
        const mixPool = [...allFetchedUtxos].sort((a, b) => b.value - a.value);
        let local = [], total = 0;
        for (const u of mixPool) {
          local.push(u); total += u.value;
          if (total >= totalOut + estFee(local.length, outSats.length + 1)) {
            selectedUtxos = local; selectedTotal = total; break;
          }
        }
      }
      if (!selectedUtxos.length) throw new Error('Insufficient funds across main and change addresses');
      const fee = estFee(selectedUtxos.length, outSats.length + 1);
      const change = selectedTotal - totalOut - fee;
      if (change < 0) throw new Error('Insufficient balance after fee');
      let changeAddr = cA.addr;
      if (selected) {
        if (selected.addr === cA.addr) changeAddr = cB.addr;
        else if (selected.addr === cB.addr) changeAddr = cA.addr;
        else changeAddr = S.lastChangeOutputAddr === cA.addr ? cB.addr : cA.addr;
      } else {
        changeAddr = S.lastChangeOutputAddr === cA.addr ? cB.addr : cA.addr;
      }
      S.lastChangeOutputAddr = changeAddr;
      const finalOuts = [...outSats];
      if (change >= DUST) finalOuts.push({ addr: changeAddr, sat: change });
      const rawHex = await buildTx(selectedUtxos, finalOuts);
      const res = await fetch(`${getMempoolApi()}/tx`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: rawHex });
      if (!res.ok) throw new Error(`Broadcast failed: ${await res.text()}`);
      return (await res.text()).trim();
    }

    function randDelim() { const b = new Uint8Array(1), lim = Math.floor(256 / DELIMITERS.length) * DELIMITERS.length; let v = 0; do { crypto.getRandomValues(b); v = b[0]; } while (v >= lim); return DELIMITERS[v % DELIMITERS.length]; }
    function randSalt() { const b = new Uint32Array(1); crypto.getRandomValues(b); return -(b[0] % 100000); }
    async function signMsg(text) {
      if (!S.priv) throw new Error('Wallet locked');
      const mh = await msgHash(text);
      const { r, s, recoveryId } = await ecSign(S.priv, mh);
      const c = new Uint8Array(65); c[0] = 27 + 4 + recoveryId; c.set(bi2b32(r), 1); c.set(bi2b32(s), 33);
      return btoa(String.fromCharCode(...c));
    }
    async function deriveKeywordAddress(keyword) {
      const tok = norm(keyword).replace(/^#/, '');
      const b = new TextEncoder().encode(tok);
      const p = new Uint8Array(21);
      p[0] = P2FK_VER;
      p.fill(P2FK_PAD.charCodeAt(0), 1);
      if (b.length) p.set(b.slice(0, P2FK_CHUNK), 1);
      return encB58C(p);
    }
    async function kwAddr(keyword) {
      const tok = norm(keyword).replace(/^#/, '');
      if (!tok) return '';
      if (S.kwCache.has(tok)) return S.kwCache.get(tok);
      const addr = await deriveKeywordAddress(tok);
      S.kwCache.set(tok, addr);
      return addr;
    }
    async function encP2FK(payload, ver = P2FK_VER) {
      const b = new TextEncoder().encode(payload);
      const addrs = [], seen = new Set();
      for (let i = 0; i < b.length; i += P2FK_CHUNK) {
        const chunk = b.slice(i, i + P2FK_CHUNK);
        const padded = new Uint8Array(P2FK_CHUNK);
        padded.fill(P2FK_PAD.charCodeAt(0));
        padded.set(chunk);
        const ab = new Uint8Array(1 + P2FK_CHUNK); ab[0] = ver; ab.set(padded, 1);
        const enc = await encB58C(ab);
        if (!seen.has(enc)) { seen.add(enc); addrs.push(enc); }
      }
      return addrs;
    }
    async function buildMsgOutputs({ text, attachments = [], extras = [], fromAddr }) {
      const safe = sanitize(text);
      const delim = randDelim();
      const payload = `${safe}${attachments.map(a => `<<${a}>>`).join('')}<<${randSalt()}>>`;
      const unsObj = `${delim}${utf8len(payload)}${delim}${payload}`;
      const sigHash = (await sha256hex(unsObj)).toUpperCase();
      const sig = await signMsg(sigHash);
      const signed = `SIG${delim}${P2FK_SIGVER}${delim}${sig}${unsObj}`;
      const encAddrs = await encP2FK(signed);
      const recipients = new Set(encAddrs);
      await addrPayout(fromAddr);
      for (const kw of parseHashtags(safe)) recipients.add(await kwAddr(kw));
      for (const r of extras) {
        const a = norm(r);
        if (!a || a === fromAddr) continue;
        if (isAddr(a)) { await addrPayout(a); recipients.add(a); }
      }
      recipients.add(fromAddr);
      return [...recipients].map(addr => ({ addr, amount: AMOUNT_PER }));
    }

    function parseHtmlDoc(input) {
      return new DOMParser().parseFromString(String(input || ''), 'text/html');
    }

    function stripHtml(input) {
      const doc = parseHtmlDoc(input);
      return norm(doc.body?.textContent || '');
    }

    function normalizeLooseText(value) {
      return norm(value)
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }

    function isDuplicateHeadline(text, title) {
      const normalizedText = normalizeLooseText(text);
      const normalizedTitle = normalizeLooseText(title);
      if (!normalizedText || !normalizedTitle) return false;
      if (normalizedText === normalizedTitle) return true;
      if (normalizedText.startsWith(normalizedTitle) && normalizedText.length - normalizedTitle.length <= HEADLINE_PADDING_MAX) return true;
      if (normalizedText.endsWith(normalizedTitle) && normalizedText.length - normalizedTitle.length <= HEADLINE_PADDING_MAX) return true;
      return false;
    }

    function cleanArticleDescription(rawDescription, title) {
      const plain = stripHtml(rawDescription);
      if (!plain) return '';
      const parts = plain.split(/\n+|\s{2,}/).map(norm).filter(Boolean);
      if (!parts.length) return '';
      const filtered = parts.filter(part => !isDuplicateHeadline(part, title));
      if (filtered.length) return filtered.join(' ');
      return isDuplicateHeadline(plain, title) ? '' : plain;
    }

    function escapeRegExpSpecialChars(value) {
      return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function stripLeadingHeadline(text, title) {
      const cleanText = norm(String(text || ''));
      const cleanTitle = norm(String(title || ''));
      if (!cleanText || !cleanTitle) return cleanText;
      const normalizedText = normalizeLooseText(cleanText);
      const normalizedTitle = normalizeLooseText(cleanTitle);
      if (!isDuplicateHeadline(cleanText, cleanTitle) && !normalizedText.startsWith(normalizedTitle)) return cleanText;
      const titlePrefixPattern = new RegExp(`^\\s*${escapeRegExpSpecialChars(cleanTitle)}(?:\\s*[-–—:|•]+\\s*)?`, 'i');
      return norm(cleanText.replace(titlePrefixPattern, ''));
    }

    function isSubstantiveStoryText(value) {
      const text = norm(String(value || '')).replace(/\s+/g, ' ');
      if (!text) return false;
      const words = text.split(' ').filter(Boolean);
      return text.length >= MIN_SUBSTANTIVE_CHARS
        || words.length >= MIN_SUBSTANTIVE_WORDS
        || (words.length >= MIN_PUNCTUATED_WORDS && /[.!?]/.test(text));
    }

    function extractCanonicalLinkFromHtml(html) {
      const doc = parseHtmlDoc(html);
      const canonical = norm(doc.querySelector('link[rel="canonical"][href]')?.getAttribute('href') || '')
        || norm(doc.querySelector('meta[property="og:url"][content]')?.getAttribute('content') || '');
      return canonical;
    }

    function extractApLinkFromHtml(html) {
      const doc = parseHtmlDoc(html);
      const apAnchor = doc.querySelector('a[href*="apnews.com"], link[href*="apnews.com"], meta[content*="apnews.com"]');
      if (!apAnchor) return '';
      const rawUrl = apAnchor.hasAttribute('href')
        ? norm(apAnchor.getAttribute('href') || '')
        : norm(apAnchor.getAttribute('content') || '');
      try {
        const hostname = new URL(rawUrl).hostname.toLowerCase();
        return hostname.includes('apnews.com') ? rawUrl : '';
      } catch {
        return '';
      }
    }

    function extractArticleBodyText(html) {
      const doc = parseHtmlDoc(html);
      const articleBodySelectors = [
        '.RichTextStoryBody',
        'article',
        '.Article',
        '.article-body',
        '.story',
        'main',
      ];
      for (const selector of articleBodySelectors) {
        const node = doc.querySelector(selector);
        const text = norm(node?.textContent || '').replace(/\s+/g, ' ');
        if (isSubstantiveStoryText(text)) return text.substring(0, STORY_TEXT_MAX);
      }
      const paragraphText = [...doc.querySelectorAll('p')]
        .map(node => norm(node.textContent || '').replace(/\s+/g, ' '))
        .filter(text => text.length >= MIN_PARAGRAPH_LENGTH)
        .slice(0, MAX_PARAGRAPHS_FOR_FALLBACK)
        .join(' ');
      if (isSubstantiveStoryText(paragraphText)) return paragraphText.substring(0, STORY_TEXT_MAX);
      return '';
    }

    function buildProxyUrl(url) {
      if (isGoogleCall(url)) return buildCorsProxyUrl(url);
      return buildTemplateProxyUrl(url);
    }

    function extractPreferredArticleLink(rawDescription) {
      const doc = parseHtmlDoc(rawDescription);
      const links = [...doc.querySelectorAll('a[href]')]
        .map(link => norm(link.getAttribute('href') || ''))
        .filter(Boolean);
      const unwrappedLinks = links.map(unwrapGoogleNewsUrl).filter(Boolean);
      const candidates = unique([...unwrappedLinks, ...links]);
      if (!candidates.length) return '';
      const directAp = candidates.find(link => isApNewsUrl(link));
      if (directAp) return directAp;
      const nonGoogle = candidates.find(link => !isGoogleCall(link));
      return nonGoogle || candidates[0];
    }

    function getPreferredArticleLink(article) {
      return norm(article?.resolvedLink || article?.sourceLink || article?.link);
    }

    function extractHtmlImage(input) {
      const doc = parseHtmlDoc(input);
      const img = doc.querySelector('img[src]');
      return norm(img?.getAttribute('src') || '');
    }

    function normalizeIdentifierUrl(rawUrl) {
      const source = norm(rawUrl);
      if (!source) return '';
      try {
        const parsed = new URL(source);
        const trackerParams = [
          'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
          'utm_name', 'utm_id', 'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
          'at_campaign', 'at_medium',
        ];
        trackerParams.forEach(param => parsed.searchParams.delete(param));
        const sortedParams = [...parsed.searchParams.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
        parsed.search = '';
        sortedParams.forEach(([key, value]) => parsed.searchParams.append(key, value));
        parsed.hostname = parsed.hostname.toLowerCase();
        parsed.pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
        return parsed.toString();
      } catch {
        return source.toLowerCase();
      }
    }

    async function buildArticleIdentifier(article) {
      const primaryUrl = getPreferredArticleLink(article) || norm(article.guid);
      const normalizedUrl = normalizeIdentifierUrl(primaryUrl);
      if (!normalizedUrl) throw new Error('Article is missing URL fields (link, sourceLink, or guid) for stable identifier generation');
      return normalizedUrl;
    }

    function parseFeedItems(raw) {
      if (/^\s*[\[{]/.test(raw)) {
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (error) {
          throw new Error(`Feed returned invalid JSON: ${error.message}`);
        }
        const jsonItems = Array.isArray(payload?.items) ? payload.items : (Array.isArray(payload) ? payload : []);
        return jsonItems.map(normalizeFeedJsonItem);
      }
      const doc = new DOMParser().parseFromString(raw, 'application/xml');
      const xmlItems = [...doc.querySelectorAll('item, entry')];
      return xmlItems.map(normalizeFeedXmlItem);
    }

    function normalizeFeedJsonItem(item) {
      const rawDescription = String(item?.description || item?.content || item?.summary || '');
      const image = norm(item?.thumbnail || item?.enclosure?.link || item?.enclosure?.url || item?.image || extractHtmlImage(rawDescription));
      const title = norm(item?.title);
      const feedLink = norm(item?.link);
      return {
        title,
        link: unwrapGoogleNewsUrl(feedLink) || feedLink,
        sourceLink: extractPreferredArticleLink(rawDescription),
        guid: norm(item?.guid),
        rawDescription,
        description: cleanArticleDescription(rawDescription, title),
        publishedAt: norm(item?.pubDate || item?.published || item?.isoDate),
        image,
      };
    }

    function queryText(node, selectors = []) {
      for (const selector of selectors) {
        const hit = node.querySelector(selector);
        const value = norm(hit?.textContent || '');
        if (value) return value;
      }
      return '';
    }

    function queryAttr(node, selectors = [], attr = 'url') {
      for (const selector of selectors) {
        const hit = node.querySelector(selector);
        const value = norm(hit?.getAttribute(attr) || '');
        if (value) return value;
      }
      return '';
    }

    function normalizeFeedXmlItem(node) {
      const rawDescription = queryText(node, ['description', 'content\\:encoded', 'summary']);
      const linkFromAtom = queryAttr(node, ['link[href]'], 'href');
      const linkFromText = queryText(node, ['link']);
      const feedLink = linkFromAtom || linkFromText;
      const image = queryAttr(node, ['enclosure[type^="image/"]', 'media\\:content[url]', 'media\\:thumbnail[url]'])
        || extractHtmlImage(rawDescription);
      const title = queryText(node, ['title']);
      return {
        title,
        link: unwrapGoogleNewsUrl(feedLink) || feedLink,
        sourceLink: extractPreferredArticleLink(rawDescription),
        guid: queryText(node, ['guid', 'id']),
        rawDescription,
        description: cleanArticleDescription(rawDescription, title),
        publishedAt: queryText(node, ['pubDate', 'published', 'updated']),
        image,
      };
    }

    async function loadFeedItems() {
      const feedUrls = getFeedUrls();
      if (!feedUrls.length) throw new Error('Enter at least one feed URL');
      appendLog(`Loading feeds from ${feedUrls.length} source(s)…`);

      const settled = await Promise.allSettled(feedUrls.map(async feedUrl => {
        const raw = await fetchFeedText(feedUrl);
        const sourceItems = parseFeedItems(raw);
        appendLog(`Loaded ${sourceItems.length} story candidate(s) from ${feedUrl}.`, 'good');
        return sourceItems;
      }));

      const items = [];
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          items.push(...result.value);
          return;
        }
        appendLog(`Feed source failed (${feedUrls[index]}): ${result.reason?.message || result.reason || 'Unknown error'}`, 'warn');
      });

      if (!items.length) {
        throw new Error('No stories were loaded from any configured feed source');
      }

      const sortedItems = [...items].sort((a, b) => {
        const aDate = parseTimestamp(a?.publishedAt);
        const bDate = parseTimestamp(b?.publishedAt);
        return bDate - aDate;
      });
      const deduped = [];
      const seen = new Set();
      for (const item of sortedItems) {
        const candidate = {
          ...item,
          title: norm(item.title),
          link: norm(item.link),
          sourceLink: norm(item.sourceLink),
          guid: norm(item.guid),
          rawDescription: item.rawDescription,
          description: item.description,
          publishedAt: norm(item.publishedAt),
          image: norm(item.image),
        };
        const dedupSource = getPreferredArticleLink(candidate) || norm(candidate.guid);
        if (!candidate.title || !dedupSource) continue;
        candidate.identifier = await buildArticleIdentifier(candidate);
        const key = candidate.identifier;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(candidate);
        if (deduped.length >= 10) break;
      }
      appendLog(`Loaded ${deduped.length} breaking-news story(s) after merging sources.`, 'good');
      return deduped;
    }

    async function loadP2fkItems(keyword) {
      const normalizedKeyword = cleanKeyword(keyword);
      if (!normalizedKeyword) throw new Error('p2fk keyword cannot be empty');
      const address = await kwAddr(normalizedKeyword);
      S.keywordAddress = address;
      appendLog(`Keyword #${normalizedKeyword} maps to ${address}.`);
      const rows = [];
      const seen = new Set();
      const pageSize = 100;
      for (let skip = 0; ; skip += pageSize) {
        const data = await fetchJ(`${getApiBase()}/GetPublicMessagesByAddress/${encodeURIComponent(address)}?mainnet=false&skip=${skip}&qty=${pageSize}`, 30000);
        const batch = (Array.isArray(data) ? data : []).map(item => normalizeRoot(item.Root || item.root || item)).filter(Boolean);
        batch.forEach(root => {
          const parsedLinks = parseMsg(root.message || '').links || [];
          const rawLinks = (root.message || '').match(/https?:\/\/[^\s<>"]+/gi) || [];
          const combinedLinks = unique([...parsedLinks, ...rawLinks]);
          const normalizedLinks = combinedLinks.map(normalizeIdentifierUrl).filter(Boolean);
          const legacyIdentifiers = ((root.message || '').match(/APID:[A-F0-9]{24}/gi) || []).map(id => id.toUpperCase());
          const identifiers = unique([...normalizedLinks, ...legacyIdentifiers]);

          identifiers.forEach(identifier => {
            const key = `${identifier}:${root.txId}`;
            if (seen.has(key)) return;
            seen.add(key);
            rows.push({
              identifier: identifier,
              txId: root.txId,
              message: parseMsg(root.message || '').clean || root.message || '',
              fromAddr: root.fromAddr,
              blockDate: root.blockDate,
              rawRoot: root,
            });
          });
        });
        if (batch.length < pageSize) break;
      }
      appendLog(`Loaded ${rows.length} story identifiers from p2fk keyword #${normalizedKeyword}.`, 'good');
      return rows;
    }

    function buildComparisonRows() {
      const map = new Map();
      const ensure = identifier => {
        if (!map.has(identifier)) map.set(identifier, { identifier, p2fkItems: [], feedItems: [], hasP2fk: false, hasFeed: false, syncState: getSyncState(identifier) });
        return map.get(identifier);
      };
      S.p2fkItems.filter(item => item.identifier).forEach(item => {
        const row = ensure(item.identifier);
        row.p2fkItems.push(item);
        row.hasP2fk = true;
      });
      S.feedItems.filter(item => item.identifier).forEach(item => {
        const row = ensure(item.identifier);
        row.feedItems.push(item);
        row.hasFeed = true;
      });
      const rows = [...map.values()].sort((a, b) => {
        const aRank = a.hasFeed && !a.hasP2fk ? 0 : a.hasFeed && a.hasP2fk ? 1 : 2;
        const bRank = b.hasFeed && !b.hasP2fk ? 0 : b.hasFeed && b.hasP2fk ? 1 : 2;
        if (aRank !== bRank) return aRank - bRank;
        const aDate = parseTimestamp(a.feedItems[0]?.publishedAt || a.p2fkItems[0]?.blockDate);
        const bDate = parseTimestamp(b.feedItems[0]?.publishedAt || b.p2fkItems[0]?.blockDate);
        return bDate - aDate;
      });
      S.comparisonRows = rows;
      pruneSyncState();
      renderComparison();
    }

    async function refreshWalletBalances() {
      if (!S.keyring) {
        renderWalletInfo([]);
        return;
      }
      const entries = await Promise.all(S.keyring.all.map(async signer => ({ label: signer.label, addr: signer.addr, ...(await getBalance(signer.addr)) })));
      renderWalletInfo(entries);
      const totalConfirmed = entries.reduce((sum, item) => sum + item.confirmed, 0);
      setStatus('walletStatus', `Wallet unlocked as ${S.addr}. Confirmed available across main + change addresses: ${fmtTez(totalConfirmed)}.`, 'good');
    }

    async function unlockWallet() {
      try {
        const wif = $('wifInput').value;
        if (!norm(wif)) throw new Error('Enter a testnet3 WIF');
        const priv = await wif2priv(wif);
        const keyring = await buildKeyring(priv);
        S.priv = priv;
        S.keyring = keyring;
        S.addr = keyring.main.addr;
        appendLog(`Unlocked wallet ${S.addr}.`, 'good');
        await refreshWalletBalances();
      } catch (error) {
        appendLog(`Wallet unlock failed: ${error.message}`, 'bad');
        setStatus('walletStatus', error.message || 'Wallet unlock failed.', 'bad');
        throw error;
      }
    }

    function clearWallet() {
      S.priv = null;
      S.addr = '';
      S.keyring = null;
      renderWalletInfo([]);
      setStatus('walletStatus', 'Wallet is locked.', '');
      appendLog('Wallet cleared.');
    }

    async function analyze() {
      const keyword = cleanKeyword($('keywordInput').value);
      if (!keyword) {
        setStatus('analysisStatus', 'A p2fk keyword is required before scanning the feeds.', 'bad');
        return false;
      }
      setStatus('analysisStatus', 'Scanning the feeds and current p2fk keyword…');
      appendLog(`Starting feed scan for #${keyword}.`);
      try {
        S.keyword = keyword;
        const [p2fkItems, feedItems] = await Promise.all([loadP2fkItems(keyword), loadFeedItems()]);
        S.p2fkItems = p2fkItems;
        S.feedItems = feedItems;
        buildComparisonRows();
        S.lastCompletedScanAt = Date.now();
        const missing = S.comparisonRows.filter(row => row.hasFeed && !row.hasP2fk).length;
        setStatus('analysisStatus', `scan complete for #${keyword}. Loaded ${S.feedItems.length} stories and found ${missing} missing story(s) to etch.`, missing ? 'warn' : 'good');
        return true;
      } catch (error) {
        appendLog(`Analysis failed: ${error.message}`, 'bad');
        setStatus('analysisStatus', error.message || 'Analysis failed.', 'bad');
        return false;
      }
    }

    async function hasPendingWalletActivity() {
      if (!S.keyring) return false;
      if (S.nextScanTimer && !S.syncQueue.length) return false;
      const now = Date.now();
      if (S.lastBalanceCheckAt && now - S.lastBalanceCheckAt < BALANCE_CHECK_INTERVAL_MS) return S.lastPendingWalletActivity;
      const balances = await Promise.all(S.keyring.all.map(signer => getBalance(signer.addr)));
      const hasPending = balances.some(item => item.unconfirmed > 0 || item.mempoolSpent > 0);
      S.lastBalanceCheckAt = now;
      S.lastPendingWalletActivity = hasPending;
      return hasPending;
    }

    async function isLastBroadcastConfirmed() {
      if (!S.lastBroadcastTxid) return true;
      const res = await fetch(`${getMempoolApi()}/tx/${encodeURIComponent(S.lastBroadcastTxid)}/status`);
      if (!res.ok) return false;
      const payload = await res.json();
      return Boolean(payload?.confirmed);
    }

    function buildSyncText(row) {
      const article = row.feedItems[0];
      const prefix = sanitize($('messagePrefixInput').value);
      const articleLink = row.identifier;
      const title = norm(article?.title || '');
      const description = cleanArticleDescription(article?.description || '', title);
      let bodyText = stripLeadingHeadline(article?.fullText || '', title);
      if (bodyText && description) {
        const bodyNorm = normalizeLooseText(bodyText);
        const descNorm = normalizeLooseText(description);
        const closeLength = Math.abs(bodyNorm.length - descNorm.length) <= MAX_TEXT_LENGTH_VARIANCE;
        const effectivelySame = bodyNorm === descNorm
          || (bodyNorm.startsWith(descNorm) && closeLength)
          || (descNorm.startsWith(bodyNorm) && closeLength);
        if (bodyNorm && descNorm && effectivelySame) bodyText = '';
      }
      const bits = [];
      if (prefix) bits.push(prefix);
      if (title) bits.push(title);
      if (bodyText) bits.push(bodyText);
      else if (description && !isDuplicateHeadline(description, title)) bits.push(description);
      if (articleLink) bits.push(`Read more: <<${articleLink}>>`);
      if (article?.publishedAt) bits.push(`Published: ${article.publishedAt}`);
      bits.push(`#${S.keyword}`);
      return bits.filter(Boolean).join('\n\n');
    }

    function getArticleAttachments(article) {
      return article?.image ? [article.image] : [];
    }

    function hasOutstandingBroadcasts() {
      return (S.comparisonRows || []).some(row => getSyncState(row.identifier).status === 'broadcasted');
    }

    function scheduleNextScan(reason) {
      if (!S.syncRunning || S.nextScanTimer) return;
      const delay = getScanDelayMs();
      appendLog(`${reason}: next feed scan scheduled in ${Math.round(delay / 60000)} minute(s).`, 'good');
      S.nextScanTimer = setTimeout(async () => {
        S.nextScanTimer = null;
        await runScanAndQueue();
      }, delay);
      renderSummary();
    }

    async function syncArticle(identifier) {
      const row = (S.comparisonRows || []).find(item => item.identifier === identifier);
      if (!row || !row.hasFeed || row.hasP2fk) return;
      if (!S.keyring) {
        setStatus('analysisStatus', 'Unlock the wallet before etching stories.', 'bad');
        return;
      }
      setSyncState(identifier, { status: 'syncing', error: '' });
      try {
        let article = row.feedItems[0];

        // Fetch actual article link and text
        try {
          if (!article.sourceLink && article.rawDescription) {
            article.sourceLink = extractPreferredArticleLink(article.rawDescription);
          }
          const fetchedLinks = new Set();
          const preferredLink = getPreferredArticleLink(article);
          const unwrappedPreferredLink = unwrapGoogleNewsUrl(preferredLink);
          const unwrappedSourceLink = unwrapGoogleNewsUrl(article?.sourceLink);
          const unwrappedLink = unwrapGoogleNewsUrl(article?.link);
          const linkScore = (link) => {
            if (isApNewsUrl(link)) return LINK_PRIORITY_AP;
            if (isGoogleCall(link)) return LINK_PRIORITY_GOOGLE;
            return LINK_PRIORITY_OTHER;
          };
          const linkQueue = unique([
            unwrappedPreferredLink,
            unwrappedSourceLink,
            unwrappedLink,
            preferredLink,
            article?.sourceLink,
            article?.link,
          ].map(norm).filter(Boolean)).sort((a, b) => linkScore(a) - linkScore(b));
          if (linkQueue.length && !article.resolvedLink) article.resolvedLink = linkQueue[0];
          while (linkQueue.length && !article.fullText) {
            const currentLink = linkQueue.shift();
            if (!currentLink || fetchedLinks.has(currentLink)) continue;
            fetchedLinks.add(currentLink);
            const articleRes = await fetch(buildProxyUrl(currentLink));
            if (!articleRes.ok) continue;
            const articleText = await articleRes.text();
            let articleHtml = articleText;
            if (/^\s*\{/.test(articleText)) {
              try {
                const payload = JSON.parse(articleText);
                articleHtml = payload?.contents || payload?.content || payload?.html || '';
              } catch (error) {
                appendLog(`Warning: Failed to parse proxied payload for ${identifier}: ${error.message}`, 'warn');
              }
            }
            const canonicalLink = extractCanonicalLinkFromHtml(articleHtml);
            if (canonicalLink) {
              article.resolvedLink = canonicalLink;
              if (!fetchedLinks.has(canonicalLink)) {
                if (canonicalLink.includes('apnews.com')) linkQueue.unshift(canonicalLink);
                else linkQueue.push(canonicalLink);
              }
            }
            const discoveredApLink = extractApLinkFromHtml(articleHtml);
            if (discoveredApLink && !fetchedLinks.has(discoveredApLink)) linkQueue.unshift(discoveredApLink);
            const fullText = extractArticleBodyText(articleHtml);
            if (fullText) article.fullText = fullText;
          }
        } catch (e) {
          appendLog(`Warning: Failed to fetch full article text for ${identifier}: ${e.message}`, 'warn');
        }

        const outputs = await buildMsgOutputs({
          text: buildSyncText(row),
          attachments: getArticleAttachments(article),
          extras: [],
          fromAddr: S.addr,
        });
        appendLog(`Broadcasting story ${identifier} with ${outputs.length} outputs…`);
        const txid = await broadcastTx(outputs);
        S.lastBroadcastTxid = txid;
        setSyncState(identifier, { status: 'broadcasted', txid });
        appendLog(`Broadcasted ${identifier} in tx ${txid}.`, 'good');
      } catch (error) {
        appendLog(`Etch failed for ${identifier}: ${error.message}`, 'bad');
        setSyncState(identifier, { status: 'error', error: error.message || 'Etch failed' });
      }
    }

    function queueUnmatched() {
      const alreadyQueued = new Set(S.syncQueue);
      const queue = (S.comparisonRows || [])
        .filter(row => row.hasFeed && !row.hasP2fk)
        .filter(row => !['broadcasted', 'confirmed', 'syncing'].includes(getSyncState(row.identifier).status))
        .map(row => row.identifier)
        .filter(identifier => !alreadyQueued.has(identifier));
      S.syncQueue.push(...queue);
      queue.forEach(identifier => setSyncState(identifier, { status: 'queued' }));
      return queue.length;
    }

    async function runScanAndQueue() {
      if (!S.syncRunning) return;
      const ok = await analyze();
      if (!ok) return;
      const count = queueUnmatched();
      if (!count && !hasOutstandingBroadcasts()) {
        setStatus('analysisStatus', `No new stories are missing from #${S.keyword}. Waiting ${Math.round(getScanDelayMs() / 60000)} minute(s) for the next scan.`, 'good');
        scheduleNextScan('batch completed.');
        return;
      }
      if (count) {
        appendLog(`Queued ${count} missing story(s). Each story waits for full confirmation before the next etch.`, 'good');
        setStatus('analysisStatus', `Queued ${count} story(s) to etch for #${S.keyword}.`, 'warn');
      }
      await processAutoSync();
    }

    async function processAutoSync() {
      if (!S.syncRunning || S.syncBusy) return;
      if (!S.syncQueue.length) {
        if (!hasOutstandingBroadcasts()) scheduleNextScan('Abatch completed.');
        renderSummary();
        return;
      }
      S.syncBusy = true;
      try {
        if (!S.keyring) throw new Error('Unlock the wallet before auto archiving.');
        if (await hasPendingWalletActivity()) {
          appendLog('Waiting for wallet balances to confirm before etching the next story…', 'warn');
          return;
        }
        if (!(await isLastBroadcastConfirmed())) {
          appendLog(`Waiting for tx ${S.lastBroadcastTxid} to fully confirm before etching the next story…`, 'warn');
          return;
        }
        const nextIdentifier = S.syncQueue.shift();
        if (!nextIdentifier) return;
        await syncArticle(nextIdentifier);
        const state = getSyncState(nextIdentifier);
        if (state.status === 'broadcasted' && S.lastBroadcastTxid) appendLog('The next story will only etch after this broadcast confirms.', 'warn');
      } catch (error) {
        appendLog(`Auto archive error: ${error.message}`, 'bad');
      } finally {
        S.syncBusy = false;
        renderSummary();
      }
    }

    async function startAutoSync() {
      if (!S.keyring) {
        setStatus('analysisStatus', 'Unlock the wallet before starting auto archive.', 'bad');
        return;
      }
      if (S.syncTimer) clearInterval(S.syncTimer);
      if (S.nextScanTimer) clearTimeout(S.nextScanTimer);
      S.syncQueue = [];
      S.syncRunning = true;
      S.nextScanTimer = null;
      S.lastBalanceCheckAt = 0;
      S.lastPendingWalletActivity = false;
      S.syncTimer = setInterval(() => {
        refreshConfirmationStates().catch(() => {});
        processAutoSync().catch(() => {});
      }, 60000);
      appendLog(`Auto archive started. The first scan runs now and later scans only happen ${Math.round(getScanDelayMs() / 60000)} minute(s) after a full batch finishes.`, 'good');
      await runScanAndQueue();
    }

    function stopAutoSync() {
      S.syncRunning = false;
      if (S.syncTimer) clearInterval(S.syncTimer);
      if (S.nextScanTimer) clearTimeout(S.nextScanTimer);
      S.syncTimer = null;
      S.nextScanTimer = null;
      S.syncQueue = [];
      S.lastBalanceCheckAt = 0;
      S.lastPendingWalletActivity = false;
      appendLog('Auto archive stopped.');
      setStatus('analysisStatus', 'Auto archive stopped.', 'warn');
      renderSummary();
    }

    async function refreshConfirmationStates() {
      const broadcasted = (S.comparisonRows || []).filter(row => getSyncState(row.identifier).status === 'broadcasted');
      if (!broadcasted.length) return;
      for (const row of broadcasted) {
        const state = getSyncState(row.identifier);
        if (!state.txid) continue;
        try {
          const res = await fetch(`${getMempoolApi()}/tx/${encodeURIComponent(state.txid)}/status`);
          if (!res.ok) continue;
          const payload = await res.json();
          if (payload?.confirmed) {
            setSyncState(row.identifier, { status: 'confirmed' });
            row.hasP2fk = true;
            S.p2fkItems.push({
              identifier: row.identifier,
              txId: state.txid,
              message: buildSyncText(row),
              fromAddr: S.addr,
              blockDate: new Date().toISOString(),
              rawRoot: null,
            });
            appendLog(`Confirmed sync tx ${state.txid} for ${row.identifier}.`, 'good');
          }
        } catch {}
      }
      renderComparison();
      if (S.syncRunning && !S.syncQueue.length && !hasOutstandingBroadcasts()) scheduleNextScan('batch completed.');
    }

    $('unlockBtn').addEventListener('click', () => unlockWallet().catch(() => {}));
    $('refreshWalletBtn').addEventListener('click', () => refreshWalletBalances().catch(err => setStatus('walletStatus', err.message || 'Balance refresh failed.', 'bad')));
    $('clearWalletBtn').addEventListener('click', clearWallet);
    $('analyzeBtn').addEventListener('click', () => analyze().catch(() => {}));
    $('startSyncBtn').addEventListener('click', () => startAutoSync().catch(err => {
      appendLog(`Auto archive failed to start: ${err.message}`, 'bad');
      setStatus('analysisStatus', err.message || 'Auto archive failed to start.', 'bad');
    }));
    $('stopSyncBtn').addEventListener('click', stopAutoSync);

    setInterval(() => refreshConfirmationStates().catch(() => {}), 60000);
    renderWalletInfo([]);
    renderSummary();
    appendLog('APNewsArchive ready.');

    window.APNewsArchiveApp = {
      state: S,
      analyze,
      unlockWallet,
      syncArticle,
      startAutoSync,
      stopAutoSync,
      buildComparisonRows,
      parseMsg,
      loadP2fkItems,
      loadFeedItems,
    };
  })();
