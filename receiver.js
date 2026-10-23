// Spool's Cast receiver (D-107). Plays each post's audio from the phone and shows the post with
// the sentence being read highlighted. The phone sends each post as it starts, on Spool's message
// channel (a secure page can't fetch from the phone's plain-HTTP server; audio it can play):
// { type: "post", headline, author, post, postedAt, live, text, sentences: [{ start, end, from, to }] },
// times in ms from the start of the post's audio, from/to character offsets in text (null when a
// sentence isn't from the post, such as an intro).
(() => {
  const context = cast.framework.CastReceiverContext.getInstance();
  const player = context.getPlayerManager();
  const Events = cast.framework.events.EventType;
  player.setMediaElement(document.getElementById("audio"));

  const $ = (id) => document.getElementById(id);
  const NAMESPACE = "urn:x-cast:app.spool";
  let current = null; // { info, spans: [{ el, start, end }], inner }

  function show(screen) {
    $("idle").hidden = screen !== "idle";
    $("post").hidden = screen !== "post";
  }

  /** Builds the post's text with one span per sentence from the post, the rest as plain text. */
  function render(info) {
    $("headline").textContent = info.headline || "";
    $("meta").textContent = [info.author, info.post, info.postedAt].filter(Boolean).join(" · ");
    $("live").hidden = !info.live;
    const inner = document.createElement("div");
    inner.className = "inner";
    const text = info.text || "";
    const ranges = (info.sentences || []).filter((s) => s.from != null && s.to != null).sort((a, b) => a.from - b.from);
    const spans = [];
    let at = 0;
    for (const s of ranges) {
      if (s.from < at) continue;
      if (s.from > at) inner.append(plain(text.slice(at, s.from)));
      const el = document.createElement("span");
      el.className = "s";
      el.textContent = text.slice(s.from, s.to);
      inner.append(el);
      spans.push({ el, start: s.start, end: s.end });
      at = s.to;
    }
    if (at < text.length) inner.append(plain(text.slice(at)));
    $("text").replaceChildren(inner);
    current = { info, spans, inner };
    show("post");
  }

  function plain(t) {
    const el = document.createElement("span");
    el.className = "plain";
    el.textContent = t;
    return el;
  }

  /** Each frame: mark sentences said and the one being read, and keep it in view. */
  function tick() {
    if (current) {
      const ms = player.getCurrentTimeSec() * 1000;
      let now = null;
      for (const s of current.spans) {
        const isNow = ms >= s.start && ms < s.end + 200;
        s.el.classList.toggle("now", isNow);
        s.el.classList.toggle("said", ms >= s.end + 200);
        if (isNow) now = s;
      }
      if (now) {
        const box = $("text").clientHeight;
        const top = now.el.offsetTop;
        const shift = Math.max(0, top - box * 0.3);
        current.inner.style.transform = `translateY(${-shift}px)`;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  context.addCustomMessageListener(NAMESPACE, (event) => {
    const msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    if (msg && msg.type === "post") render(msg);
  });

  player.addEventListener(Events.PAUSE, () => { $("paused").hidden = false; });
  player.addEventListener(Events.PLAY, () => { $("paused").hidden = true; });
  player.addEventListener(Events.PLAYING, () => { $("paused").hidden = true; });
  player.addEventListener(Events.MEDIA_FINISHED, () => { if (!player.getMediaInformation()) { current = null; show("idle"); } });

  context.start({ disableIdleTimeout: false });
})();
