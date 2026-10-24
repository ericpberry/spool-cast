// Spool's Cast receiver (D-107, D-112). Plays each post's audio from the phone and draws the thread the
// way Spool would. The phone sends messages on Spool's channel (shapes in core/cast/TvMessages.kt):
//   post     the post that's starting: text, sentence timings, headline, note, up next, behind live,
//            the thread glossary, photos/link/quote, text scale, and whether it opens with the catch-up summary
//   status   new posts arrived: total and behind live
//   caughtUp at the live edge, waiting for the next post: where things stand, the latest post, another live thread
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
  let embeds = [];     // [{ el, start, end }]: the card or photo a sentence reads from (D-134)
  let alsoCards = [];  // the live thread the caught-up screen offers (D-134)
  const isTouch = () => document.body.classList.contains("touch");
  /** The phone's reduced-motion setting (D-132): the page keeps still too. */
  const still = (m) => { if (m && m.reducedMotion != null) document.body.classList.toggle("still", !!m.reducedMotion); };

  function show(name) {
    screen = name;
    for (const id of ["idle", "post", "caught", "end"]) $(id).hidden = id !== name;
  }

  // D-120: the phone is the sender that last spoke on Spool's channel. The page answers only it, so
  // another device that joins the session doesn't hear what's playing; until the phone has spoken
  // (or if it's gone), every sender.
  let phone = null;
  function ask(type, extra) {
    const msg = Object.assign({ type }, extra || {});
    if (!context) return console.log("ask", msg);
    const to = phone && context.getSenders().some((s) => s.id === phone) ? phone : undefined;
    context.sendCustomMessage(NAMESPACE, to, msg);
  }

  // ---- post ------------------------------------------------------------------------------

  function renderPost(m) {
    if (playingId && m.id && m.id !== playingId) return; // a late message for a post that's no longer playing (D-113)
    starting = null;
    post = m;
    still(m);
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
    renderTouch(m);
    embeds = embedSpans(m);
    renderBar($("bar"), m.index, m.total);
    show("post");
  }

  /**
   * D-134: the sentences read from the post's photo, link card or quoted post, each tied to what it
   * reads, so it's highlighted as it's read. "Quoting …" is the quote; "Photo…", "N photos" and "Video"
   * the photo; anything else the link card.
   */
  function embedSpans(m) {
    const quote = $("cardsSide").querySelector(".card.quote");
    const link = $("cardsSide").querySelector(".card.link");
    const out = [];
    for (const s of (m.sentences || []).filter((s) => s.embed)) {
      const say = s.say || "";
      const visual = /^(Photo|Video|GIF|\w+ photos)/.test(say);
      const target = /^Quoting/.test(say) ? quote : visual ? (isTouch() ? $("thumb") : $("photoImg")) : link;
      if (target) out.push({ el: target, start: s.start, end: s.end });
    }
    return out;
  }

  /** D-134: on a touch display the side column is gone; a photo thumbnail and one status line stand in for it. */
  function renderTouch(m) {
    const images = m.images || [];
    const thumb = $("thumb");
    thumb.hidden = !images.length;
    if (images.length) { thumb.src = images[0].url; thumb.alt = images[0].alt || ""; }
    touchStatus(m.note, m.behindPosts, m.behindMinutes, m.live);
  }

  function touchStatus(note, posts, minutes, live) {
    const t = $("touchStatus");
    t.className = "tstatus";
    if (note) t.textContent = `“${note}”`;
    else if (posts > 0) { t.textContent = `${posts} post${posts === 1 ? "" : "s"} behind live${minutes > 0 ? ` · ~${minutes} min` : ""}`; t.classList.add("behindlive"); }
    else if (live) { t.textContent = "At the live edge"; t.classList.add("edge"); }
    else t.textContent = "";
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
      const card = el("div", "card link");
      if (m.link.thumb) { const t = el("img"); t.src = m.link.thumb; t.alt = ""; card.append(t); }
      card.append(el("div", "t", m.link.title), el("div", "d", m.link.domain));
      cards.append(card);
    }
    if (m.quote) {
      const card = el("div", "card quote");
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


  function renderBar(bar, index, total) {
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
      for (const e of embeds) e.el.classList.remove("now");
      for (const e of embeds) if (ms >= e.start && ms < e.end + 200) e.el.classList.add("now");
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

  /**
   * D-134: waiting at the live edge (or through a quiet spell) is when the room looks up, so the screen
   * says where things stand, shows the latest post dimmed, and offers another live thread for OK.
   */
  let caught = null;
  function renderCaught(m) {
    caught = m;
    starting = null;
    still(m);
    $("caughtLabel").textContent = "You're caught up";
    $("caughtTitle").textContent = `Waiting for ${m.author}'s next post`;
    $("caughtLive").hidden = !m.live;
    $("caughtMore").hidden = false;
    $("caughtBar").hidden = !m.total;
    $("latest").hidden = !m.latest;
    $("latestLabel").textContent = ["Latest", m.latestAt].filter(Boolean).join(" · ");
    $("latestText").textContent = m.latest || "";
    alsoCards = m.also || [];
    $("also").hidden = !alsoCards.length;
    $("caughtMore").classList.toggle("solo", !alsoCards.length);
    const box = $("alsoCards");
    box.replaceChildren();
    for (const t of alsoCards) {
      const c = el("button", "tc sel");
      c.type = "button";
      c.append(el("div", "s" + (t.live ? " islive" : ""), t.live ? "● LIVE" : t.status.toUpperCase()), el("div", "t", t.headline));
      c.addEventListener("click", () => startThread(t));
      box.append(c);
    }
    $("alsoHint").textContent = isTouch() ? "Tap to switch, or choose on your phone" : "Press OK to switch, or choose on your phone";
    if (m.total) renderBar($("caughtBar"), m.total - 1, m.total);
    updateCaught();
    show("caught");
    box.firstChild?.focus(); // OK presses it (D-116)
  }
  function updateCaught() {
    if (!caught) return;
    const mins = Math.max(0, Math.round((Date.now() - caught.lastPostAtMs) / 60000));
    const ago = mins < 1 ? "Last post just now" : mins < 120 ? `Last post ${mins} min ago` : `Last post ${Math.round(mins / 60)} hours ago`;
    // The quoted status in the author's words, its first letter lowered to run on in the line ("court is in recess…").
    const note = caught.note && (/^[A-Z][a-z]/.test(caught.note) ? caught.note[0].toLowerCase() + caught.note.slice(1) : caught.note);
    $("caughtText").textContent = [ago, note, "the next post plays here"].filter(Boolean).join(" · ");
  }
  setInterval(updateCaught, 30000);

  function renderEnd(m) {
    $("endHead").textContent = ["End of thread", m.headline, m.note ? `“${m.note}”` : null].filter(Boolean).join(" · ");
    endCards = m.threads || [];
    selected = 0;
    still(m);
    // The copy board (D-132): the cards can be quiet threads too, so "On Spool now"; touch screens are tapped.
    $("endSub").textContent = !endCards.length ? `${m.posts} posts · pick another thread on your phone`
      : isTouch() ? "On Spool now · Tap one to play" : "On Spool now · press OK to play, or choose on your phone";
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
    const from = screen;
    const was = caught;
    $("caughtLabel").textContent = "Starting";
    $("caughtTitle").textContent = t.headline;
    $("caughtText").textContent = `${t.author} · voicing the first post…`;
    $("caughtLive").hidden = !t.live;
    $("caughtMore").hidden = true;
    $("caughtBar").hidden = true;
    caught = null;
    show("caught");
    ask("play", { root: t.root });
    clearTimeout(startThread.timer);
    startThread.timer = setTimeout(() => {
      if (!starting || screen !== "caught") return;
      starting = null;
      if (from === "caught" && was) renderCaught(was); else show("end");
    }, 30000);
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
    } else if (screen === "caught" && caught && alsoCards.length) {
      if (e.key === "Enter" || e.key === "Select" || e.key === "Accept") { startThread(alsoCards[0]); e.preventDefault(); }
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
      renderBar($("bar"), post.index, m.total);
      behind(m.behindPosts, m.behindMinutes, post.live);
      touchStatus(post.note, m.behindPosts, m.behindMinutes, post.live);
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
    let m = event.data;
    if (typeof m === "string") { try { m = JSON.parse(m); } catch (e) { return; } }
    if (event.senderId) phone = event.senderId;
    onMessage(m);
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
      if (post && post.id !== id) { spans = []; points = []; embeds = []; $("text").replaceChildren(); $("photo").hidden = true; $("thumb").hidden = true; }
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
    const params = new URLSearchParams(location.search);
    if (state === "hub" || params.get("touch") === "1") document.body.classList.add("touch");
    if (params.get("still") === "1") document.body.classList.add("still");
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
      text: photoText, legend: [], note: null,
      sentences: [...sentences(photoText, ["Sketch from the courtroom: Gorsuch leaning in during the Solicitor General's rebuttal."]), { start: 2800, end: 11000, say: "Photo: Pencil sketch of the justices on the bench.", embed: true }],
      images: [{ url: "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'><rect width='800' height='600' fill='#2c3a40'/><text x='400' y='310' fill='#9A9DA3' font-size='34' text-anchor='middle' font-family='monospace'>courtroom sketch</text></svg>"), alt: "Pencil sketch of the justices on the bench" }],
    });
    const linkText = "The Globe's story on today's ruling is up.";
    const link = Object.assign({}, base, { text: linkText, sentences: [...sentences(linkText, [linkText]), { start: 2800, end: 6800, say: "A Boston Globe link: Judge orders new hearings for detained immigrants.", embed: true }, { start: 7000, end: 11800, say: "Quoting Chris Geidner: This is the third ruling this month.", embed: true }], legend: [], note: null, link: { title: "Judge orders new hearings for detained immigrants", domain: "bostonglobe.com" }, quote: { author: "Chris Geidner", text: "This is the third ruling this month to reach the same conclusion on the detention policy." } });
    const summary = Object.assign({}, base, {
      summary: true, legend: [],
      sentences: [{ start: 0, end: 2600, say: "The judge denied the government's motion to stay her order." }, { start: 2800, end: 5400, say: "Both sides must file briefs by Wednesday on the scope of relief." }, { start: 5600, end: 8200, say: "The hearing adjourned; the clerk's notes followed at 3:46 PM." }, ...sentences(text, ["PBS: I have to go, I have a whole afternoon of hearings."]).map((s) => ({ ...s, start: 8400, end: 11000 }))],
    });
    const end = { type: "end", headline: "First Circuit rules on mandatory detention", posts: 102, note: "Hearing adjourned.", threads: [
      { root: "a", headline: "Judge weighs a halt to the golf course changes", author: "Roger Parloff", posts: 8, status: "LIVE", live: true },
      { root: "b", headline: "City Council returns with livestream options", author: "John Hawkinson", posts: 37, status: "LIVE", live: true },
      { root: "c", headline: "Supreme Court hears arguments on tariff powers", author: "Molly Roberts", posts: 191, status: "Quiet 34 min", live: false },
    ] };
    if (state === "post" || state === "hub") { onMessage(base); if (state === "post") setTimeout(() => toast("3 new posts"), 50); }
    else if (state === "photo") onMessage(photo);
    else if (state === "link") onMessage(link);
    else if (state === "summary") onMessage(summary);
    else if (state === "caught") onMessage({ type: "caughtUp", author: "John Hawkinson", headline: base.headline, lastPostAtMs: Date.now() - 360000, live: true,
      note: "Court is in recess until 2:15 PM", latest: "PBS: I have to go, I have a whole afternoon of hearings. If you file by Wednesday, file by Wednesday.", latestAt: "1:54 PM", total: 102,
      also: [end.threads[0]] });
    else if (state === "quiet") onMessage({ type: "caughtUp", author: "Molly Roberts", headline: "Supreme Court hears arguments on tariff powers", lastPostAtMs: Date.now() - 34 * 60000, live: false,
      latest: "That's it for the morning session. Back after lunch.", latestAt: "12:31 PM", total: 191, also: [] });
    else if (state === "end") onMessage(end);
    else if (state === "paused") { onMessage(base); setPaused(true); }
  }
})();
