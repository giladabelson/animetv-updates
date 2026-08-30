/* Anime TV — Cinema mode (injected into every watch page after onPageFinished)
 * ===========================================================================
 * Goal: get the episode the user picked playing, full-screen, with the site's
 * furniture hidden — without the remote having to act as a mouse.
 *
 * ES5 ONLY. Target is a frozen system WebView (Chromium ~51) on Android 7-12.
 * No let/const, arrow functions, template literals, Promise, fetch, includes(),
 * startsWith(), Object.assign, Array.from. MutationObserver + TreeWalker are OK.
 * Everything is wrapped in try/catch: a thrown error means the user is left
 * staring at a raw fansub page.
 *
 * ---------------------------------------------------------------------------
 * NATIVE CONTRACT  (PlayerActivity.java must match this)
 * ---------------------------------------------------------------------------
 * INPUT
 *   window.__ATV_EP : number   episode the user picked. Set BEFORE this file is
 *                              evaluated. 0/absent = "whatever is on the page".
 *
 * CALLS OUT — window.PlayerBridge.*  (each guarded by a typeof check, so the
 * script also runs in a plain browser during testing)
 *
 *   onCinema(String kind)            'video' | 'frame' | 'none'
 *                                    Fired when a player is promoted (or lost).
 *                                    NOT fired when we decline to promote.
 *   onTarget(int ep, String how)     Fired once we settle. how is one of:
 *                                      'fn'       called the page's own myFunctionN()
 *                                      'click'    clicked the page's own "פרק N" control
 *                                      'label'    matched a player tagged "פרק N"
 *                                      'position' Nth player on the page (no labels)
 *                                      'guess'    single/biggest player, episode unconfirmed
 *                                      'none'     episode N is NOT on this page; nothing promoted
 *                                    'none' means the page was left untouched and usable —
 *                                    show the cursor and let the user pick manually.
 *                                    'guess' is normal for one-episode-per-URL sites.
 *                                    May fire a second time after a 'none' if a late
 *                                    scan succeeds, and again after __atvNext().
 *   onProgress(int cur, int dur)     Same-origin <video> only. Throttled to at most
 *                                    once per 2000 ms. dur <= 0 means unknown/live.
 *                                    Use this to show "פרק הבא" only near the end.
 *   onNoProgress()                   Fired ONCE when the player is a cross-origin
 *                                    iframe: there is no progress to read, native
 *                                    must fall back to a timer.
 *   onEnded()                        Same-origin <video> reached its end.
 *   tapCenter()                      Ask native to inject a real MotionEvent — a
 *                                    genuine user gesture. Cross-origin players
 *                                    only start on one. Prefer tapping the centre
 *                                    of __atvPlayerRect() over the screen centre.
 *                                    We ask at most 3 times per page.
 *
 * CALLS IN — window.__atv*  (native uses WebView.evaluateJavascript)
 *
 *   __atvToggle()      -> int   1 = play/pause handled here (same-origin <video>)
 *                               2 = cannot reach the player; native must act —
 *                                   call __atvFocusPlayer() then send Space /
 *                                   KEYCODE_MEDIA_PLAY_PAUSE, or tap the rect.
 *                               0 = nothing is playing.
 *                               Has no side effects; safe to call any time.
 *   __atvSeek(delta)   -> int   delta in seconds (may be negative).
 *                               1 = seeked (same-origin <video>, clamped to
 *                                   [0, duration-1]).
 *                               0 = cannot seek; native should send DPAD_LEFT/RIGHT
 *                                   into the embedded player instead.
 *   __atvPlayerRect()  -> String "x,y,w,h" of the promoted element in CSS pixels
 *                               relative to the WebView viewport, rounded.
 *                               "" when nothing is promoted. Multiply by the
 *                               WebView's device scale before dispatching a
 *                               MotionEvent.
 *   __atvFocusPlayer() -> int   1 = focused the promoted iframe/video, so a
 *                                   subsequent native key event is delivered into
 *                                   the embedded player's document (Drive and most
 *                                   HTML5 players respond to Space / K).
 *                               0 = nothing to focus.
 *   __atvNext()        -> int   1 = this page can switch to episode N+1 in place;
 *                                   the switch has been triggered and the promoted
 *                                   element will show it (onTarget fires again).
 *                                   DO NOT navigate.
 *                               0 = native must load the next episode's URL.
 *
 * All __atv* functions are total: they never throw and always return an int
 * (or a string for __atvPlayerRect).
 *
 * ---------------------------------------------------------------------------
 * PAGE SHAPES WE HANDLE  (animeisrael.co.il / onepiece-nakama.com, verified)
 * ---------------------------------------------------------------------------
 *  SWITCHER  one <iframe src=".../file/d/<ID>/preview"> plus a row of
 *            <button onclick="myFunctionN()">פרק N</button>. The buttons swap
 *            that single iframe's src. Promoting the iframe as-is silently plays
 *            episode 1 no matter what the user picked — the bug this fixes.
 *  STACKED   one drive iframe per episode already in the document, each preceded
 *            by a "פרק N" label.
 *  LOCKED    poster + "לחצו לצפייה" overlay; the iframe is only injected into the
 *            DOM once the overlay is clicked.
 *
 * TARGETING STRATEGY ORDER (stop at the first that produces a confirmed player):
 *   a 'fn'       window['myFunction'+N]()  — the site's own API, most reliable
 *   b 'click'    click the element whose own text is exactly "פרק N"
 *   c 'label' /  positional + label match among players already in the document
 *     'position'
 *   d unlock     click a click-to-load overlay, then re-run from (a)
 * After (a)/(b) the DOM changes asynchronously, so we snapshot every iframe src
 * first and then watch (poll + MutationObserver) for a changed or new player.
 * We never promote a player we have not confirmed is episode N when targeting
 * was possible — we report 'none' instead and leave the page alone.
 */
(function () {
  try {
    if (window.__atvCinema) { return; }
    window.__atvCinema = 1;
  } catch (eGuard) { return; }

  /* ---------------------------------------------------------------- config */

  var SETTLE_MS = 1500;      /* accept a single-player page after this long */
  var MAX_WAIT_MS = 6000;    /* give up on a triggered switch after this long */
  var PROGRESS_MS = 2000;    /* onProgress throttle */
  var TICK_FAST = 400;
  var TICK_SLOW = 1000;
  var TICK_LIMIT = 70;       /* ~60 s of scanning */
  var MAX_NODES = 8000;
  var FN_PROBE_MAX = 80;     /* how far up we probe for window.myFunctionK */

  /* Known player hosts. Matched against the iframe's HOST only, so a script
     called "adplayer.js" cannot smuggle itself in through the "player" token. */
  var PLAYER_HOSTS = [
    'drive.google.com', 'docs.google.com', 'photos.google.com', 'blogger.com',
    'mega.nz', 'mega.io', 'mp4upload', 'dood', 'vidmoly', 'streamtape',
    'filemoon', 'streamwish', 'uqload', 'vidsrc', 'sibnet', 'ok.ru', 'vk.com',
    'archive.org', 'videa', 'fembed', 'yourupload', 'gdriveplayer'
  ];
  /* Weaker hints: these only qualify a frame that is ALSO video-shaped. */
  var PATH_HINTS = ['/embed', '/preview', '/player', 'videoembed', 'embed.php'];

  var BAD_HOSTS = [
    'doubleclick', 'googlesyndication', 'adservice', 'adnxs', 'exoclick',
    'juicyads', 'popads', 'poptm', 'propeller', 'taboola', 'outbrain',
    'hilltopads', 'adsterra', 'clickadu', 'mgid', 'revcontent', 'trafficjunky',
    'facebook', 'disqus', 'twitter', 'instagram', 'recaptcha', 'tawk',
    'chatango', 'histats', 'analytics', 'onesignal', 'googletagmanager'
  ];
  /* id/class/name that mark an ad slot even on an innocent-looking host. */
  var AD_ATTR_RE = /(^|[-_])(ads?|adv|advert|banner|sponsor|promo)([-_\d]|$)|google_ads|adslot|adzone|aswift/i;

  /* Standard IAB units. Whatever we promote may receive a REAL synthetic touch
     from native, so clicking an ad is a genuinely bad outcome. */
  var AD_SIZES = [
    [300, 250], [336, 280], [320, 50], [320, 100], [300, 600], [300, 100],
    [250, 250], [200, 200], [180, 150], [125, 125], [160, 600], [120, 600],
    [120, 240], [240, 400], [234, 60], [468, 60], [728, 90], [970, 90],
    [970, 250], [750, 100], [750, 200], [320, 480], [480, 320]
  ];

  /* "לחצו לצפייה" and friends. Deliberately narrow: it must not match the view
     counter ("5,796 צפיות") or the source switcher (MEGA / Google Drive). */
  var WATCH_RE = /(לחצו|לחץ|לחצי)\s*(כאן\s*)?(לצפי|להפעל|לנגן)|^\s*לצפייה\s*$|^\s*לצפיה\s*$|^\s*(play|watch now|click to play)\s*$/i;
  var PLAY_ATTR_RE = /(^|[-_ ])(play|watch|start)([-_ ]|$)|playbtn|play-button|play_button|bigplay/i;
  /* Never treat these as an unlock button, whatever else they look like. */
  var NOT_UNLOCK_RE = /צפיות|\bviews\b|^\s*(mega|mega\.nz|google\s*drive|drive|גוגל\s*דרייב|שרת\s*\d*|מקור\s*\d*|server\s*\d*)\s*$/i;

  /* Bidi marks and friends that the site sprinkles around "פרק 5". */
  var MARK_RE = /[‎‏؜‪-‮⁦-⁩​﻿]/g;
  /* Exact episode control text: "פרק 5", "‏פרק  05", "פרק 5 -", "פרק 5:" */
  var EP_EXACT_RE = /^פרק\s*0*(\d{1,4})(?!\d)\s*[-–—:.|•)\]]?\s*$/;
  /* Episode label anywhere inside a run of text. */
  var EP_ANY_RE = /פרק\s*0*(\d{1,4})(?!\d)/;

  /* ----------------------------------------------------------------- state */

  var EP = 0;
  try {
    if (typeof window.__ATV_EP === 'number') { EP = window.__ATV_EP; }
    else if (typeof window.__ATV_EP === 'string') { EP = parseInt(window.__ATV_EP, 10) || 0; }
  } catch (eEp) { EP = 0; }
  if (!(EP > 0)) { EP = 0; }

  var engaged = null;        /* element currently promoted */
  var engagedKind = '';      /* 'player' | 'placeholder' */
  var staged = [];           /* every element we gave __atvStage to (player + ancestors) */
  var mode = 0;              /* 1 = <video>, 2 = player iframe */
  var tries = 0;
  var looping = false;
  var timer = null;
  var tapAsks = 0;
  var unlockTries = 0;
  var unlockedSomething = false;
  var styleEl = null;
  var observer = null;

  var usedFn = false;        /* strategy (a) already attempted for this EP */
  var usedClick = false;     /* strategy (b) already attempted for this EP */
  var wait = null;           /* pending switch: see beginWait() */

  var targetReported = '';   /* last `how` handed to onTarget */
  var targetFinal = false;   /* a real player was reported; never downgrade to 'none' */
  var noProgressSent = false;
  var lastProgressAt = 0;

  /* ------------------------------------------------------------- utilities */

  function bridge(fn, a, b) {
    try {
      var br = window.PlayerBridge;
      if (!br || typeof br[fn] !== 'function') { return false; }
      if (a === undefined) { br[fn](); }
      else if (b === undefined) { br[fn](a); }
      else { br[fn](a, b); }
      return true;
    } catch (e) { return false; }
  }

  function now() {
    try { return (new Date()).getTime(); } catch (e) { return 0; }
  }

  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

  function hasToken(hay, needles) {
    var s = lower(hay);
    if (!s) { return false; }
    for (var i = 0; i < needles.length; i++) {
      if (s.indexOf(needles[i]) !== -1) { return true; }
    }
    return false;
  }

  function classOf(el) {
    try {
      var c = el.className;
      if (c && typeof c === 'object' && c.baseVal !== undefined) { return c.baseVal; }
      return typeof c === 'string' ? c : '';
    } catch (e) { return ''; }
  }

  function attr(el, name) {
    try { return (el && el.getAttribute) ? (el.getAttribute(name) || '') : ''; }
    catch (e) { return ''; }
  }

  /* Text that belongs to this element directly, not to its descendants. */
  function ownText(el) {
    var out = '';
    try {
      var kids = el.childNodes;
      if (!kids) { return ''; }
      for (var i = 0; i < kids.length && out.length < 160; i++) {
        if (kids[i].nodeType === 3) { out += kids[i].nodeValue; }
      }
    } catch (e) { return ''; }
    return out;
  }

  /* Strip bidi marks, fold nbsp + runs of whitespace, trim. */
  function normText(t) {
    return String(t == null ? '' : t)
      .replace(MARK_RE, '')
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^ +| +$/g, '');
  }

  function rectOf(el) {
    try { return el.getBoundingClientRect(); } catch (e) { return null; }
  }

  function areaOf(el) {
    var r = rectOf(el);
    if (!r) { return 0; }
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  function viewport() {
    var w = 0, h = 0;
    try {
      w = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
      h = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    } catch (e) {}
    return { w: w, h: h };
  }

  function inDoc(el) {
    try { return !!(el && document.body && document.body.contains(el)); }
    catch (e) { return false; }
  }

  function hostOf(src) {
    var m = /^(?:[a-z][a-z0-9+.\-]*:)?\/\/([^\/?#]+)/i.exec(String(src || ''));
    return m ? lower(m[1]) : '';
  }

  function frameSig(el) {
    var a = attr(el, 'src') || attr(el, 'data-src') || attr(el, 'data-litespeed-src') || '';
    var b = '';
    try { b = el.src || ''; } catch (e) {}
    return a + '|' + b;
  }

  function frameSrc(el) {
    var a = attr(el, 'src');
    if (a) { return a; }
    try { if (el.src) { return el.src; } } catch (e) {}
    return attr(el, 'data-src') || attr(el, 'data-litespeed-src') || '';
  }

  /* ------------------------------------------------------- player sniffing */

  function boxOf(el) {
    var r = rectOf(el);
    var w = r ? r.width : 0, h = r ? r.height : 0;
    if (!w || !h) {
      w = parseInt(attr(el, 'width'), 10) || 0;
      h = parseInt(attr(el, 'height'), 10) || 0;
    }
    return { w: w, h: h };
  }

  function isAdSize(w, h) {
    for (var i = 0; i < AD_SIZES.length; i++) {
      if (Math.abs(w - AD_SIZES[i][0]) <= 3 && Math.abs(h - AD_SIZES[i][1]) <= 3) { return true; }
    }
    return false;
  }

  function looksLikeAd(el) {
    var bag = classOf(el) + ' ' + attr(el, 'id') + ' ' + attr(el, 'name') + ' ' + attr(el, 'data-ad');
    return AD_ATTR_RE.test(bag);
  }

  /* An unknown iframe is only treated as a player when it is big enough and not
     a standard ad unit. The aspect window is deliberately wide (0.9 .. 5.0):
     animeisrael sizes its drive frame 1009x320, ratio 3.15, and rejecting that
     for being "oddly shaped" is how a real player gets thrown away. The ad
     defence is the explicit IAB size list plus the minimum box, not the ratio. */
  function videoShaped(el) {
    var b = boxOf(el);
    if (b.w < 320 || b.h < 160) { return false; }
    if (b.w * b.h < 50000) { return false; }
    if (isAdSize(b.w, b.h)) { return false; }
    var ratio = b.w / b.h;
    return ratio >= 0.9 && ratio <= 5.0;
  }

  function isPlayerFrame(el) {
    var src = frameSrc(el);
    if (!src) { return false; }
    var low = lower(src);
    if (low.indexOf('about:blank') === 0 || low.indexOf('javascript:') === 0) { return false; }
    if (low.indexOf('data:') === 0) { return false; }
    if (looksLikeAd(el)) { return false; }
    var host = hostOf(src);
    if (host && hasToken(host, BAD_HOSTS)) { return false; }
    if (hasToken(src, BAD_HOSTS)) { return false; }
    if (host && hasToken(host, PLAYER_HOSTS)) {
      /* Known player host: trust it whatever the site did to its box, but a
         1x1 frame on a player host is a tracking pixel, not the episode. */
      var b = boxOf(el);
      return (b.w >= 80 && b.h >= 60) || (!b.w && !b.h);
    }
    if (hasToken(src, PATH_HINTS)) { return videoShaped(el); }
    if (el.hasAttribute && (el.hasAttribute('allowfullscreen') || el.hasAttribute('allowFullScreen'))) {
      return videoShaped(el);
    }
    return videoShaped(el) && areaOf(el) > 90000;
  }

  function isRealVideo(el) {
    try {
      if (!el) { return false; }
      return !!(el.currentSrc || el.src || el.getAttribute('src') || el.querySelector('source'));
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------ page-switcher API */

  function getFn(n) {
    if (!(n > 0)) { return null; }
    try {
      var f = window['myFunction' + n];
      if (typeof f === 'function') { return f; }
    } catch (e) {}
    return null;
  }

  /* Does this page expose a switcher API at all? Used as evidence that the page
     enumerates episodes, so a miss means "episode not here" and not "just play
     whatever". We never call the bare myFunction() — on animeisrael's catalog
     page that is a list-sorting helper, nothing to do with episodes. */
  function switcherSeen() {
    try {
      for (var k = 1; k <= FN_PROBE_MAX; k++) {
        if (typeof window['myFunction' + k] === 'function') { return true; }
      }
      if (EP > FN_PROBE_MAX && typeof window['myFunction' + EP] === 'function') { return true; }
    } catch (e) {}
    return false;
  }

  /* Pull the target URL (or the drive file id) out of a switcher function body
     or an onclick attribute, so we can positively confirm the swap happened.
     A hint is only worth anything if it identifies ONE episode. A page whose
     switchers are built in a loop —
        function (){ frame.src = 'https://drive.google.com/file/d/' + IDS[n] }
     — yields the bare prefix, which matches episode 1's src just as happily as
     episode 12's. Confirming on that is exactly the silent-wrong-episode bug,
     so a non-discriminating hint is thrown away and we fall back to watching
     for the src to actually change. */
  function usefulHint(h) {
    if (!h) { return ''; }
    if (h.charAt(h.length - 1) === '/') { return ''; }   /* bare prefix */
    if (h.length < 6) { return ''; }
    return h;
  }

  function hintFrom(text) {
    var s = String(text || '');
    if (!s) { return ''; }
    var m = /\/file\/d\/([A-Za-z0-9_\-]{8,})/.exec(s);
    if (m) { return usefulHint(m[1]); }
    m = /https?:\\?\/\\?\/[^'"\s\\)>]{10,}/.exec(s);
    if (m) { return usefulHint(m[0].replace(/\\/g, '')); }
    return '';
  }

  function rawFnHint(n) {
    var f = getFn(n);
    if (!f) { return ''; }
    try { return hintFrom(String(f)); } catch (e) { return ''; }
  }

  function fnHint(n) {
    var h = rawFnHint(n);
    if (!h) { return ''; }
    /* If a different episode's switcher yields the same hint, the hint is the
       shared prefix of a generated URL and confirms nothing. */
    var probes = [n - 1, n + 1, 1, 2];
    for (var i = 0; i < probes.length; i++) {
      var p = probes[i];
      if (p === n || p < 1) { continue; }
      var other = rawFnHint(p);
      if (other && other === h) { return ''; }
    }
    return h;
  }

  /* --------------------------------------------------- "פרק N" control hunt */

  function scoreControl(el, n) {
    var score = 0;
    var tag = el.tagName;
    var onclick = attr(el, 'onclick');
    if (onclick) { score += 3; }
    try {
      if (onclick && (new RegExp('(^|[^0-9])' + n + '([^0-9]|$)')).test(onclick)) { score += 4; }
    } catch (e) {}
    try { if (el.onclick) { score += 3; } } catch (e) {}
    if (tag === 'BUTTON') { score += 3; }
    else if (tag === 'A') { score += 2; }
    if (lower(attr(el, 'role')) === 'button') { score += 2; }
    var bag = classOf(el) + ' ' + attr(el, 'id');
    if (/btn|button|tab|episode|ep-|epis/i.test(bag)) { score += 1; }
    /* A link that navigates somewhere else is not an in-page switcher — native
       already loaded the URL it wanted, so following it would be a step back. */
    if (tag === 'A') {
      var href = attr(el, 'href');
      if (href && href.charAt(0) !== '#' && lower(href).indexOf('javascript:') !== 0) { score -= 4; }
    }
    try {
      if (window.getComputedStyle && window.getComputedStyle(el).cursor === 'pointer') { score += 1; }
    } catch (e) {}
    return score;
  }

  /* The element a human would press for episode n. Returns null when nothing on
     the page is actually actionable — a bare <h3>פרק 7</h3> caption on a stacked
     page must NOT send us into a six-second wait for a switch that never comes. */
  function findControl(n) {
    if (!(n > 0) || !document.body) { return null; }
    var best = null, bestScore = -1;
    var all;
    try { all = document.body.getElementsByTagName('*'); } catch (e) { return null; }
    var lim = Math.min(all.length, MAX_NODES);
    for (var i = 0; i < lim; i++) {
      var el = all[i];
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'OPTION') { continue; }
      var t = normText(ownText(el));
      if (!t || t.length > 24) { continue; }
      var m = EP_EXACT_RE.exec(t);
      if (!m || parseInt(m[1], 10) !== n) { continue; }
      var s = scoreControl(el, n);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    if (!best || bestScore < 2) { return null; }
    return { el: best, score: bestScore, strong: bestScore >= 4 };
  }

  function controlCount() {
    /* How many episodes does this page offer as a pressable control? Any number
       above zero means the page enumerates episodes, so a miss is a real miss. */
    if (!document.body) { return 0; }
    var all, c = 0;
    try { all = document.body.getElementsByTagName('*'); } catch (e) { return 0; }
    var lim = Math.min(all.length, MAX_NODES);
    for (var i = 0; i < lim; i++) {
      var el = all[i];
      var tag = el.tagName;
      if (tag !== 'BUTTON' && tag !== 'A' && tag !== 'LI' && tag !== 'SPAN' && tag !== 'DIV') { continue; }
      var t = normText(ownText(el));
      if (!t || t.length > 24) { continue; }
      var m = EP_EXACT_RE.exec(t);
      if (!m) { continue; }
      if (scoreControl(el, parseInt(m[1], 10)) >= 2) { c++; }
    }
    return c;
  }

  function clickEl(el) {
    try { el.click(); return true; } catch (e) {}
    try {
      var ev = document.createEvent('MouseEvents');
      ev.initEvent('click', true, true);
      el.dispatchEvent(ev);
      return true;
    } catch (e2) {}
    return false;
  }

  /* ------------------------------------------------------------------ scan */

  /* One pass over the document collects the players, the episode label that
     precedes each, every episode number mentioned, and click-to-load buttons. */
  function scan() {
    var out = { players: [], unlocks: [], epNums: {}, epCount: 0 };
    if (!document.body) { return out; }
    var lastEp = 0;
    var walker;
    try {
      walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
    } catch (e) { return out; }
    var n, seen = 0;
    while ((n = walker.nextNode()) && seen++ < MAX_NODES) {
      var tag = n.tagName;
      if (tag === 'VIDEO') {
        if (isRealVideo(n)) { out.players.push({ el: n, ep: lastEp, tag: 'VIDEO' }); }
        continue;
      }
      if (tag === 'IFRAME') {
        if (isPlayerFrame(n)) { out.players.push({ el: n, ep: lastEp, tag: 'IFRAME' }); }
        continue;
      }
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') { continue; }

      var raw = ownText(n);
      if (!raw) { continue; }
      var t = normText(raw);
      if (!t) { continue; }
      var m = EP_ANY_RE.exec(t);
      if (m) {
        var v = parseInt(m[1], 10);
        if (v > 0 && v < 5000) {
          lastEp = v;
          if (!out.epNums[v]) { out.epNums[v] = 1; out.epCount++; }
        }
      }
      if (NOT_UNLOCK_RE.test(t)) { continue; }
      if (WATCH_RE.test(t) && areaOf(n) > 400) {
        out.unlocks.push({ el: n, rank: 0 });
        continue;
      }
      var bag = classOf(n) + ' ' + attr(n, 'id');
      if (PLAY_ATTR_RE.test(bag) && areaOf(n) >= 1600) {
        out.unlocks.push({ el: n, rank: 1 });
      }
    }
    /* Elements with no own text at all (an icon-only play button) still need to
       be considered for unlocking. Cheap second pass over likely candidates. */
    try {
      var cand = document.body.getElementsByTagName('*');
      var lim2 = Math.min(cand.length, MAX_NODES);
      for (var i = 0; i < lim2; i++) {
        var c = cand[i];
        if (c.tagName === 'SCRIPT' || c.tagName === 'STYLE') { continue; }
        if (normText(ownText(c))) { continue; }
        var bag2 = classOf(c) + ' ' + attr(c, 'id');
        if (PLAY_ATTR_RE.test(bag2) && areaOf(c) >= 1600) {
          out.unlocks.push({ el: c, rank: 1 });
        }
      }
    } catch (e2) {}
    return out;
  }

  function splitPlayers(players) {
    var vids = [], frames = [], i;
    for (i = 0; i < players.length; i++) {
      if (players[i].tag === 'VIDEO') { vids.push(players[i]); } else { frames.push(players[i]); }
    }
    return vids.length ? vids : frames;
  }

  function largest(list) {
    var best = list[0], bestA = areaOf(list[0].el);
    for (var i = 1; i < list.length; i++) {
      var a = areaOf(list[i].el);
      if (a > bestA) { best = list[i]; bestA = a; }
    }
    return best;
  }

  /* Strategy (c). Returns { cand, how }. cand === null means "episode N is not
     on this page" — we must NOT promote anything, because a wrong pick that
     looks like it worked is worse than an error. */
  function decide(s) {
    var list = splitPlayers(s.players);
    if (!list.length) { return { cand: null, how: 'none' }; }

    var labeled = 0, i;
    for (i = 0; i < list.length; i++) { if (list[i].ep > 0) { labeled++; } }

    if (EP > 0) {
      for (i = 0; i < list.length; i++) {
        if (list[i].ep === EP) { return { cand: list[i], how: 'label' }; }
      }
      if (labeled === 0 && list.length > 1 && EP <= list.length) {
        return { cand: list[EP - 1], how: 'position' };
      }
      /* Does the page enumerate episodes? If it does, and none of them is N,
         then N genuinely is not here. This is the switcher/ep-99 case. */
      var evidence = (s.controls > 0) || (labeled >= 2) || s.switcher;
      if (evidence) { return { cand: null, how: 'none' }; }
      /* No enumeration: one episode per URL, native already picked the URL.
         If the page happens to name episode N anywhere, take that as proof. */
      if (list.length === 1 && s.epNums[EP]) { return { cand: list[0], how: 'label' }; }
    }
    return { cand: largest(list), how: 'guess' };
  }

  /* -------------------------------------------------------------- promotion */

  function installStyle() {
    try {
      if (styleEl && styleEl.parentNode) { return; }
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-atv', '1');
      styleEl.appendChild(document.createTextNode(
        'html,body{margin:0 !important;padding:0 !important;background:#000 !important;' +
        'overflow:hidden !important;height:100% !important;}' +
        '.__atvHide{display:none !important;}' +
        '.__atvStage{position:fixed !important;top:0 !important;left:0 !important;' +
        'right:0 !important;bottom:0 !important;width:100% !important;height:100% !important;' +
        'min-width:0 !important;min-height:0 !important;max-width:none !important;' +
        'max-height:none !important;margin:0 !important;padding:0 !important;border:0 !important;' +
        'z-index:2147483647 !important;background:#000 !important;' +
        'opacity:1 !important;visibility:visible !important;transform:none !important;' +
        'clip:auto !important;overflow:visible !important;}' +
        'video.__atvStage{object-fit:contain !important;}'));
      (document.head || document.documentElement).appendChild(styleEl);
    } catch (e) {}
  }

  /* Hide everything except the player and its ancestors. The player itself is
     never moved in the DOM — moving an iframe reloads it. */
  function hideAround(el) {
    var node = el, guard = 0;
    while (node && node !== document.body && guard++ < 80) {
      var p = node.parentNode;
      if (p && p.children) {
        for (var i = 0; i < p.children.length; i++) {
          var c = p.children[i];
          if (c !== node && c !== styleEl && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE') {
            try { c.classList.add('__atvHide'); } catch (e) {}
          }
        }
      }
      node = p;
    }
  }

  function unhideAll() {
    try {
      var hidden = document.querySelectorAll('.__atvHide');
      for (var i = 0; i < hidden.length; i++) {
        try { hidden[i].classList.remove('__atvHide'); } catch (e) {}
      }
    } catch (e2) {}
  }

  var STAGE_CSS = {
    position: 'fixed', top: '0px', left: '0px', right: '0px', bottom: '0px',
    width: '100%', height: '100%', 'max-width': 'none', 'max-height': 'none',
    'min-width': '0', 'min-height': '0', margin: '0', padding: '0',
    border: '0', 'z-index': '2147483647', background: '#000',
    opacity: '1', visibility: 'visible', display: 'block', transform: 'none',
    'overflow': 'visible', 'clip': 'auto'
  };

  /* Never touch the element's id — the page's own scripts depend on it. The
     original inline style is kept so the promotion can be undone. */
  function mark(el) {
    if (!el) { return; }
    try {
      if (el.__atvPrev === undefined) { el.__atvPrev = attr(el, 'style') || null; }
      if ((' ' + classOf(el) + ' ').indexOf(' __atvStage ') === -1) {
        el.className = (classOf(el) ? classOf(el) + ' ' : '') + '__atvStage';
      }
    } catch (e) {}
    for (var k in STAGE_CSS) {
      if (!STAGE_CSS.hasOwnProperty(k)) { continue; }
      try { el.style.setProperty(k, STAGE_CSS[k], 'important'); }
      catch (e1) { try { el.style[k] = STAGE_CSS[k]; } catch (e2) {} }
    }
    for (var j = 0; j < staged.length; j++) { if (staged[j] === el) { return; } }
    staged.push(el);
  }

  function unmark(el) {
    if (!el) { return; }
    try {
      el.className = (' ' + classOf(el) + ' ').replace(' __atvStage ', ' ')
                       .replace(/^\s+|\s+$/g, '');
      if (el.__atvPrev === null || el.__atvPrev === undefined) { el.removeAttribute('style'); }
      else { el.setAttribute('style', el.__atvPrev); }
      el.__atvPrev = undefined;
    } catch (e) {}
  }

  /* Does the element actually fill the screen? Sites wrap players in containers
     with their own transform / overflow:hidden, and position:fixed inside a
     transformed ancestor is fixed to the ANCESTOR, not the viewport. */
  function covers(el) {
    var r = rectOf(el);
    if (!r) { return false; }
    var v = viewport();
    if (!v.w || !v.h) { return true; }
    var x0 = Math.max(0, r.left), y0 = Math.max(0, r.top);
    var x1 = Math.min(v.w, r.right), y1 = Math.min(v.h, r.bottom);
    var w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) { return false; }
    return (w * h) >= 0.9 * v.w * v.h;
  }

  function isContainerish(el) {
    try {
      if (!window.getComputedStyle) { return true; }
      var cs = window.getComputedStyle(el);
      if (!cs) { return true; }
      if (cs.position && cs.position !== 'static') { return true; }
      if (cs.transform && cs.transform !== 'none') { return true; }
      if (cs.overflow && cs.overflow !== 'visible') { return true; }
      if (cs.overflowX && cs.overflowX !== 'visible') { return true; }
      if (cs.overflowY && cs.overflowY !== 'visible') { return true; }
      if (cs.filter && cs.filter !== 'none') { return true; }
      if (cs.perspective && cs.perspective !== 'none') { return true; }
      if (cs.contain && cs.contain !== 'none') { return true; }
    } catch (e) { return true; }
    return false;
  }

  /* Promote until the viewport is actually covered, walking up through the
     wrappers that are clipping us. */
  function enforceCoverage(el) {
    if (covers(el)) { return; }
    var node = el.parentNode, guard = 0;
    while (node && node !== document.body && node.nodeType === 1 && guard++ < 8) {
      if (isContainerish(node)) {
        mark(node);
        if (covers(el)) { return; }
      }
      node = node.parentNode;
    }
    /* Last resort: the body itself is the clipper. */
    if (!covers(el) && document.body) {
      try {
        document.body.style.setProperty('overflow', 'visible', 'important');
        document.body.style.setProperty('transform', 'none', 'important');
      } catch (e) {}
    }
  }

  function clearPromotion() {
    for (var i = staged.length - 1; i >= 0; i--) { unmark(staged[i]); }
    staged = [];
    engaged = null;
    engagedKind = '';
    unhideAll();
  }

  function askTap() {
    if (tapAsks >= 3) { return; }
    tapAsks++;
    bridge('tapCenter');
  }

  function reportTarget(how) {
    if (targetFinal && how === 'none') { return; }
    if (targetReported === how) { return; }
    targetReported = how;
    if (how !== 'none') { targetFinal = true; }
    bridge('onTarget', EP, how);
  }

  function attachVideo(el) {
    try {
      if (el.__atvHooked) { return; }
      el.__atvHooked = 1;
      el.addEventListener('ended', function () { bridge('onEnded'); }, false);
      el.addEventListener('timeupdate', function () {
        try {
          var t = now();
          if (t - lastProgressAt < PROGRESS_MS) { return; }
          lastProgressAt = t;
          var cur = el.currentTime;
          var dur = el.duration;
          if (typeof cur !== 'number' || !isFinite(cur) || cur < 0) { cur = 0; }
          if (typeof dur !== 'number' || !isFinite(dur) || dur <= 0) { dur = 0; }
          bridge('onProgress', Math.round(cur), Math.round(dur));
        } catch (e) {}
      }, false);
    } catch (e2) {}
  }

  function engagePlayer(cand, how) {
    var el = cand.el;
    if (engaged === el && engagedKind === 'player') {
      /* Already promoted — a late src swap in the same element, or a second
         confirmation of the same pick. Do not re-announce it to native. */
      enforceCoverage(el);
      reportTarget(how);
      return;
    }
    if (engagedKind === 'placeholder' || (engaged && engaged !== el)) { clearPromotion(); }
    installStyle();
    hideAround(el);
    mark(el);
    enforceCoverage(el);
    try { window.scrollTo(0, 0); } catch (e) {}
    engaged = el;
    engagedKind = 'player';

    /* Wrappers sometimes settle late (lazy CSS, web fonts, the site's own JS). */
    setTimeout(function () {
      try { if (engaged === el) { enforceCoverage(el); } } catch (e) {}
    }, 400);
    setTimeout(function () {
      try { if (engaged === el) { enforceCoverage(el); } } catch (e) {}
    }, 1500);

    if (cand.tag === 'VIDEO') {
      mode = 1;
      try { el.setAttribute('playsinline', ''); } catch (e) {}
      attachVideo(el);
      try {
        if (el.play) { var pr = el.play(); if (pr && pr['catch']) { pr['catch'](function () {}); } }
      } catch (e) {}
      if (el.paused) {
        var sels = ['.vjs-big-play-button', '.jw-icon-display', '.plyr__control--overlaid'];
        for (var i = 0; i < sels.length; i++) {
          var b = null;
          try { b = document.querySelector(sels[i]); } catch (e) {}
          if (b) { clickEl(b); break; }
        }
      }
      setTimeout(function () {
        try { if (engaged === el && el.paused) { askTap(); } } catch (e) {}
      }, 1200);
    } else {
      mode = 2;
      /* A cross-origin player only starts on a genuine gesture, and there is no
         progress to read from it — native must fall back to a timer. */
      if (!noProgressSent) { noProgressSent = true; bridge('onNoProgress'); }
      askTap();
    }
    bridge('onCinema', mode === 1 ? 'video' : 'frame');
    reportTarget(how);
  }

  /* ------------------------------------------------ waiting for a DOM swap */

  function allFrameSigs() {
    var list = [];
    try {
      var f = document.getElementsByTagName('iframe');
      for (var i = 0; i < f.length; i++) { list.push({ el: f[i], sig: frameSig(f[i]) }); }
    } catch (e) {}
    return list;
  }

  function sigBefore(el) {
    if (!wait) { return undefined; }
    for (var i = 0; i < wait.before.length; i++) {
      if (wait.before[i].el === el) { return wait.before[i].sig; }
    }
    return undefined;
  }

  function beginWait(how, hint, acceptSettle, ep) {
    var t = now();
    wait = {
      how: how,
      hint: hint || '',
      before: allFrameSigs(),
      settleAt: t + (acceptSettle ? SETTLE_MS : Math.min(SETTLE_MS, 1200)),
      maxAt: t + MAX_WAIT_MS,
      acceptSettle: !!acceptSettle,
      settled: false,   /* provisionally promoted; keep watching for a better match */
      lastCheck: 0,
      ep: ep
    };
    startObserver();
  }

  function endWait() {
    wait = null;
    stopObserver();
  }

  function checkSwitch(force) {
    if (!wait) { return; }
    var t = now();
    /* A MutationObserver on a busy page fires constantly; do not walk the DOM
       more than ~12 times a second for it. */
    if (!force && wait.lastCheck && (t - wait.lastCheck) < 80 && t < wait.maxAt) { return; }
    wait.lastCheck = t;

    var list = splitPlayers(scan().players);
    var i, cand = null, hinted = null;

    for (i = 0; i < list.length; i++) {
      var el = list[i].el;
      var sig = list[i].tag === 'IFRAME' ? frameSig(el) : '';
      if (wait.hint && sig && sig.indexOf(wait.hint) !== -1) { hinted = list[i]; break; }
      var prev = sigBefore(el);
      if (prev === undefined) { if (!cand) { cand = list[i]; } }          /* newly inserted */
      else if (list[i].tag === 'IFRAME' && prev !== sig) { cand = list[i]; }  /* src swapped */
    }

    if (hinted) { var h1 = wait.how; endWait(); engagePlayer(hinted, h1); return; }

    if (cand && (!wait.hint || t >= wait.settleAt)) {
      var h2 = wait.how; endWait(); engagePlayer(cand, h2); return;
    }
    if (!wait.settled && t >= wait.settleAt && wait.acceptSettle && list.length === 1) {
      /* The page has exactly one player and we invoked its own switcher for
         episode N, so that frame is where episode N lands. Promote it now, but
         stay on watch until maxAt in case the site replaces the element rather
         than swapping its src. */
      wait.settled = true;
      engagePlayer(list[0], wait.how);
      return;
    }
    if (t >= wait.maxAt) { endWait(); }
  }

  function startObserver() {
    try {
      if (observer || !window.MutationObserver || !document.body) { return; }
      observer = new MutationObserver(function () {
        try { if (wait) { checkSwitch(); } } catch (e) {}
      });
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src']
      });
    } catch (e) {}
  }

  function stopObserver() {
    try { if (observer) { observer.disconnect(); } } catch (e) {}
    observer = null;
  }

  /* ----------------------------------------------------------- unlock (d) */

  function nearestStage(el) {
    var node = el, guard = 0;
    while (node && node !== document.body && guard++ < 12) {
      if (node.nodeType === 1 && videoShaped(node)) { return node; }
      node = node.parentNode;
    }
    return null;
  }

  /* Some sites (onepiece-nakama) show a poster with a "לחצו לצפייה" overlay and
     only build the MEGA/Drive iframe once it is clicked. Only ever runs while no
     player exists on the page. */
  function tryUnlock(unlocks) {
    if (unlockTries >= 6) { return false; }
    var ordered = [], i;
    for (i = 0; i < unlocks.length; i++) { if (unlocks[i].rank === 0) { ordered.push(unlocks[i].el); } }
    for (i = 0; i < unlocks.length; i++) { if (unlocks[i].rank === 1) { ordered.push(unlocks[i].el); } }

    for (i = 0; i < ordered.length; i++) {
      var el = ordered[i];
      if (el.__atvClicked) { continue; }
      el.__atvClicked = 1;
      unlockTries++;
      clickEl(el);
      /* The handler often sits on the surrounding box, and a click bubbles, but
         if the icon is a sibling we click the box itself as well. */
      var stage = nearestStage(el);
      if (stage && stage !== el && !stage.__atvClicked) {
        stage.__atvClicked = 1;
        clickEl(stage);
      }
      unlockedSomething = true;
      return true;   /* one attempt per tick — give the page time to react */
    }

    /* Clicks alone did not produce a player: promote the poster box and ask for
       a real touch on it, which some players require. */
    if (unlockTries >= 2 && !engaged && ordered.length) {
      var box = nearestStage(ordered[0]);
      if (box) {
        installStyle();
        mark(box);
        engaged = box;
        engagedKind = 'placeholder';
        askTap();
      }
      unlockTries++;
    }
    return false;
  }

  /* ------------------------------------------------------------- main loop */

  function scanWithContext() {
    var s = scan();
    s.controls = controlCount();
    s.switcher = switcherSeen();
    return s;
  }

  function scanAndAct() {
    var s = scanWithContext();

    /* (a) the site's own API — by far the most reliable path */
    if (EP > 0 && !usedFn) {
      usedFn = true;
      var f = getFn(EP);
      if (f) {
        beginWait('fn', fnHint(EP), true, EP);
        try { f(); } catch (e) {}
        checkSwitch(true);
        return;
      }
    }

    /* (b) press what a human would press */
    if (EP > 0 && !usedClick) {
      usedClick = true;
      var c = findControl(EP);
      if (c) {
        var hint = hintFrom(attr(c.el, 'onclick'));
        if (!hint) { hint = fnHint(EP); }
        beginWait('click', hint, c.strong, EP);
        clickEl(c.el);
        checkSwitch(true);
        return;
      }
    }

    /* (c) positional / label match among the players already present */
    var d = decide(s);
    if (d.cand) { engagePlayer(d.cand, d.how); return; }

    /* (d) unlock a click-to-load overlay, then re-run from (a) */
    if (!s.players.length) {
      if (tryUnlock(s.unlocks)) {
        usedFn = false;
        usedClick = false;
        return;
      }
    }

    /* Nothing to promote. Say so, once, and leave the page exactly as it is.
       When the page demonstrably enumerates episodes we know straight away that
       N is not among them; otherwise give the site a few seconds to build its
       player before admitting defeat. */
    if (s.players.length || s.controls > 0 || s.switcher) {
      if (tries >= 4) { reportTarget('none'); }
    } else if (tries >= 12) {
      reportTarget('none');
    }
  }

  function tick() {
    tries++;
    try {
      if (engaged && !inDoc(engaged)) {
        clearPromotion();
        mode = 0;
        bridge('onCinema', 'none');
      }
      if (wait) { checkSwitch(true); }
      if (!wait && engagedKind !== 'player') { scanAndAct(); }
    } catch (e) {}
    if (tries < TICK_LIMIT) {
      timer = setTimeout(tick, tries < 25 ? TICK_FAST : TICK_SLOW);
    } else {
      looping = false;
      stopObserver();
    }
  }

  function ensureLoop() {
    if (looping && timer) { return; }
    looping = true;
    if (tries >= TICK_LIMIT) { tries = 0; }
    timer = setTimeout(tick, 60);
  }

  /* --------------------------------------------------- native-facing API */

  window.__atvSeek = function (delta) {
    try {
      var d = Number(delta);
      if (!isFinite(d)) { return 0; }
      if (mode === 1 && engagedKind === 'player' && engaged && isFinite(engaged.duration) && engaged.duration > 0) {
        var t = engaged.currentTime + d;
        if (!(t > 0)) { t = 0; }
        var cap = engaged.duration - 1;
        if (cap < 0) { cap = 0; }
        if (t > cap) { t = cap; }
        engaged.currentTime = t;
        return 1;
      }
    } catch (e) {}
    return 0;   /* iframe: native falls back to sending arrow keys */
  };

  window.__atvToggle = function () {
    try {
      if (mode === 1 && engagedKind === 'player' && engaged) {
        if (engaged.paused) {
          var pr = engaged.play();
          if (pr && pr['catch']) { pr['catch'](function () {}); }
        } else {
          engaged.pause();
        }
        return 1;
      }
      if (mode === 2 && engagedKind === 'player' && engaged) {
        return 2;   /* cross-origin: native must send a key or tap the rect */
      }
    } catch (e) {}
    return 0;
  };

  window.__atvPlayerRect = function () {
    try {
      if (!engaged || !inDoc(engaged)) { return ''; }
      var r = rectOf(engaged);
      if (!r || !(r.width > 0) || !(r.height > 0)) { return ''; }
      return Math.round(r.left) + ',' + Math.round(r.top) + ',' +
             Math.round(r.width) + ',' + Math.round(r.height);
    } catch (e) {}
    return '';
  };

  window.__atvFocusPlayer = function () {
    try {
      if (!engaged || !inDoc(engaged)) { return 0; }
      try { window.focus(); } catch (e1) {}
      if (engaged.focus) {
        if (!engaged.hasAttribute || !engaged.hasAttribute('tabindex')) {
          try { engaged.setAttribute('tabindex', '-1'); } catch (e2) {}
        }
        engaged.focus();
        return 1;
      }
    } catch (e) {}
    return 0;
  };

  /* On switcher pages the next episode is not a new URL — it is myFunction(N+1)
     on this same page. Returns 1 when the switch was triggered here (the
     promoted element stays promoted and picks up the new src), 0 when native
     must navigate instead. */
  window.__atvNext = function () {
    try {
      var n = EP + 1;
      var f = getFn(n);
      if (f) {
        beginWait('fn', fnHint(n), true, n);
        EP = n;
        targetReported = '';
        targetFinal = false;
        try { f(); } catch (e1) {}
        ensureLoop();
        checkSwitch(true);
        return 1;
      }
      var c = findControl(n);
      if (c && c.strong) {
        var hint = hintFrom(attr(c.el, 'onclick'));
        if (!hint) { hint = fnHint(n); }
        beginWait('click', hint, true, n);
        EP = n;
        targetReported = '';
        targetFinal = false;
        clickEl(c.el);
        ensureLoop();
        checkSwitch(true);
        return 1;
      }
    } catch (e) {}
    return 0;
  };

  /* ----------------------------------------------------------------- boot */

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { ensureLoop(); }, false);
    } else {
      ensureLoop();
    }
  } catch (eBoot) {
    try { ensureLoop(); } catch (eBoot2) {}
  }
})();
