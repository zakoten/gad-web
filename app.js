// app.js
// La pagina web di Gad: login, profilo (task e progressi), partner in sola lettura,
// messaggio del 17 dicembre, area admin. Tutto passa dal broker MQTT
// (vedi docs/protocollo-mqtt.md): la pagina non ha un server suo.

(function () {
  "use strict";

  const P = window.GadProtocol;
  const CFG = window.GAD_CONFIG;
  const params = new URLSearchParams(location.search);
  // ?broker=ws://127.0.0.1:9001 per le prove, solo quando la pagina gira sul PC:
  // online un link con ?broker= potrebbe mandare le password a un broker estraneo
  const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
  const BROKER = (IS_LOCAL && params.get("broker")) || CFG.brokerUrl;
  const ROOT = CFG.topicRoot;
  const DEVICE_IDS = ["d1", "d2", "d3"];
  const LOGIN_KEY = "gad.login";
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];

  // ------------------------------------------------------------------------
  // Stato della pagina
  // config: undefined = non ancora arrivata, null = non esiste
  // ------------------------------------------------------------------------
  const S = {
    client: null, user: null, status: "off", connecting: false, loginError: "",
    loaded: false, config: undefined,
    tasks: {}, progress: {}, anniversary: {}, command: {},
    sheet: null,          // task in modifica
    annDraft: {},         // messaggio del 17 in scrittura, per dispositivo destinatario
    adminDraft: null,     // configurazione in modifica nell'area admin
  };

  const topic = (dev, kind) => `${ROOT}/dev/${dev}/${kind}`;
  const isAdmin = () => S.user === CFG.adminUser;

  // ------------------------------------------------------------------------
  // Piccolo aiuto per creare elementi senza mai usare innerHTML
  // (i testi scritti dagli utenti finiscono sempre in textContent)
  // ------------------------------------------------------------------------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function storageGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function storageSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* modalità privata */ } }
  function storageDel(key) { try { localStorage.removeItem(key); } catch { /* niente */ } }

  let toastTimer;
  function toast(text) {
    const t = document.getElementById("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ------------------------------------------------------------------------
  // MQTT
  // ------------------------------------------------------------------------
  function connect(user, pass) {
    disconnect();
    Object.assign(S, {
      user, status: "connecting", connecting: true, loginError: "", loaded: false, config: undefined,
      tasks: {}, progress: {}, anniversary: {}, command: {}, adminDraft: null, annDraft: {},
    });
    render();

    const client = mqtt.connect(BROKER, {
      username: user,
      password: pass,
      clientId: `web-${user}-${Math.random().toString(16).slice(2, 8)}`,
      clean: true,
      protocolVersion: 4,
      reconnectPeriod: 4000,
      connectTimeout: 10000,
    });
    S.client = client;
    let everConnected = false;

    const fail = (msg) => {
      if (S.client !== client || everConnected) return;
      client.end(true);
      Object.assign(S, { client: null, user: null, status: "off", connecting: false, loginError: msg });
      storageDel(LOGIN_KEY);
      render();
    };
    const giveUp = setTimeout(() => fail("Can't reach the server. Check your connection and try again."), 12000);

    client.on("connect", () => {
      clearTimeout(giveUp);
      everConnected = true;
      S.status = "on";
      S.connecting = false;
      storageSet(LOGIN_KEY, { user, pass });
      const subs = [`${ROOT}/config`].concat(["tasks", "progress", "anniversary", "command"].map((k) => `${ROOT}/dev/+/${k}`));
      client.subscribe(subs, { qos: 1 }, (err) => {
        if (err) { toast("Couldn't load data. Pull to refresh."); return; }
        // I messaggi retained arrivano subito dopo l'iscrizione: aspettiamo un attimo
        // prima di dire "caricato", così non scriviamo mai sopra dati non ancora letti.
        setTimeout(() => {
          S.loaded = true;
          if (S.config === undefined) S.config = null;
          render();
        }, 800);
      });
      render();
    });

    client.on("message", onMessage);
    client.on("reconnect", () => { if (everConnected) { S.status = "connecting"; renderStatus(); } });
    client.on("offline", () => { if (S.client === client && everConnected) { S.status = "off"; renderStatus(); } });
    client.on("error", (err) => {
      const auth = err && [4, 5, 134, 135].includes(err.code);
      if (auth) fail("Wrong username or password.");
    });
  }

  function disconnect() {
    if (S.client) { S.client.end(true); S.client = null; }
  }

  function onMessage(t, payload) {
    const text = payload.toString();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { return; } }

    if (t === `${ROOT}/config`) {
      S.config = data;
    } else {
      const m = t.match(/\/dev\/(d\d)\/(tasks|progress|anniversary|command)$/);
      if (!m) return;
      const [, dev, kind] = m;
      if (data) S[kind][dev] = data; else delete S[kind][dev];
    }
    if (S.loaded) render();
  }

  // Scrive un messaggio retained (null = cancella)
  function publish(t, obj) {
    if (!S.client || S.status !== "on") { toast("You're offline. Try again in a moment."); return false; }
    S.client.publish(t, obj == null ? "" : JSON.stringify(obj), { qos: 1, retain: true }, (err) => {
      if (err) toast("Couldn't save. Try again.");
    });
    return true;
  }

  // ------------------------------------------------------------------------
  // Dati derivati
  // ------------------------------------------------------------------------
  const devices = () => (S.config && S.config.devices) || [];
  const deviceById = (id) => devices().find((d) => d.id === id);
  const deviceName = (id) => { const d = deviceById(id); return (d && (d.name || d.user)) || id; };
  const myDevice = () => devices().find((d) => d.user === S.user);

  function partnerOf(id) {
    for (const [a, b] of (S.config && S.config.pairs) || []) {
      if (a === id) return b;
      if (b === id) return a;
    }
    return null;
  }

  function nextAnniversaryYear(now = new Date()) {
    const y = now.getFullYear();
    return (now.getMonth() === 11 && now.getDate() > 17) ? y + 1 : y;
  }

  // ------------------------------------------------------------------------
  // Rendering
  // Se l'utente sta scrivendo in un campo, rimandiamo il ridisegno:
  // altrimenti perderebbe il cursore a ogni messaggio in arrivo.
  // ------------------------------------------------------------------------
  let pendingRender = false;
  function render() {
    const app = document.getElementById("app");
    const a = document.activeElement;
    if (a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
      if (!pendingRender) {
        pendingRender = true;
        a.addEventListener("blur", () => { pendingRender = false; render(); }, { once: true });
      }
      return;
    }
    app.replaceChildren(S.user ? viewApp() : viewLogin());
  }

  function renderStatus() {
    const el = document.querySelector(".status");
    if (!el) return;
    el.className = "status " + (S.status === "on" ? "on" : S.status === "off" ? "off" : "");
    el.textContent = S.status === "on" ? "Online" : S.status === "off" ? "Offline" : "Connecting";
  }

  function header(title) {
    const status = h("span", { class: "status" });
    const top = h("div", { class: "top" }, h("h1", { text: title }), h("div", { class: "spacer" }), status);
    queueMicrotask(renderStatus);
    return top;
  }

  function signOutButton() {
    return h("div", { class: "buttons" },
      h("button", { class: "ghost", text: "Sign out", onclick: () => {
        disconnect(); storageDel(LOGIN_KEY);
        Object.assign(S, { user: null, status: "off", loaded: false, config: undefined });
        render();
      } }));
  }

  // ---- Login ---------------------------------------------------------------
  function viewLogin() {
    const user = h("input", { id: "user", autocomplete: "username", autocapitalize: "none", spellcheck: false, required: true });
    const pass = h("input", { id: "pass", type: "password", autocomplete: "current-password", required: true });
    const notSet = BROKER.includes("REPLACE-ME");
    return h("form", { class: "login", onsubmit: (e) => {
      e.preventDefault();
      if (user.value.trim() && pass.value) connect(user.value.trim(), pass.value);
    } },
      h("div", { class: "gad big" }),
      h("h1", { text: "Gad" }),
      h("p", { class: "dim", text: "Sign in to manage your tasks." }),
      h("label", { for: "user", text: "Username" }), user,
      h("label", { for: "pass", text: "Password" }), pass,
      S.loginError && h("div", { class: "errors", text: S.loginError }),
      notSet && h("div", { class: "errors", text: "Server address not set yet (web/config.js)." }),
      h("div", { class: "buttons" },
        h("button", { type: "submit", disabled: S.connecting, text: S.connecting ? "Signing in..." : "Sign in" })));
  }

  // ---- Dopo il login --------------------------------------------------------
  function viewApp() {
    if (!S.loaded) {
      return h("div", {}, header("Gad"), h("div", { class: "card dim", style: "margin-top:20px", text: "Loading..." }));
    }
    if (isAdmin()) return viewAdmin();

    const dev = myDevice();
    if (!S.config || !dev) {
      return h("div", {}, header("Gad"),
        h("div", { class: "card", style: "margin-top:20px" },
          h("p", { style: "margin:0", text: !S.config
            ? "Nothing set up yet. Ask the admin to create the configuration."
            : "This profile isn't linked to a device yet. Ask the admin." })),
        signOutButton());
    }
    return viewProfile(dev);
  }

  function viewProfile(dev) {
    const partner = partnerOf(dev.id);
    const doc = S.tasks[dev.id] || { tasks: [] };
    const full = doc.tasks.length >= P.MAX_TASK_DEFS;

    return h("div", {},
      header(`Hi, ${dev.name || dev.user}`),

      h("h2", { text: "Your Gad" }),
      progressCard(dev.id),

      h("h2", { text: "Today" }),
      todayList(dev.id),

      h("h2", { text: `Tasks (${doc.tasks.length}/${P.MAX_TASK_DEFS})` }),
      h("div", { class: "list" },
        doc.tasks.map((t) => h("div", { class: "item button", onclick: () => openSheet(dev.id, t) },
          h("div", { class: "spacer" },
            h("div", { class: "title", text: t.title }),
            h("div", { class: "sub", text: P.scheduleLabel(t) })),
          h("span", { class: "chev", text: "›" }))),
        h("div", { class: "item button", onclick: () => full ? toast(`Max ${P.MAX_TASK_DEFS} tasks.`) : openSheet(dev.id, null) },
          h("div", { class: "title", style: `color:var(--${full ? "dim" : "accent"})`, text: "+ Add a task" }))),
      h("p", { class: "dim small", style: "margin:10px 4px 0",
        text: `Up to ${P.MAX_TASKS_PER_DAY} tasks a day. Your Gad picks up changes the next time it's online.` }),

      partner && [
        h("h2", { text: `${deviceName(partner)}'s Gad` }),
        progressCard(partner),
        h("div", { style: "height:12px" }),
        todayList(partner),
        h("h2", { text: "December 17 message" }),
        anniversaryCard(dev, partner),
      ],

      h("div", { style: "height:16px" }),
      signOutButton());
  }

  function progressCard(devId) {
    const p = S.progress[devId];
    if (!p) {
      return h("div", { class: "card row" }, h("div", { class: "gad" }),
        h("div", {}, h("div", { class: "title", text: "Waiting for Gad" }),
          h("div", { class: "dim small", text: "It shows up here once the device connects to Wi-Fi." })));
    }
    const info = P.levelInfo(p.exp_x10 || 0);
    const happy = Math.round((p.happiness_x10 || 0) / 10);
    const mult = ((p.mult_x10 || 10) / 10).toFixed(1);
    const isToday = p.day === P.logicalToday();
    const pct = info.cost ? Math.round((info.inLevel / info.cost) * 100) : 100;

    return h("div", { class: "card" },
      h("div", { class: "row" }, h("div", { class: "gad" }),
        h("div", { class: "spacer" },
          h("div", { style: "font-size:22px;font-weight:650", text: `Level ${info.level}` }),
          h("div", { class: "dim small", text: `Updated ${P.timeAgo(p.at)}` }))),
      h("div", { class: "bar" }, h("i", { style: `width:${pct}%` })),
      h("div", { class: "dim small", style: "margin-top:6px",
        text: info.cost ? `${info.inLevel} / ${info.cost} exp to level ${info.level + 1}` : "Max level" }),
      h("div", { class: "stat-grid" },
        h("div", { class: "stat" }, h("div", { class: "label", text: "Happiness" }),
          h("div", { class: "value", text: `${happy}%` }),
          h("div", { class: "bar happy" }, h("i", { style: `width:${happy}%` }))),
        h("div", { class: "stat" }, h("div", { class: "label", text: "Streak" }),
          h("div", { class: "value", text: `${p.streak || 0} ${p.streak === 1 ? "day" : "days"}` }),
          h("div", { class: "dim small", style: "margin-top:6px", text: `x${mult} exp` })),
        h("div", { class: "stat" }, h("div", { class: "label", text: "Tasks today" }),
          h("div", { class: "value", text: isToday ? `${(p.done || []).length} / ${(p.today || []).length}` : "-" }))));
  }

  function todayList(devId) {
    const today = P.logicalToday();
    const tasks = ((S.tasks[devId] || {}).tasks || []).filter((t) => P.appliesOn(t, today)).slice(0, P.MAX_TASKS_PER_DAY);
    const p = S.progress[devId];
    const done = new Set(p && p.day === today ? p.done || [] : []);
    if (!tasks.length) return h("div", { class: "list" }, h("div", { class: "empty", text: "No tasks today" }));
    return h("div", { class: "list" }, tasks.map((t) =>
      h("div", { class: "item" },
        h("span", { class: "check" + (done.has(t.id) ? " done" : "") }),
        h("div", { class: "title", text: t.title }))));
  }

  // ---- Messaggio del 17 dicembre (FR-40) ------------------------------------
  // Si scrive nel topic del PARTNER. Il messaggio ricevuto non si mostra mai: è una sorpresa.
  function anniversaryCard(dev, partner) {
    const saved = S.anniversary[partner];
    const draft = S.annDraft[partner] ?? (saved ? saved.text : "");
    const counter = h("div", { class: "counter" });
    const area = h("textarea", { maxLength: P.MAX_ANNIVERSARY, placeholder: `Write something for ${deviceName(partner)}...`, value: draft });
    const update = () => { counter.textContent = `${area.value.length} / ${P.MAX_ANNIVERSARY}`; S.annDraft[partner] = area.value; };
    area.addEventListener("input", update);
    update();

    const save = () => {
      const text = area.value.trim();
      if (!P.isPlainAscii(text)) { toast("Plain letters only: no accents or emoji yet."); return; }
      const year = nextAnniversaryYear();
      if (publish(topic(partner, "anniversary"), text ? { v: 1, year, from: dev.id, text } : null)) {
        S.anniversary[partner] = text ? { v: 1, year, from: dev.id, text } : undefined;
        delete S.annDraft[partner];
        toast(text ? "Message saved" : "Message removed");
        area.blur();
      }
    };
    return h("div", { class: "card" },
      h("p", { class: "dim small", style: "margin:0 0 12px",
        text: `${deviceName(partner)}'s Gad shows it on December 17. They can't read it here.` }),
      area, counter,
      h("div", { class: "buttons" }, h("button", { text: "Save message", onclick: save })),
      saved && h("p", { class: "dim small", style: "margin:12px 0 0", text: `Saved for ${saved.year}.` }));
  }

  // ---- Foglio per creare / modificare un task --------------------------------
  function openSheet(devId, task) {
    S.sheet = {
      devId,
      isNew: !task,
      task: task ? JSON.parse(JSON.stringify(task)) : { title: "", type: "daily", days: [1, 2, 3, 4, 5], date: P.logicalToday() },
      errors: [],
    };
    if (S.sheet.task.type !== "weekdays" && !S.sheet.task.days) S.sheet.task.days = [1, 2, 3, 4, 5];
    if (S.sheet.task.type !== "once" && !S.sheet.task.date) S.sheet.task.date = P.logicalToday();
    renderSheet();
  }

  function closeSheet() { S.sheet = null; renderSheet(); }

  function renderSheet() {
    let host = document.getElementById("sheet");
    if (!S.sheet) { if (host) host.remove(); return; }
    if (!host) { host = h("div", { id: "sheet" }); document.body.append(host); }
    const sh = S.sheet, t = sh.task;

    const counter = h("div", { class: "counter", text: `${t.title.length} / ${P.MAX_TITLE}` });
    const title = h("input", { value: t.title, maxLength: P.MAX_TITLE, placeholder: "e.g. Drink water",
      autocapitalize: "sentences", oninput: (e) => { t.title = e.target.value; counter.textContent = `${t.title.length} / ${P.MAX_TITLE}`; } });

    const typeBtn = (type, label) => h("button", { type: "button", class: t.type === type ? "on" : "",
      text: label, onclick: () => { t.type = type; renderSheet(); } });

    const order = [1, 2, 3, 4, 5, 6, 0];   // lunedì per primo
    const days = h("div", { class: "days" }, order.map((d) => h("button", { type: "button",
      class: t.days.includes(d) ? "on" : "", text: P.DAY_NAMES[d].slice(0, 2),
      onclick: () => { t.days = t.days.includes(d) ? t.days.filter((x) => x !== d) : t.days.concat(d); renderSheet(); } })));

    const date = h("input", { type: "date", value: t.date, min: P.logicalToday(), onchange: (e) => { t.date = e.target.value; } });

    host.replaceChildren(h("div", { class: "sheet-bg", onclick: (e) => { if (e.target === e.currentTarget) closeSheet(); } },
      h("div", { class: "sheet", role: "dialog", "aria-modal": "true" },
        h("h3", { text: sh.isNew ? "New task" : "Edit task" }),
        h("label", { text: "Name" }), title, counter,
        h("label", { text: "When" }),
        h("div", { class: "segmented" }, typeBtn("daily", "Every day"), typeBtn("weekdays", "Some days"), typeBtn("once", "One day")),
        t.type === "weekdays" && [h("label", { text: "Days" }), days],
        t.type === "once" && [h("label", { text: "Date" }), date],
        sh.errors.length > 0 && h("div", { class: "errors" }, sh.errors.map((e) => h("div", { text: e }))),
        h("div", { class: "buttons" },
          h("button", { text: "Save", onclick: saveSheet }),
          !sh.isNew && h("button", { class: "danger", text: "Delete task", onclick: deleteFromSheet }),
          h("button", { class: "ghost", text: "Cancel", onclick: closeSheet })))));
    if (sh.isNew && !t.title) setTimeout(() => title.focus(), 50);
  }

  // Tiene solo i campi che servono al tipo scelto
  function cleanTask(t, id) {
    const out = { id, title: t.title.trim(), type: t.type };
    if (t.type === "weekdays") out.days = [...new Set(t.days)].sort((a, b) => a - b);
    if (t.type === "once") out.date = t.date;
    return out;
  }

  function writeTasks(devId, list) {
    const old = S.tasks[devId] || { rev: 0, tasks: [] };
    const lastId = Math.max(old.last_id || 0, ...list.map((t) => t.id), 0);
    const doc = { v: 1, rev: (old.rev || 0) + 1, last_id: lastId, tasks: list };
    if (publish(topic(devId, "tasks"), doc)) { S.tasks[devId] = doc; return true; }
    return false;
  }

  function saveSheet() {
    const sh = S.sheet;
    const old = S.tasks[sh.devId] || { tasks: [] };
    const id = sh.isNew ? P.nextTaskId(old.tasks, [old.last_id || 0]) : sh.task.id;
    const task = cleanTask(sh.task, id);
    const list = sh.isNew ? old.tasks.concat(task) : old.tasks.map((t) => (t.id === id ? task : t));
    sh.errors = P.validateTasks(list);
    if (sh.errors.length) { renderSheet(); return; }
    if (writeTasks(sh.devId, list)) { closeSheet(); toast(sh.isNew ? "Task added" : "Task saved"); render(); }
  }

  function deleteFromSheet() {
    const sh = S.sheet;
    if (!confirm(`Delete "${sh.task.title}"?`)) return;
    const old = S.tasks[sh.devId] || { tasks: [] };
    if (writeTasks(sh.devId, old.tasks.filter((t) => t.id !== sh.task.id))) { closeSheet(); toast("Task deleted"); render(); }
  }

  // ---- Area admin (FR-28, FR-30, FR-32, FR-41, FR-45) -------------------------
  function defaultConfig() {
    return {
      v: 1, rev: 0,
      devices: DEVICE_IDS.map((id, i) => ({ id, user: `user${i + 1}`, name: `Device ${i + 1}` })),
      pairs: [["d1", "d2"]],
      together_since: "2026-12-17",
      birthdays: {},
    };
  }

  function viewAdmin() {
    if (!S.adminDraft) S.adminDraft = JSON.parse(JSON.stringify(S.config || defaultConfig()));
    const d = S.adminDraft;
    const pair = (d.pairs && d.pairs[0]) || ["", ""];
    const unpaired = DEVICE_IDS.filter((id) => !pair.includes(id));

    const devRows = d.devices.map((dev) => h("div", { class: "item", style: "display:block" },
      h("div", { class: "row" }, h("span", { class: "pill accent", text: dev.id }),
        h("div", { class: "dim small", text: S.progress[dev.id] ? `Seen ${P.timeAgo(S.progress[dev.id].at)}` : "Never seen" })),
      h("label", { text: "Name shown" }),
      h("input", { value: dev.name || "", oninput: (e) => { dev.name = e.target.value; } }),
      h("label", { text: "Username (same as the broker login)" }),
      h("input", { value: dev.user || "", autocapitalize: "none", spellcheck: false, oninput: (e) => { dev.user = e.target.value.trim(); } })));

    const devOptions = (selected) => [h("option", { value: "", text: "None", selected: !selected })]
      .concat(DEVICE_IDS.map((id) => h("option", { value: id, text: `${id}  ${(d.devices.find((x) => x.id === id) || {}).name || ""}`, selected: id === selected })));
    const pairA = h("select", { onchange: (e) => { setPair(e.target.value, pair[1]); } }, devOptions(pair[0]));
    const pairB = h("select", { onchange: (e) => { setPair(pair[0], e.target.value); } }, devOptions(pair[1]));
    function setPair(a, b) { d.pairs = a && b && a !== b ? [[a, b]] : (a || b ? [[a, b]] : []); render(); }

    const together = h("input", { type: "date", value: d.together_since || "", onchange: (e) => { d.together_since = e.target.value; } });

    const birthdayRows = unpaired.map((id) => {
      const [mm, dd] = ((d.birthdays || {})[id] || "-").split("-");
      const month = h("select", { onchange: (e) => setBirthday(id, e.target.value, dd) },
        h("option", { value: "", text: "Month" }),
        MONTHS_LONG.map((m, i) => h("option", { value: String(i + 1).padStart(2, "0"), text: m, selected: mm === String(i + 1).padStart(2, "0") })));
      const day = h("select", { onchange: (e) => setBirthday(id, mm, e.target.value) },
        h("option", { value: "", text: "Day" }),
        Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, "0")).map((v) => h("option", { value: v, text: String(Number(v)), selected: dd === v })));
      return [h("label", { text: `Birthday of ${deviceName(id) || id} (${id})` }), h("div", { class: "buttons two", style: "margin-top:0" }, month, day)];
    });
    function setBirthday(id, mm, dd) {
      d.birthdays = d.birthdays || {};
      if (mm && dd && mm !== "-" && dd !== undefined) d.birthdays[id] = `${mm}-${dd}`; else delete d.birthdays[id];
      render();
    }

    return h("div", {},
      header("Admin"),
      !S.config && h("div", { class: "errors", text: "No configuration on the server yet. Check the values below and save." }),

      h("h2", { text: "Devices" }),
      h("div", { class: "list" }, devRows),

      h("h2", { text: "Pairing" }),
      h("div", { class: "card" },
        h("p", { class: "dim small", style: "margin:0 0 10px", text: "Only these two devices send gestures and meet each other." }),
        h("div", { class: "buttons two", style: "margin-top:0" }, pairA, pairB)),

      h("h2", { text: "Dates" }),
      h("div", { class: "card" },
        h("label", { style: "margin-top:0", text: "Together since (days counter)" }), together,
        birthdayRows),

      h("div", { class: "buttons" }, h("button", { text: "Save configuration", onclick: saveConfig })),

      h("h2", { text: "Status" }),
      DEVICE_IDS.map((id) => [h("div", { class: "dim small", style: "margin:14px 4px 8px", text: `${deviceName(id)} (${id})` }), progressCard(id)]),

      h("h2", { text: "Reset" }),
      h("div", { class: "list" }, DEVICE_IDS.map((id) => h("div", { class: "item" },
        h("div", { class: "spacer" }, h("div", { class: "title", text: deviceName(id) }),
          h("div", { class: "sub", text: S.command[id] ? `Last reset #${S.command[id].reset}` : "Never reset" })),
        h("button", { class: "danger", style: "width:auto", text: "Reset", onclick: () => resetDevice(id) })))),

      h("div", { style: "height:16px" }),
      signOutButton());
  }

  function saveConfig() {
    const d = S.adminDraft;
    const users = d.devices.map((x) => x.user);
    const errs = [];
    if (users.some((u) => !u)) errs.push("Every device needs a username.");
    if (new Set(users).size !== users.length) errs.push("Usernames must be different.");
    if (users.includes(CFG.adminUser)) errs.push(`"${CFG.adminUser}" is reserved for the admin.`);
    const pair = (d.pairs || [])[0];
    if (pair && (!pair[0] || !pair[1] || pair[0] === pair[1])) errs.push("Pick two different devices to pair, or None for both.");
    if (d.together_since && !P.isValidDate(d.together_since)) errs.push("Check the 'together since' date.");
    if (errs.length) { toast(errs[0]); return; }

    const doc = {
      v: 1,
      rev: ((S.config && S.config.rev) || 0) + 1,
      devices: d.devices.map((x) => ({ id: x.id, user: x.user, name: (x.name || "").trim() })),
      pairs: pair ? [pair] : [],
      together_since: d.together_since || "",
      birthdays: Object.fromEntries(Object.entries(d.birthdays || {}).filter(([id]) => !(pair || []).includes(id))),
    };
    if (publish(`${ROOT}/config`, doc)) {
      S.config = doc;
      S.adminDraft = null;
      toast("Configuration saved");
      render();
    }
  }

  function resetDevice(id) {
    const answer = prompt(`This erases ${deviceName(id)}'s level, exp and streak. It can't be undone.\n\nType RESET to confirm.`);
    if (answer !== "RESET") { if (answer !== null) toast("Not reset"); return; }
    const n = ((S.command[id] && S.command[id].reset) || 0) + 1;
    if (publish(topic(id, "command"), { v: 1, reset: n })) {
      publish(topic(id, "progress"), null);   // niente vecchio backup da ripristinare
      S.command[id] = { v: 1, reset: n };
      delete S.progress[id];
      toast(`${deviceName(id)} will reset next time it's online`);
      render();
    }
  }

  // ------------------------------------------------------------------------
  // Avvio: se le credenziali sono salvate, entra direttamente
  // ------------------------------------------------------------------------
  const saved = storageGet(LOGIN_KEY);
  if (saved && saved.user && saved.pass) connect(saved.user, saved.pass);
  else render();

  // Ogni minuto aggiorna "Updated 3 min ago" e la giornata
  setInterval(() => { if (S.loaded) render(); }, 60000);
})();
