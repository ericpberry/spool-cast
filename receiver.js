// Spool's Cast receiver (D-107, D-112). Plays each post's audio from the phone and draws the thread the
// way Spool would. The phone sends messages on Spool's channel (shapes in core/cast/TvMessages.kt):
//   post     the post that's starting: text, sentence timings, headline, note, up next, behind live,
//            the thread glossary, photos/link/quote, text scale, and whether it opens with the catch-up summary
//   status   new posts arrived: total and behind live
//   caughtUp at the live edge, waiting for the next post
//   end      a finished thread, with the listener's live threads to play next
// and the page asks the phone for "play" (a thread from the end board), "next", "previous", "toggle".
(() => {
  const NAMESPACE = "urn:x-cast:app.spool";
  const PREVIEW = new URLSearchParams(location.search).get("preview");
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  let context = null;
  let player = null;
  if (!PREVIEW) {
    context = cast.framework.CastReceiverContext.getInstance();
    player = context.getPlayerManager();
    player.setMediaElement($("audio"));
  }
  /** Seconds into the playing post; in preview, a clock that loops. */
  const now = () => (player ? player.getCurrentTimeSec() : ((Date.now() / 1000) % 12));

  let post = null;     // the last post message
  let playingId = null; // the playlist item the TV is playing (D-113)
  let endedFor = null;  // the item whose finish was already reported
  let spans = [];      // [{ el, start, end }] for the post's sentences
  let points = [];     // [{ el, start, end }] for the catch-up summary
  let firstSourced = 0;
  let endCards = [];
  let selected = 0;
  let screen = "idle";

  function show(name) {
    screen = name;
    for (const id of ["idle", "post", "caught", "end"]) $(id).hidden = id !== name;
  }

  function ask(type, extra) {
    const msg = Object.assign({ type }, extra || {});
    if (context) context.sendCustomMessage(NAMESPACE, undefined, msg);
    else console.log("ask", msg);
  }

  // ---- post ------------------------------------------------------------------------------

  function renderPost(m) {
    if (playingId && m.id && m.id !== playingId) return; // a late message for a post that's no longer playing (D-113)
    starting = null;
    post = m;
    document.documentElement.style.setProperty("--scale", m.scale || 1);
    $("headline").textContent = m.headline || "";
    meta(m.index, m.total);
    $("live").hidden = !m.live;

    // The text, one span per sentence voiced from it.
    const text = m.text || "";
    const inner = el("div", "inner");
    const sourced = (m.sentences || []).filter((s) => s.from != null && s.to != null).sort((a, b) => a.from - b.from);
    spans = [];
    let at = 0;
    for (const s of sourced) {
      if (s.from < at) continue;
      if (s.from > at) inner.append(el("span", "plain", text.slice(at, s.from)));
      const span = el("span", "s", text.slice(s.from, s.to));
      inner.append(span);
      spans.push({ el: span, start: s.start, end: s.end });
      at = s.to;
    }
    if (at < text.length) inner.append(el("span", "plain", text.slice(at)));
    $("text").replaceChildren(inner);
    $("text").classList.toggle("small", text.length > 420);

    // The catch-up summary: the spoken sentences before the post's own.
    firstSourced = sourced.length ? Math.min(...sourced.map((s) => s.start)) : Infinity;
    points = [];
    const list = $("points");
    list.replaceChildren();
    if (m.summary) {
      for (const s of (m.sentences || []).filter((s) => s.from == null && s.say && s.start < firstSourced)) {
        const li = el("li", null, s.say);
        list.append(li);
        points.push({ el: li, start: s.start, end: s.end });
      }
    }

    renderSide(m);
    renderBar(m.index, m.total);
    show("post");
  }

  function meta(index, total) {
    $("meta").textContent = [post && post.author, `Post ${index + 1} of ${total}`, post && post.postedAt].filter(Boolean).join(" · ");
  }

  /**
   * D-117: the side column. A post with a photo shows it there, large, so the text keeps its full
   * width; otherwise the thread's abbreviations (this post's first, marked), the post's link or quote
   * card, the quoted status, and how far behind live.
   */
  function renderSide(m) {
    const images = m.images || [];
    $("photo").hidden = !images.length;
    $("post").classList.toggle("withphoto", images.length > 0);
    $("info").hidden = images.length > 0;
    if (images.length) {
      $("photoImg").src = images[0].url;
      $("photoImg").alt = images[0].alt || "";
      $("photoAlt").textContent = images[0].alt || "";
      $("photoMore").textContent = images.length > 1 ? `+${images.length - 1} more` : "";
    }

    const terms = m.glossary || [];
    const dl = $("glossary");
    dl.replaceChildren();
    for (const t of terms) dl.append(el("dt", t.inPost ? "in" : null, t.short), el("dd", t.inPost ? "in" : null, t.long));
    $("terms").hidden = !terms.length;

    const cards = $("cardsSide");
    cards.replaceChildren();
    if (m.link) {
      const card = el("div", "card");
      if (m.link.thumb) { const t = el("img"); t.src = m.link.thumb; t.alt = ""; card.append(t); }
      card.append(el("div", "t", m.link.title), el("div", "d", m.link.domain));
      cards.append(card);
    }
    if (m.quote) {
      const card = el("div", "card");
      card.append(el("div", "d", `Quoting ${m.quote.author}`), el("div", "q", m.quote.text));
      cards.append(card);
    }

    $("note").hidden = !m.note;
    $("note").textContent = m.note ? `“${m.note}”` : "";
    behind(m.behindPosts, m.behindMinutes, m.live);
  }

  function behind(posts, minutes, live) {
    const b = $("behind");
    b.classList.toggle("edge", !posts);
    if (posts > 0) b.textContent = `${posts} post${posts === 1 ? "" : "s"} behind live${minutes > 0 ? ` · ~${minutes} min` : ""}`;
    else b.textContent = live ? "At the live edge" : "";
    $("stand").hidden = !b.textContent && $("note").hidden;
  }


  function renderBar(index, total) {
    const bar = $("bar");
    bar.replaceChildren();
    const ticks = Math.min(total, 24);
    const at = Math.floor(index / Math.max(total, 1) * ticks);
    for (let i = 0; i < ticks; i++) bar.append(el("i", i < at ? "p" : i === at ? "c" : null));
  }

  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  // Each frame: the summary point or sentence being read, those already said, and keep it in view.
  function tick() {
    if (screen === "post" && post) {
      const ms = now() * 1000;
      const inSummary = points.length > 0 && ms < firstSourced;
      $("summary").hidden = !inSummary;
      $("content").hidden = inSummary;
      for (const p of points) { p.el.classList.toggle("now", ms >= p.start && ms < p.end + 200); p.el.classList.toggle("said", ms >= p.end + 200); }
      let current = null;
      for (const s of spans) {
        const isNow = ms >= s.start && ms < s.end + 200;
        s.el.classList.toggle("now", isNow);
        s.el.classList.toggle("said", ms >= s.end + 200);
        if (isNow) current = s;
      }
      if (current) {
        const box = $("text");
        const inner = box.firstChild;
        const shift = Math.max(0, current.el.offsetTop - box.clientHeight * 0.3);
        if (inner) inner.style.transform = `translateY(${-shift}px)`;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---- caught up and end ---------------------------------------------------------------------

  let caught = null;
  function renderCaught(m) {
    caught = m;
    starting = null;
    $("caughtTitle").textContent = "You're caught up";
    updateCaught();
    show("caught");
  }
  function updateCaught() {
    if (!caught) return;
    const mins = Math.max(0, Math.round((Date.now() - caught.lastPostAtMs) / 60000));
    $("caughtText").textContent = `Waiting for ${caught.author}'s next post · last post ${mins < 1 ? "just now" : `${mins} min ago`}`;
  }
  setInterval(updateCaught, 30000);

  function renderEnd(m) {
    $("endHead").textContent = ["End of thread", m.headline, m.note ? `“${m.note}”` : null].filter(Boolean).join(" · ");
    endCards = m.threads || [];
    selected = 0;
    $("endSub").textContent = endCards.length ? "Live on Spool now · choose on your phone, or press OK to play" : `${m.posts} posts · pick another thread on your phone`;
    starting = null;
    show("end");
    drawCards(); // focuses the selected card (D-116)
  }
  /**
   * D-115: OK (or a tap) on the end board. The phone has to load the thread and voice its first post
   * before the TV has anything to play, which takes a few seconds, so the page shows that at once and
   * ignores more presses; if nothing comes in 30 s it goes back to the board.
   */
  let starting = null;
  function startThread(t) {
    if (starting) return;
    starting = t.root;
    $("caughtTitle").textContent = `Starting ${t.headline}`;
    $("caughtText").textContent = `${t.author} · voicing the first post…`;
    caught = null;
    show("caught");
    ask("play", { root: t.root });
    clearTimeout(startThread.timer);
    startThread.timer = setTimeout(() => { if (starting && screen === "caught") { starting = null; show("end"); } }, 30000);
  }

  function drawCards() {
    const box = $("cards");
    box.replaceChildren();
    // D-116: real buttons with the selected one focused, so the remote's OK presses it (a page with
    // nothing focusable spent the first press on finding focus).
    endCards.forEach((t, i) => {
      const c = el("button", "tc" + (i === selected ? " sel" : ""));
      c.type = "button";
      c.addEventListener("focus", () => { if (selected !== i) { selected = i; for (const [j, b] of [...box.children].entries()) b.classList.toggle("sel", j === i); } });
      c.append(el("div", "s" + (t.live ? " islive" : ""), t.live ? "● LIVE" : t.status.toUpperCase()), el("div", "t", t.headline), el("div", "w", `${t.author} · ${t.posts} posts`));
      c.addEventListener("click", () => startThread(t));
      box.append(c);
    });
    if (screen === "end" || !$("end").hidden) box.children[selected]?.focus();
  }

  // ---- input: TV remote keys, smart display touch -------------------------------------------

  let lastKey = 0;
  document.addEventListener("keydown", (e) => {
    // D-113: held keys repeat and some remotes send a key twice: one skip per press, at most every 0.7 s.
    if (e.repeat || Date.now() - lastKey < 700) return;
    lastKey = Date.now();
    if (screen === "end" && endCards.length) {
      if (e.key === "ArrowRight") { selected = Math.min(selected + 1, endCards.length - 1); drawCards(); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { selected = Math.max(selected - 1, 0); drawCards(); e.preventDefault(); }
      else if (e.key === "Enter" || e.key === "Select" || e.key === "Accept") { startThread(endCards[selected]); e.preventDefault(); }
    } else if (screen === "post") {
      if (e.key === "ArrowRight") ask("next");
      else if (e.key === "ArrowLeft") ask("previous");
    }
  });
  for (const b of document.querySelectorAll("#touch button")) b.addEventListener("click", () => ask(b.dataset.ask));
  function setPaused(paused) {
    $("paused").hidden = !paused || document.body.classList.contains("touch");
    const pp = document.querySelector("#touch .pp");
    pp.textContent = paused ? "▶" : "❚❚";
    pp.setAttribute("aria-label", paused ? "Play" : "Pause");
  }

  function onMessage(m) {
    if (!m || !m.type) return;
    if (m.type === "post") renderPost(m);
    else if (m.type === "status") {
      if (!post) return;
      post.total = m.total;
      meta(post.index, m.total);
      renderBar(post.index, m.total);
      behind(m.behindPosts, m.behindMinutes, post.live);
      if (m.newPosts > 0 && m.behindPosts > 0 && screen === "post") toast(`${m.newPosts} new post${m.newPosts === 1 ? "" : "s"}`);
    } else if (m.type === "caughtUp") renderCaught(m);
    else if (m.type === "end") renderEnd(m);
  }

  // ---- start -------------------------------------------------------------------------------

  if (PREVIEW) {
    preview(PREVIEW);
    return;
  }
  context.addCustomMessageListener(NAMESPACE, (event) => {
    onMessage(typeof event.data === "string" ? JSON.parse(event.data) : event.data);
  });
  const Events = cast.framework.events.EventType;
  player.addEventListener(Events.PAUSE, () => setPaused(true));
  for (const ev of [Events.PLAY, Events.PLAYING]) player.addEventListener(ev, () => setPaused(false));

  // D-113: the TV, not the phone, knows when a post starts and when the last one ends. A new post
  // clears the old one's highlight and asks the phone for it; the last one finishing asks for the
  // caught-up screen or the end board.
  function onStatus() {
    const media = player.getMediaInformation();
    const id = media && media.customData && media.customData.mediaId;
    if (id && id !== playingId) {
      playingId = id;
      endedFor = null;
      if (post && post.id !== id) { spans = []; points = []; $("text").replaceChildren(); $("photo").hidden = true; }
      ask("post", { post: id });
    }
  }
  player.addEventListener(Events.PLAYER_LOAD_COMPLETE, onStatus);
  player.addEventListener(Events.MEDIA_STATUS, (e) => {
    onStatus();
    const st = e.mediaStatus;
    if (st && st.playerState === "IDLE" && st.idleReason === "FINISHED" && endedFor !== playingId) {
      // D-114: skipping reports the skipped post as finished for a moment before the next one loads.
      // Only a finish that's still true 2 s later, with the same post, is the end of the playlist.
      const was = playingId;
      setTimeout(() => {
        const idle = player.getPlayerState() === cast.framework.messages.PlayerState.IDLE;
        if (idle && playingId === was && endedFor !== was) { endedFor = was; ask("ended"); }
      }, 2000);
    }
  });
  // Touch screens (Nest Hub) get buttons; TVs, whatever their viewport, get the side column and the remote.
  context.addEventListener(cast.framework.system.EventType.READY, () => {
    const caps = (context.getDeviceCapabilities && context.getDeviceCapabilities()) || {};
    const System = cast.framework.system;
    const touchKey = System.DeviceCapabilities && System.DeviceCapabilities.TOUCH_INPUT_SUPPORTED;
    const touch = (touchKey && caps[touchKey]) || caps.touch_input_supported || matchMedia("(any-pointer: coarse)").matches;
    document.body.classList.toggle("touch", !!touch);
  });
  const Command = cast.framework.messages.Command;
  player.setSupportedMediaCommands(Command.ALL_BASIC_MEDIA | Command.QUEUE_NEXT | Command.QUEUE_PREV, true);
  // Waiting at the live edge is idle time for Cast; keep the page up while the phone is connected.
  context.start({ disableIdleTimeout: true });

  // ---- preview (a browser, no Cast) ----------------------------------------------------------

  function preview(state) {
    const sentences = (t, list) => { const out = []; let at = 0, ms = 0; for (const s of list) { const f = t.indexOf(s, at); out.push({ start: ms, end: ms + 2600, from: f, to: f + s.length }); at = f + s.length; ms += 2800; } return out; };
    const text = "PBS: I have to go, I have a whole afternoon of hearings. If you file by Wednesday, file by Wednesday. If you feel you can't respond, tell me. DM/KS: Understood. Hearing adjourned.";
    const base = {
      type: "post", headline: "First Circuit rules on mandatory detention for non-criminal aliens", author: "John Hawkinson",
      index: 72, total: 102, postedAt: "1:54 PM", live: true, note: "Court is in recess until 2:15 PM", text,
      sentences: sentences(text, ["PBS: I have to go, I have a whole afternoon of hearings.", "If you file by Wednesday, file by Wednesday.", "If you feel you can't respond, tell me.", "DM/KS: Understood.", "Hearing adjourned."]),
      behindPosts: 29, behindMinutes: 14, scale: 1,
      glossary: [{ short: "PBS", long: "Judge Patti B. Saris", inPost: true }, { short: "DM", long: "Dan Mitchell", inPost: true }, { short: "KS", long: "Kate Smith", inPost: true },
        { short: "CLR", long: "Cultural Landscape Report" }, { short: "DOI", long: "Dept of Interior" }, { short: "ICE", long: "Immigration and Customs Enforcement" }],
    };
    const photoText = "Sketch from the courtroom: Gorsuch leaning in during the Solicitor General's rebuttal.";
    const photo = Object.assign({}, base, {
      text: photoText, sentences: sentences(photoText, ["Sketch from the courtroom: Gorsuch leaning in during the Solicitor General's rebuttal."]), legend: [], note: null,
      images: [{ url: "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'><rect width='800' height='600' fill='#2c3a40'/><text x='400' y='310' fill='#9A9DA3' font-size='34' text-anchor='middle' font-family='monospace'>courtroom sketch</text></svg>"), alt: "Pencil sketch of the justices on the bench" }],
    });
    const linkText = "The Globe's story on today's ruling is up.";
    const link = Object.assign({}, base, { text: linkText, sentences: sentences(linkText, [linkText]), legend: [], note: null, link: { title: "Judge orders new hearings for detained immigrants", domain: "bostonglobe.com" }, quote: { author: "Chris Geidner", text: "This is the third ruling this month to reach the same conclusion on the detention policy." } });
    const summary = Object.assign({}, base, {
      summary: true, legend: [],
      sentences: [{ start: 0, end: 2600, say: "The judge denied the government's motion to stay her order." }, { start: 2800, end: 5400, say: "Both sides must file briefs by Wednesday on the scope of relief." }, { start: 5600, end: 8200, say: "The hearing adjourned; the clerk's notes followed at 3:46 PM." }, ...sentences(text, ["PBS: I have to go, I have a whole afternoon of hearings."]).map((s) => ({ ...s, start: 8400, end: 11000 }))],
    });
    const end = { type: "end", headline: "First Circuit rules on mandatory detention", posts: 102, note: "Hearing adjourned.", threads: [
      { root: "a", headline: "Judge weighs a halt to the golf course changes", author: "Roger Parloff", posts: 8, status: "LIVE", live: true },
      { root: "b", headline: "City Council returns with livestream options", author: "John Hawkinson", posts: 37, status: "LIVE", live: true },
      { root: "c", headline: "Supreme Court hears arguments on tariff powers", author: "Molly Roberts", posts: 191, status: "Quiet 34 min", live: false },
    ] };
    if (state === "hub") document.body.classList.add("touch");
    if (state === "post" || state === "hub") { onMessage(base); if (state === "post") setTimeout(() => toast("3 new posts"), 50); }
    else if (state === "photo") onMessage(photo);
    else if (state === "link") onMessage(link);
    else if (state === "summary") onMessage(summary);
    else if (state === "caught") onMessage({ type: "caughtUp", author: "John Hawkinson", headline: base.headline, lastPostAtMs: Date.now() - 120000 });
    else if (state === "end") onMessage(end);
    else if (state === "paused") { onMessage(base); $("paused").hidden = false; }
  }
})();
