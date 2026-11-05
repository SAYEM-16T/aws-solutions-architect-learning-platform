/* Quiz answers and mistake tracking for SAA-SECTIONS pages. Needs saa.js first.

   Results shape (same on the server and in localStorage):
     { version: 1, questions: { "S1-Q12": { attempts: [ { t, c: [chosen], ok } ], cleared: t } } }
   cleared (optional): wrong answers up to that time no longer count (the "clear mistakes" buttons).
   reset (optional): every attempt up to that time is ignored; the question counts as not done (card "Reset").
   Served from the tracker: GET /api/quiz, POST /api/quiz/attempt, POST /api/quiz/import, POST /api/quiz/clear, POST /api/quiz/reset.
   Opened as a file: localStorage only. A failed POST is queued and sent on the next load. */
(function () {
  "use strict";
  const LOCAL_KEY = "saa-quiz";
  const PENDING_KEY = "saa-quiz-pending";
  const DUE_DAYS = 2;            // a wrong question comes back this many days after its last attempt
  const CLEAR_AFTER = 2;         // correct answers in a row (after the last wrong) to leave the mistake list
  const DAY = 86400000;

  let data = { version: 1, questions: {} };
  let saveFailed = false;

  function readJSON(key, fallback) {
    const raw = SAA.readLocal(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  // Local time with offset, e.g. 2026-10-26T13:05:00.120+06:00 (the server checks this shape).
  // Milliseconds keep two quick identical answers from being merged as one.
  function stamp(d) {
    const pad = n => String(Math.abs(n)).padStart(2, "0");
    const off = -d.getTimezoneOffset();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + String(d.getMilliseconds()).padStart(3, "0") +
      (off >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(off) / 60)) + ":" + pad(Math.abs(off) % 60);
  }

  function mergeInto(target, source) {
    Object.entries((source && source.questions) || {}).forEach(([id, entry]) => {
      const t = (target.questions[id] = target.questions[id] || { attempts: [] });
      ["cleared", "reset"].forEach(k => { if (entry[k] && (!t[k] || new Date(entry[k]) > new Date(t[k]))) t[k] = entry[k]; });
      const list = t.attempts;
      const seen = new Set(list.map(a => a.t + "|" + a.c.join(",") + "|" + a.ok));
      (entry.attempts || []).forEach(a => {
        const key = a.t + "|" + a.c.join(",") + "|" + a.ok;
        if (!seen.has(key)) { seen.add(key); list.push({ t: a.t, c: a.c.slice(), ok: a.ok }); }
      });
      list.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
    });
    return target;
  }

  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  function warn(text) {
    let el = document.querySelector(".save-warn");
    if (!el) { el = document.createElement("div"); el.className = "save-warn"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = text;
  }

  // Send attempts that failed earlier. Keeps whatever still fails.
  function flushPending() {
    const pending = readJSON(PENDING_KEY, []);
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map(a => post("/api/quiz/attempt", a).then(() => null, () => a)))
      .then(left => SAA.writeLocal(PENDING_KEY, JSON.stringify(left.filter(Boolean))));
  }

  let loading = null;
  function load() {
    if (loading) return loading;
    if (!SAA.served) {
      data = mergeInto({ version: 1, questions: {} }, readJSON(LOCAL_KEY, {}));
      loading = Promise.resolve(data);
    } else {
      loading = flushPending()
        .then(() => fetch("/api/quiz", { cache: "no-store" }))
        .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(d => (data = mergeInto({ version: 1, questions: {} }, d)))
        .catch(() => {
          warn("Server theke result ana gelo na. Ei page e notun answer browser e rakha hobe.");
          saveFailed = true;
          return (data = mergeInto({ version: 1, questions: {} }, readJSON(LOCAL_KEY, {})));
        });
    }
    return loading;
  }

  function record(id, chosen, ok) {
    const a = { t: stamp(new Date()), c: chosen, ok };
    mergeInto(data, { questions: { [id]: { attempts: [a] } } });
    if (!SAA.served || saveFailed) {
      SAA.writeLocal(LOCAL_KEY, JSON.stringify(data));
      return Promise.resolve();
    }
    return post("/api/quiz/attempt", Object.assign({ id }, a)).catch(() => {
      const pending = readJSON(PENDING_KEY, []);
      pending.push(Object.assign({ id }, a));
      SAA.writeLocal(PENDING_KEY, JSON.stringify(pending));
      warn("Server e save hoy nai (server bondho?). Answer ta browser e rakha holo, porer bar server chalu thakle pathano hobe.");
    });
  }

  // State of one question from its attempts.
  //   new: never tried; ok: tried, never wrong; cleared: wrong before, then CLEAR_AFTER right in a row;
  //   mistake: in the mistake list (due = last attempt + DUE_DAYS).
  function status(id, now) {
    const entry = data.questions[id] || {};
    const since = entry.reset ? new Date(entry.reset) : null;
    const attempts = (entry.attempts || []).filter(a => !since || new Date(a.t) > since);
    if (!attempts.length) return { state: "new", attempts };
    const first = attempts[0].ok;
    let lastWrong = -1;
    attempts.forEach((a, i) => { if (!a.ok) lastWrong = i; });
    if (lastWrong < 0) return { state: "ok", first, attempts };
    const rightAfter = attempts.length - 1 - lastWrong;
    if (rightAfter >= CLEAR_AFTER) return { state: "cleared", first, attempts };
    if (entry.cleared && new Date(attempts[lastWrong].t) <= new Date(entry.cleared)) return { state: "cleared", first, attempts };
    const last = attempts[attempts.length - 1];
    const due = new Date(new Date(last.t).getTime() + DUE_DAYS * DAY);
    return { state: "mistake", first, attempts, lastWrong: attempts[lastWrong].t, rightAfter, due,
             isDue: (now || new Date()) >= due };
  }

  // Take questions off the mistake list; their attempts stay. Resolves to how many were cleared.
  function clearMistakes(ids) { return mark("cleared", "/api/quiz/clear", ids); }

  // Forget a question's attempts (they stay in the file, but no longer count): it is "new" again.
  function resetQuestions(ids) { return mark("reset", "/api/quiz/reset", ids); }

  function mark(field, path, ids) {
    const t = stamp(new Date());
    ids.forEach(id => { if (data.questions[id]) data.questions[id][field] = t; });
    if (!SAA.served || saveFailed) {
      SAA.writeLocal(LOCAL_KEY, JSON.stringify(data));
      return Promise.resolve(ids.length);
    }
    return post(path, { ids, t }).then(r => r.marked);
  }

  // Wrong answers that still count: those after the question's last "clear".
  function wrongAttempts(id) {
    const entry = data.questions[id] || {};
    const marks = [entry.cleared, entry.reset].filter(Boolean).map(t => new Date(t));
    const since = marks.length ? new Date(Math.max(...marks)) : null;
    return (entry.attempts || []).filter(a => !a.ok && (!since || new Date(a.t) > since));
  }

  function shortDate(t) {
    return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function exportFile() {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "saa-quiz-" + stamp(new Date()).slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function importFile(file) {
    return file.text().then(text => {
      const incoming = JSON.parse(text);
      if (!incoming || typeof incoming.questions !== "object") throw new Error("this is not a quiz results file");
      mergeInto(data, incoming);
      if (SAA.served && !saveFailed) return post("/api/quiz/import", { questions: incoming.questions });
      SAA.writeLocal(LOCAL_KEY, JSON.stringify(data));
    });
  }

  /* ---------- question cards (.qz) ---------- */

  function correctSets(card) {
    const key = [...card.querySelectorAll(".qz-opts li[data-c]")].map(li => +li.dataset.i).sort().join(",");
    const sets = [key];
    if (card.dataset.alt) sets.push(card.dataset.alt.split(",").map(Number).sort().join(","));
    return sets;
  }

  function badge(card) {
    const s = status(card.dataset.qid);
    const el = card.querySelector(".qz-badge");
    card.classList.toggle("is-mistake", s.state === "mistake");
    card.classList.toggle("is-done", s.state !== "new");
    if (!el) return;
    const reset = card.querySelector(".qz-reset");
    if (reset) reset.hidden = s.state === "new";
    if (s.state === "mistake") el.innerHTML = '<span class="pill bad">⚠ wrong (' + shortDate(s.lastWrong) + ")</span>" +
      (s.rightAfter ? ' <span class="pill">' + s.rightAfter + "/" + CLEAR_AFTER + " right</span>" : "");
    else if (s.state === "cleared") el.innerHTML = '<span class="pill ok">✓ cleared</span>';
    else if (s.state === "ok") el.innerHTML = '<span class="pill ok">✓ right</span>';
    else el.innerHTML = "";
  }

  function score(container) {
    const out = container.querySelector(".qz-score");
    if (!out) return;
    const cards = [...container.querySelectorAll(".qz")];
    let done = 0, firstOk = 0, mistakes = 0;
    cards.forEach(c => {
      const s = status(c.dataset.qid);
      if (s.state === "new") return;
      done++;
      if (s.first) firstOk++;
      if (s.state === "mistake") mistakes++;
    });
    const pct = done ? Math.round((firstOk / done) * 100) : 0;
    out.innerHTML = "Done: <b>" + done + "/" + cards.length + "</b> · Right first time: <b>" + firstOk + "/" + done +
      (done ? " (" + pct + "%)" : "") + "</b> · In the mistake list: <b>" + mistakes + "</b>" +
      (done >= 5 && pct < 70 ? ' <span class="pill warn">below 70%: read the note again</span>' : "");
  }

  function refresh(card) {
    badge(card);
    const part = card.closest(".qz-part");
    if (part) score(part);
  }

  function enhance(card) {
    if (card.dataset.ready) return;
    card.dataset.ready = "1";
    const need = +card.dataset.n || 1;
    const check = card.querySelector(".qz-check");
    const again = card.querySelector(".qz-again");
    const res = card.querySelector(".qz-res");
    const ex = card.querySelector(".qz-ex");
    const inputs = [...card.querySelectorAll(".qz-opts input")];

    // "বাংলা": the Bangla translation under the question and every option (only cards that have one).
    if (card.querySelector(".qz-bnq")) {
      const bnBtn = document.createElement("button");
      bnBtn.className = "btn qz-bn-btn";
      bnBtn.type = "button";
      bnBtn.textContent = "বাংলা";
      bnBtn.title = "Show the Bangla translation of the question and options";
      card.querySelector(".qz-top").appendChild(bnBtn);
      bnBtn.addEventListener("click", () => showBn(card, card.querySelector(".qz-bnq").hidden));
      showBn(card, SAA.readLocal(BN_KEY) === "1");
    }

    // Hide / Show explanation: only after Check, so nothing gives the answer away before.
    const exToggle = document.createElement("button");
    exToggle.className = "btn qz-extoggle";
    exToggle.type = "button";
    exToggle.hidden = true;
    check.after(exToggle);
    const showEx = on => { ex.hidden = !on; exToggle.textContent = on ? "Hide explanation" : "Show explanation"; };
    exToggle.addEventListener("click", () => showEx(ex.hidden));

    check.addEventListener("click", () => {
      const chosen = inputs.filter(i => i.checked).map(i => +i.value).sort((a, b) => a - b);
      const need2 = +card.dataset.n2 || need;
      if (chosen.length !== need && chosen.length !== need2) {
        res.className = "qz-res bad";
        res.textContent = need === 1 ? "Choose one option." : "Choose " + need + " options (" + chosen.length + " chosen).";
        return;
      }
      const sets = correctSets(card);
      const ok = sets.includes(chosen.join(","));
      card.querySelectorAll(".qz-opts li").forEach(li => {
        const i = +li.dataset.i, isKey = li.hasAttribute("data-c"), picked = chosen.includes(i);
        li.classList.toggle("is-right", picked && (ok || isKey));
        li.classList.toggle("is-wrong", picked && !ok && !isKey);
        li.classList.toggle("is-missed", !ok && isKey && !picked);
      });
      inputs.forEach(i => (i.disabled = true));
      res.className = "qz-res " + (ok ? "ok" : "bad");
      res.textContent = ok ? (sets.length > 1 && chosen.join(",") !== sets[0] ? "✓ Right (the verified answer; it differs from the key, see below)" : "✓ Right") : "✗ Wrong";
      showEx(true);
      exToggle.hidden = false;
      check.hidden = true;
      again.hidden = false;
      record(card.dataset.qid, chosen, ok).then(() => refresh(card));
      refresh(card);
    });

    function clearCard() {
      inputs.forEach(i => { i.disabled = false; i.checked = false; });
      card.querySelectorAll(".qz-opts li").forEach(li => li.classList.remove("is-right", "is-wrong", "is-missed"));
      res.textContent = "";
      ex.hidden = true;
      exToggle.hidden = true;
      check.hidden = false;
      again.hidden = true;
    }
    again.addEventListener("click", () => { clearCard(); inputs[0].focus(); });
    card.saaClear = clearCard;  // used by the part's "Reset all"

    // Reset: the question's earlier answers stop counting, so it is "not done" again.
    const reset = document.createElement("button");
    reset.className = "btn qz-reset";
    reset.type = "button";
    reset.textContent = "Reset";
    reset.title = "Forget this question's answers: it counts as not done again";
    reset.hidden = true;
    again.after(reset);
    reset.addEventListener("click", () => {
      if (!confirm("Reset " + card.dataset.qid + "? Its answers stop counting and it shows as not done.")) return;
      clearCard();
      resetQuestions([card.dataset.qid]).then(() => refresh(card), () => alert("Could not reset (is the tracker running?)."));
    });
    badge(card);
  }

  const BN_KEY = "saa-bn";  // "1" = show Bangla on every card (the block's "বাংলা: সব" button), this browser
  function showBn(card, on) {
    card.querySelectorAll('[lang="bn"]').forEach(el => { el.hidden = !on; });
    const b = card.querySelector(".qz-bn-btn");
    if (b) b.setAttribute("aria-pressed", String(on));
  }
  function addBnAll(part) {
    const bar = part.querySelector(".qz-filter");
    if (!bar || !part.querySelector(".qz-bnq") || bar.querySelector(".qz-bn-all")) return;
    const btn = document.createElement("button");
    btn.className = "btn qz-bn-all";
    btn.type = "button";
    btn.textContent = "বাংলা: সব";
    btn.title = "Show / hide Bangla on every question (remembered in this browser)";
    btn.setAttribute("aria-pressed", String(SAA.readLocal(BN_KEY) === "1"));
    bar.appendChild(btn);
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      SAA.writeLocal(BN_KEY, on ? "1" : "");
      document.querySelectorAll(".qz-bn-all").forEach(b => b.setAttribute("aria-pressed", String(on)));
      document.querySelectorAll(".qz").forEach(c => { if (c.querySelector(".qz-bnq")) showBn(c, on); });
    });
  }

  // "Reset all" next to a part's filters: every answered question of that part becomes "not done".
  function addResetAll(part) {
    const bar = part.querySelector(".qz-filter");
    if (!bar || bar.querySelector(".qz-reset-all")) return;
    const btn = document.createElement("button");
    btn.className = "btn qz-reset-all";
    btn.type = "button";
    btn.textContent = "Reset all";
    btn.title = "Reset every answered question in this block";
    bar.appendChild(btn);
    btn.addEventListener("click", () => {
      const cards = [...part.querySelectorAll(".qz")].filter(c => status(c.dataset.qid).state !== "new");
      if (!cards.length) { alert("Nothing to reset here: no question in this block is answered yet."); return; }
      if (!confirm("Reset all " + cards.length + " answered question(s) in this block? Their answers stop counting and they show as not done.")) return;
      cards.forEach(c => c.saaClear && c.saaClear());
      resetQuestions(cards.map(c => c.dataset.qid))
        .then(() => { cards.forEach(badge); score(part); }, () => alert("Could not reset (is the tracker running?)."));
    });
  }

  /* ---------- own notes: section note + one note per question (tracker /api/notes) ---------- */
  // Keys: "4" = Section 04 note (also the summary page's "My notes"), "q:S1-Q5" = note on one question.
  const NOTES_LOCAL = "saa-notes";
  let notes = {}, notesLoading = null;
  const noteTimers = {};

  function loadNotes() {
    if (notesLoading) return notesLoading;
    let local = {};
    try { local = JSON.parse(SAA.readLocal(NOTES_LOCAL) || "{}") || {}; } catch (e) { local = {}; }
    notesLoading = (SAA.served
      ? fetch("/api/notes", { cache: "no-store" }).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
      : Promise.resolve({}))
      .then(server => (notes = SAA.served ? server : local));
    return notesLoading;
  }

  const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  // Save one note (debounced) and tell the page, so every view of the same note updates.
  function saveNote(key, text, from, status) {
    if (text.trim()) notes[key] = text; else delete notes[key];
    if (!SAA.served) SAA.writeLocal(NOTES_LOCAL, JSON.stringify(notes));
    document.dispatchEvent(new CustomEvent("saa-note", { detail: { key, from } }));
    if (status) status("Typing…");
    clearTimeout(noteTimers[key]);
    noteTimers[key] = setTimeout(() => {
      if (!SAA.served) { if (status) status("Saved in this browser."); return; }
      post("/api/notes", { section: key, text })
        .then(() => status && status("Saved " + clock()), () => status && status("Not saved on the server."));
    }, 700);
  }

  function noteBox(key, from, placeholder) {
    const box = document.createElement("div");
    box.className = "qz-mynote";
    box.innerHTML = '<textarea rows="3" spellcheck="false"></textarea><small class="muted"></small>';
    const ta = box.querySelector("textarea"), st = box.querySelector("small");
    ta.placeholder = placeholder;
    ta.dataset.size = key.startsWith("q:") ? "qnote" : "secnote";  // saa.js keeps the dragged height
    ta.value = notes[key] || "";
    ta.addEventListener("input", () => saveNote(key, ta.value, from, t => (st.textContent = t)));
    document.addEventListener("saa-note", ev => {
      if (ev.detail.key === key && ev.detail.from !== from && document.activeElement !== ta) ta.value = notes[key] || "";
    });
    return box;
  }

  // "Note" button + box on a question card (pages marked data-qnotes only).
  function addCardNote(card) {
    if (card.querySelector(".qz-note-btn")) return;
    const key = "q:" + card.dataset.qid, from = "card:" + card.dataset.qid;
    const act = card.querySelector(".qz-act");
    const btn = document.createElement("button");
    btn.className = "btn qz-note-btn";
    btn.type = "button";
    act.insertBefore(btn, act.querySelector(".qz-res"));
    const box = noteBox(key, from, "My note for " + card.dataset.qid + "…");
    box.hidden = true;
    act.after(box);
    const mark = () => {
      const has = !!(notes[key] || "").trim();
      btn.textContent = has ? "📝 Note" : "Note";
      card.classList.toggle("has-note", has);
    };
    btn.addEventListener("click", () => { box.hidden = !box.hidden; if (!box.hidden) box.querySelector("textarea").focus(); });
    document.addEventListener("saa-note", ev => { if (ev.detail.key === key) mark(); });
    mark();
  }

  // Panel at the bottom: the section note and every question note of this page (or of the whole section
  // on the summary page), each editable and deletable.
  function initPageNotes() {
    const panel = document.getElementById("page-notes");
    if (!panel) return;
    const sec = panel.dataset.sec;
    const box = panel.querySelector(".pn-section");
    if (box) box.replaceWith(noteBox(sec, "panel", "Notes for Section " + String(sec).padStart(2, "0") + "… (same note on all pages of this section)"));
    const list = panel.querySelector(".pn-list");
    const pages = panel.dataset.pages ? JSON.parse(panel.dataset.pages) : null;
    const ids = () => panel.dataset.scope === "section"
      ? Object.keys(window.SAA_Q || {}).filter(id => String(window.SAA_Q[id][0]) === String(sec))
      : [...document.querySelectorAll(".qz")].map(c => c.dataset.qid);
    function render() {
      const withNote = ids().filter(id => (notes["q:" + id] || "").trim());
      list.replaceChildren();
      if (!withNote.length) {
        list.innerHTML = '<p class="muted">No question notes yet. Use the Note button on a question.</p>';
        return;
      }
      withNote.forEach(id => {
        const item = document.createElement("div");
        item.className = "pn-item";
        item.dataset.k = id;
        const meta = (window.SAA_Q || {})[id];
        const href = pages ? pages.base + pages[meta[5]] + ".html#" + encodeURIComponent(id) : "#" + encodeURIComponent(id);
        item.innerHTML = '<div class="pn-head"><a href="' + href + '"><b>' + id + "</b></a>" +
          (meta ? ' <span class="muted">' + String(meta[2]).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])) + "…</span>" : "") +
          '<button class="btn" type="button">Delete</button></div>';
        item.appendChild(noteBox("q:" + id, "list:" + id, ""));
        item.querySelector(".pn-head .btn").addEventListener("click", () => {
          if (!confirm("Delete the note on " + id + "?")) return;
          saveNote("q:" + id, "", "list:" + id);
        });
        list.appendChild(item);
      });
    }
    document.addEventListener("saa-note", ev => {
      if (!ev.detail.key.startsWith("q:")) return;
      const id = ev.detail.key.slice(2);
      const known = list.querySelector('[data-k="' + CSS.escape(id) + '"]');
      // Re-render only when a note appears or disappears, so typing in the list keeps its focus.
      const has = !!(notes[ev.detail.key] || "").trim();
      if (!!known !== has) render();
    });
    render();
  }

  function bindFilters() {
    document.querySelectorAll("[data-qz-filter]").forEach(btn => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.qzFilter;
        document.body.classList.toggle("qz-only-bad", mode === "bad");
        document.body.classList.toggle("qz-only-new", mode === "new");
        document.querySelectorAll("[data-qz-filter]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.qzFilter === mode)));
      });
    });
  }

  function init() {
    bindFilters();
    load().then(() => {
      document.querySelectorAll(".qz").forEach(enhance);
      document.querySelectorAll(".qz-part").forEach(p => { addBnAll(p); addResetAll(p); score(p); });
      if (document.querySelector("[data-qnotes]") || document.getElementById("page-notes")) {
        loadNotes().then(() => {
          if (document.querySelector("[data-qnotes]")) document.querySelectorAll(".qz").forEach(addCardNote);
          initPageNotes();
        });
      }
      if (location.hash) {
        const target = document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
    });
  }

  window.SAAQuiz = { load, record, status, clearMistakes, resetQuestions, wrongAttempts, enhance, exportFile, importFile, shortDate,
                     data: () => data, DUE_DAYS, CLEAR_AFTER };
  document.addEventListener("DOMContentLoaded", init);
})();
