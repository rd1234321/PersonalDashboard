// =============================================================
// Wraps the real Supabase client so reads/writes to the `app_state`
// table are routed through this dashboard's own session-gated proxy
// (/api/data-get, /api/data-set) instead of talking to Supabase
// directly with the public anon key. Everything else (Supabase
// Storage, used for progress-photo uploads) still goes through the
// real client unchanged — photo URLs are already public-by-design,
// this is only about the personal data living in `app_state`.
//
// Every existing page keeps calling window.supabase.createClient(...)
// and .from('app_state')... exactly as before; this file only changes
// what happens underneath that call, so sync.js / topbar.js / gym.html
// / health.html didn't need to be rewritten.
//
// Load this AFTER the supabase-js CDN script and BEFORE sync.js/
// topbar.js (i.e. right next to the CDN <script> tag, not deferred).
// =============================================================
(function () {
  'use strict';
  if (!window.supabase || !window.supabase.createClient) return;

  const realCreateClient = window.supabase.createClient;
  const POLL_MS = 8000; // no more realtime websocket (RLS denies anon now) — poll instead

  function proxyGet(key) {
    return fetch('/api/data-get?key=' + encodeURIComponent(key), { credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.error) return { data: null, error: j.error };
        return { data: { data: j ? j.data : null }, error: null };
      })
      .catch(function (e) { return { data: null, error: e }; });
  }
  function proxySet(key, data) {
    return fetch('/api/data-set', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, data: data }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { return { error: j && j.error ? j.error : null }; })
      .catch(function (e) { return { error: e }; });
  }

  window.supabase.createClient = function (url, anonKey) {
    const real = realCreateClient(url, anonKey);

    function wrappedFrom(table) {
      if (table !== 'app_state') return real.from(table);
      let filterKey = null;
      const builder = {
        select: function () { return builder; },
        eq: function (col, val) { if (col === 'key') filterKey = val; return builder; },
        maybeSingle: function () { return proxyGet(filterKey); },
        upsert: function (obj) { return proxySet(obj && obj.key, obj && obj.data); },
      };
      return builder;
    }

    function wrappedChannel(name) {
      let cb = null, watchKey = null, timer = null, lastJson = null;
      const chan = {
        on: function (event, opts, handler) {
          cb = handler;
          watchKey = (opts && opts.filter && opts.filter.indexOf('eq.') !== -1)
            ? opts.filter.split('eq.')[1]
            : null;
          return chan;
        },
        subscribe: function () {
          if (timer) clearInterval(timer);
          timer = setInterval(function () {
            if (!cb || !watchKey) return;
            proxyGet(watchKey).then(function (res) {
              if (!res || !res.data || res.data.data == null) return;
              const json = JSON.stringify(res.data.data);
              if (json === lastJson) return;
              lastJson = json;
              cb({ new: { data: res.data.data } });
            });
          }, POLL_MS);
          return chan;
        },
        unsubscribe: function () { if (timer) clearInterval(timer); },
      };
      return chan;
    }

    // Copy the real client's own properties/methods (storage, auth, ...)
    // onto a plain object, then override just `from` and `channel`.
    const wrapped = Object.create(Object.getPrototypeOf(real));
    Object.assign(wrapped, real);
    wrapped.from = wrappedFrom;
    wrapped.channel = wrappedChannel;
    return wrapped;
  };
})();
