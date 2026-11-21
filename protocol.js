// protocol.js
// Regole condivise con il dispositivo (vedi docs/protocollo-mqtt.md e app/core/gad_model.cpp).
// Niente DOM e niente MQTT: così si testa con Node (web/protocol.test.js).

(function (exports) {
  "use strict";

  const MAX_TASK_DEFS = 12;
  const MAX_TASKS_PER_DAY = 5;
  const MAX_TITLE = 31;
  const MAX_DATES = 8;            // date di un task "dates" (come GAD_TASK_MAX_DATES nel firmware)
  const MAX_ANNIVERSARY = 280;
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DAY_NAMES_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const GESTURES = ["Heart", "Miss you", "Love you", "Hug", "Good night"];

  // Il font del dispositivo ha solo caratteri ASCII stampabili
  const isPlainAscii = (s) => /^[\x20-\x7E]*$/.test(s);

  // "2026-12-03" -> giorno della settimana (0 = domenica), senza problemi di fuso orario
  function weekdayOf(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  function isValidDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) return false;
    const [y, m, d] = dateStr.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  // La giornata del dispositivo cambia alle 4:00: prima delle 4 è ancora "ieri"
  function logicalToday(now = new Date()) {
    const t = new Date(now.getTime() - 4 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }

  // Il task vale in questo giorno?
  function appliesOn(task, dateStr) {
    switch (task.type) {
      case "daily": return true;
      case "weekdays": return (task.days || []).includes(weekdayOf(dateStr));
      case "once": return task.date === dateStr;
      case "dates": return (task.dates || []).includes(dateStr);
      default: return false;
    }
  }

  // Quanti task in un certo giorno della settimana (contando le una tantum solo se c'è la data)
  function loadOn(tasks, weekday, dateStr) {
    return tasks.filter((t) =>
      t.type === "daily" ||
      (t.type === "weekdays" && (t.days || []).includes(weekday)) ||
      (t.type === "once" && dateStr && t.date === dateStr) ||
      (t.type === "dates" && dateStr && (t.dates || []).includes(dateStr))
    ).length;
  }

  // Ritorna un elenco di errori in inglese (vuoto = tutto ok)
  function validateTasks(tasks) {
    const errors = [];
    if (tasks.length > MAX_TASK_DEFS) errors.push(`You can have at most ${MAX_TASK_DEFS} tasks.`);

    for (const t of tasks) {
      const title = (t.title || "").trim();
      if (!title) errors.push("Every task needs a name.");
      else if (title.length > MAX_TITLE) errors.push(`"${title}" is too long (max ${MAX_TITLE} characters).`);
      else if (!isPlainAscii(title)) errors.push(`"${title}": use plain letters only, no accents or emoji. Gad can't show them yet.`);
      if (t.type === "weekdays" && !(t.days || []).length) errors.push(`"${title}": pick at least one day.`);
      if (t.type === "once" && !isValidDate(t.date)) errors.push(`"${title}": pick a date.`);
      if (t.type === "dates") {
        const ds = t.dates || [];
        if (!ds.length || !ds.every(isValidDate)) errors.push(`"${title}": pick at least one date.`);
        else if (ds.length > MAX_DATES) errors.push(`"${title}": at most ${MAX_DATES} dates.`);
      }
    }

    // Un solo messaggio per tutti i giorni troppo pieni (lunedì per primo)
    const full = [1, 2, 3, 4, 5, 6, 0].filter((wd) => loadOn(tasks, wd, null) > MAX_TASKS_PER_DAY);
    if (full.length === 1) {
      errors.push(`Too many tasks on ${DAY_NAMES_LONG[full[0]]}s (${loadOn(tasks, full[0], null)}). Max ${MAX_TASKS_PER_DAY} per day.`);
    } else if (full.length > 1) {
      errors.push(`Too many tasks on ${full.map((d) => DAY_NAMES[d]).join(", ")}. Max ${MAX_TASKS_PER_DAY} per day.`);
    }
    // Ogni data precisa (una tantum o di un task "dates") non deve superare il massimo del giorno
    const onceDates = [...new Set(tasks.flatMap((t) =>
      t.type === "once" ? [t.date] : t.type === "dates" ? (t.dates || []) : []).filter(isValidDate))];
    for (const d of onceDates) {
      const n = loadOn(tasks, weekdayOf(d), d);
      if (n > MAX_TASKS_PER_DAY) errors.push(`Too many tasks on ${formatDate(d)} (${n}). Max ${MAX_TASKS_PER_DAY} per day.`);
    }
    return [...new Set(errors)];
  }

  function nextTaskId(tasks, usedIds = []) {
    const all = tasks.map((t) => t.id).concat(usedIds);
    const max = all.length ? Math.max(...all) : 0;
    return max >= 65535 ? 1 : max + 1;
  }

  function formatDate(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return `${MONTHS[m - 1]} ${d}`;
  }

  function scheduleLabel(task) {
    if (task.type === "daily") return "Every day";
    if (task.type === "once") return isValidDate(task.date) ? formatDate(task.date) : "One day";
    if (task.type === "dates") {
      const ds = (task.dates || []).filter(isValidDate).sort();
      if (!ds.length) return "Some dates";
      const shown = ds.slice(0, 3).map(formatDate).join(", ");
      return ds.length > 3 ? `${shown} +${ds.length - 3}` : shown;
    }
    const days = [...(task.days || [])].sort();
    const key = days.join(",");
    if (key === "1,2,3,4,5") return "Weekdays";
    if (key === "0,6") return "Weekends";
    if (days.length === 7) return "Every day";
    // Lunedì per primo, domenica in fondo
    return days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join(", ");
  }

  // Curva dei livelli, identica a gad_level_cost_x10 del firmware
  function levelCostX10(level) {
    return level >= 100 ? 0 : 2000 + 200 * (level - 1);
  }

  function levelInfo(totalExpX10) {
    let left = totalExpX10, level = 1;
    while (level < 100 && left >= levelCostX10(level)) { left -= levelCostX10(level); level++; }
    return { level, inLevel: Math.floor(left / 10), cost: levelCostX10(level) / 10 };
  }

  function timeAgo(unixSeconds, now = Date.now()) {
    const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? "yesterday" : `${d} days ago`;
  }

  Object.assign(exports, {
    MAX_TASK_DEFS, MAX_TASKS_PER_DAY, MAX_TITLE, MAX_DATES, MAX_ANNIVERSARY, DAY_NAMES, GESTURES,
    isPlainAscii, weekdayOf, isValidDate, logicalToday, appliesOn, validateTasks, nextTaskId,
    formatDate, scheduleLabel, levelCostX10, levelInfo, timeAgo,
  });
})(typeof module !== "undefined" ? module.exports : (window.GadProtocol = {}));
