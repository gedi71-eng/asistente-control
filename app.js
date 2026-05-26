const STORAGE_KEY = "asistente-control-v1";

const defaultState = {
  tasks: [],
  attentions: [],
  events: [],
  expenses: [],
  transactions: [],
  settings: {
    alarmsEnabled: false,
    voiceEnabled: true,
    leadMinutes: 5,
    leadTimes: [1440, 60, 30, 0]
  },
  firedAlarms: {}
};

const ALARM_OPTIONS = [
  { value: 4320, label: "3 días" },
  { value: 2880, label: "2 días" },
  { value: 1440, label: "1 día" },
  { value: 60, label: "1 hora" },
  { value: 30, label: "30 min" },
  { value: 0, label: "a la hora" }
];

let state = loadState();
let audioContext = null;
let deferredInstallPrompt = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const formatMoney = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0
});

const formatDateTime = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short"
});

const formatDate = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium"
});

const formatTime = new Intl.DateTimeFormat("es-CO", {
  hour: "2-digit",
  minute: "2-digit"
});

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return stored ? mergeState(defaultState, stored) : structuredClone(defaultState);
  } catch {
    return structuredClone(defaultState);
  }
}

function mergeState(base, incoming) {
  const merged = {
    ...base,
    ...incoming,
    settings: { ...base.settings, ...(incoming.settings || {}) },
    firedAlarms: incoming.firedAlarms || {}
  };

  if (!merged.transactions?.length && merged.expenses?.length) {
    merged.transactions = merged.expenses.map((expense) => ({
      ...expense,
      type: "expense",
      notes: expense.notes || ""
    }));
  }

  if (!Array.isArray(merged.settings.leadTimes)) {
    const legacyLead = Number(merged.settings.leadMinutes);
    merged.settings.leadTimes = Number.isFinite(legacyLead) ? [legacyLead] : base.settings.leadTimes;
  }
  merged.settings.leadTimes = [...new Set(merged.settings.leadTimes.map(Number))]
    .filter((value) => ALARM_OPTIONS.some((option) => option.value === value));
  if (!merged.settings.leadTimes.length) merged.settings.leadTimes = base.settings.leadTimes;

  return merged;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseDate(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inputDateValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function isThisMonth(date) {
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(date, amount) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function startOfWeek(date) {
  const start = startOfDay(date);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  return start;
}

function endOfWeek(date) {
  const end = endOfDay(startOfWeek(date));
  end.setDate(end.getDate() + 6);
  return end;
}

function rangeFor(value) {
  const now = new Date();
  const ranges = {
    today: {
      label: "hoy",
      start: startOfDay(now),
      end: endOfDay(now)
    },
    week: {
      label: "esta semana",
      start: startOfWeek(now),
      end: endOfWeek(now)
    },
    month: {
      label: "este mes",
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    },
    year: {
      label: "este año",
      start: new Date(now.getFullYear(), 0, 1),
      end: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999)
    },
    future: {
      label: "lo próximo",
      start: now,
      end: null
    }
  };

  return ranges[value] || ranges.today;
}

function financeRangeFor(value, selectedYear) {
  const now = new Date();
  const year = Number(selectedYear) || now.getFullYear();
  const ranges = {
    day: {
      label: "hoy",
      start: startOfDay(now),
      end: endOfDay(now)
    },
    "15days": {
      label: "los últimos 15 días",
      start: startOfDay(addDays(now, -14)),
      end: endOfDay(now)
    },
    month: {
      label: "este mes",
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    },
    quarter: {
      label: "los últimos 3 meses",
      start: new Date(now.getFullYear(), now.getMonth() - 2, 1),
      end: endOfDay(now)
    },
    year: {
      label: `el año ${year}`,
      start: new Date(year, 0, 1),
      end: new Date(year, 11, 31, 23, 59, 59, 999)
    },
    all: {
      label: "todos los años",
      start: null,
      end: null
    }
  };

  return ranges[value] || ranges.month;
}

function cleanText(value) {
  return String(value || "").trim();
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => el.classList.remove("show"), 2800);
}

function speak(text) {
  if (!state.settings.voiceEnabled || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "es-CO";
  utterance.rate = 0.96;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function ensureAudio() {
  if (!audioContext) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context) audioContext = new Context();
  }
  if (audioContext?.state === "suspended") audioContext.resume();
}

function beep() {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 760;
  gain.gain.setValueAtTime(0.001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.22, audioContext.currentTime + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.55);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.58);
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
  toast(`${title}: ${body}`);
}

function createItem(type, formData) {
  const base = {
    id: uid(),
    createdAt: new Date().toISOString()
  };

  if (type === "task") {
    state.tasks.unshift({
      ...base,
      title: cleanText(formData.get("title")),
      due: formData.get("due"),
      priority: formData.get("priority"),
      notes: cleanText(formData.get("notes")),
      done: false
    });
    toast("Pendiente guardado");
  }

  if (type === "attention") {
    state.attentions.unshift({
      ...base,
      person: cleanText(formData.get("person")),
      subject: cleanText(formData.get("subject")),
      status: formData.get("status"),
      followUp: formData.get("followUp"),
      notes: cleanText(formData.get("notes"))
    });
    toast("Atención guardada");
  }

  if (type === "event") {
    state.events.unshift({
      ...base,
      title: cleanText(formData.get("title")),
      start: formData.get("start"),
      end: formData.get("end"),
      place: cleanText(formData.get("place")),
      notes: cleanText(formData.get("notes"))
    });
    toast("Evento guardado");
  }

  if (type === "expense") {
    state.expenses.unshift({
      ...base,
      description: cleanText(formData.get("description")),
      amount: Number(formData.get("amount") || 0),
      category: formData.get("category"),
      date: formData.get("date")
    });
    toast("Gasto guardado");
  }

  if (type === "finance") {
    state.transactions.unshift({
      ...base,
      type: formData.get("type") === "income" ? "income" : "expense",
      description: cleanText(formData.get("description")),
      amount: Number(formData.get("amount") || 0),
      category: formData.get("category"),
      date: formData.get("date"),
      notes: cleanText(formData.get("notes"))
    });
    toast("Movimiento guardado");
  }

  saveState();
  render();
}

function updateItem(collection, id, patch) {
  state[collection] = state[collection].map((item) => item.id === id ? { ...item, ...patch } : item);
  saveState();
  render();
}

function deleteItem(collection, id) {
  state[collection] = state[collection].filter((item) => item.id !== id);
  saveState();
  render();
}

function reminderItems() {
  const tasks = state.tasks
    .filter((task) => !task.done && task.due)
    .map((task) => ({
      id: `task-${task.id}`,
      rawId: task.id,
      collection: "tasks",
      kind: "Pendiente",
      title: task.title,
      detail: task.priority,
      at: parseDate(task.due),
      notes: task.notes
    }));

  const attentions = state.attentions
    .filter((attention) => attention.status !== "cerrada" && attention.followUp)
    .map((attention) => ({
      id: `attention-${attention.id}`,
      rawId: attention.id,
      collection: "attentions",
      kind: "Atención",
      title: `${attention.person}: ${attention.subject}`,
      detail: attention.status,
      at: parseDate(attention.followUp),
      notes: attention.notes
    }));

  const events = state.events
    .filter((event) => event.start)
    .map((event) => ({
      id: `event-${event.id}`,
      rawId: event.id,
      collection: "events",
      kind: "Evento",
      title: event.title,
      detail: event.place,
      at: parseDate(event.start),
      notes: event.notes
    }));

  return [...tasks, ...attentions, ...events]
    .filter((item) => item.at)
    .sort((a, b) => a.at - b.at);
}

function activeLeadTimes() {
  return [...new Set((state.settings.leadTimes || []).map(Number))]
    .filter((value) => ALARM_OPTIONS.some((option) => option.value === value))
    .sort((a, b) => a - b);
}

function leadLabel(minutes) {
  return ALARM_OPTIONS.find((option) => option.value === minutes)?.label || `${minutes} min`;
}

function humanUntil(date, now = new Date()) {
  const diff = Math.max(0, date - now);
  const minutes = Math.round(diff / 60000);

  if (minutes < 1) return "ahora";
  if (minutes < 60) return `en ${minutes} minutos`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `en ${hours} horas`;

  const days = Math.round(hours / 24);
  return `en ${days} días`;
}

function alarmKey(item, leadMinutes) {
  return `${item.id}-${item.at.toISOString()}-${leadMinutes}`;
}

function checkAlarms() {
  if (!state.settings.alarmsEnabled) return;

  const now = new Date();
  const leads = activeLeadTimes();

  reminderItems().forEach((item) => {
    if (item.at - now < -2 * 60 * 1000) return;

    const dueLead = leads.find((leadMinutes) => {
      const alarmAt = new Date(item.at.getTime() - leadMinutes * 60 * 1000);
      return now >= alarmAt && !state.firedAlarms[alarmKey(item, leadMinutes)];
    });
    if (dueLead === undefined) return;

    const key = alarmKey(item, dueLead);


    state.firedAlarms[key] = new Date().toISOString();
    saveState();

    const timing = humanUntil(item.at, now);
    const message = `${item.kind} ${timing}: ${item.title}. Recordatorio ${leadLabel(dueLead)}.`;

    beep();
    notify("Recordatorio", message);
    speak(message);
  });
}

function speakPending() {
  const openTasks = state.tasks.filter((task) => !task.done);
  const openAttentions = state.attentions.filter((attention) => attention.status !== "cerrada");
  const nextItems = reminderItems().filter((item) => item.at >= new Date()).slice(0, 4);
  const monthItems = financialItems().filter((item) => {
    const date = parseDate(item.date);
    return date && isThisMonth(date);
  });
  const { balance } = financeTotals(monthItems);

  if (!openTasks.length && !openAttentions.length && !nextItems.length) {
    speak("No tienes pendientes abiertos por ahora.");
    toast("No hay pendientes abiertos");
    return;
  }

  const parts = [
    `Tienes ${openTasks.length} pendientes abiertos y ${openAttentions.length} atenciones activas.`
  ];

  if (nextItems.length) {
    const nextText = nextItems
      .map((item) => `${item.kind}: ${item.title}, ${formatDateTime.format(item.at)}`)
      .join(". ");
    parts.push(`Lo próximo es: ${nextText}.`);
  }

  parts.push(`El balance financiero del mes es ${formatMoney.format(balance)}.`);
  speak(parts.join(" "));
}

function agendaItemsForRange(value) {
  const range = rangeFor(value);
  return reminderItems().filter((item) => item.at >= range.start && (!range.end || item.at <= range.end));
}

function speakSchedule() {
  const selectedRange = $("#scheduleRange").value;
  const range = rangeFor(selectedRange);
  const items = agendaItemsForRange(selectedRange);

  if (!items.length) {
    speak(`No hay eventos ni vencimientos para ${range.label}.`);
    toast(`Sin agenda para ${range.label}`);
    return;
  }

  const preview = items.slice(0, 10)
    .map((item) => `${item.kind}: ${item.title}, ${formatDateTime.format(item.at)}`)
    .join(". ");
  const extra = items.length > 10 ? ` Hay ${items.length - 10} registros adicionales.` : "";

  speak(`Agenda de ${range.label}. Tienes ${items.length} registros. ${preview}.${extra}`);
}

function render() {
  renderMetrics();
  renderDashboard();
  renderTasks();
  renderAttentions();
  renderSchedule();
  renderFinance();
  renderControls();
}

function renderControls() {
  const activeLeads = activeLeadTimes();
  $$("input[name='leadTimes']").forEach((input) => {
    input.checked = activeLeads.includes(Number(input.value));
  });
  $("#alarmProfile").textContent = `${activeLeads.length} alarmas`;
  $("#enableAlarms").textContent = state.settings.alarmsEnabled ? "Alarmas activas" : "Activar alarmas";
  $("#enableAlarms").classList.toggle("active", state.settings.alarmsEnabled);
}

function renderMetrics() {
  const now = new Date();
  const openTasks = state.tasks.filter((task) => !task.done);
  const dueToday = reminderItems().filter((item) => isSameDay(item.at, now));
  const openAttentions = state.attentions.filter((attention) => attention.status !== "cerrada");
  const monthItems = financialItems().filter((item) => {
    const date = parseDate(item.date);
    return date && isThisMonth(date);
  });
  const { balance } = financeTotals(monthItems);

  $("#metricTasks").textContent = openTasks.length;
  $("#metricToday").textContent = dueToday.length;
  $("#metricAttentions").textContent = openAttentions.length;
  $("#metricFinance").textContent = formatMoney.format(balance);
}

function renderDashboard() {
  const now = new Date();
  $("#clock").textContent = formatTime.format(now);

  const reminders = reminderItems();
  const next = reminders.find((item) => item.at >= now);
  const overdue = reminders.filter((item) => item.at < now);
  const today = reminders.filter((item) => item.at >= now && isSameDay(item.at, now)).slice(0, 5);

  $("#nextReminder").innerHTML = next
    ? `<span>Próximo</span><strong>${escapeHtml(next.title)}</strong><small>${next.kind} · ${formatDateTime.format(next.at)}</small>`
    : `<span>Próximo</span><strong>Sin recordatorios programados</strong><small>Agenda despejada</small>`;

  $("#dueList").innerHTML = today.length
    ? today.map(renderReminderRow).join("")
    : emptyState("Nada con hora para hoy");

  if (overdue.length) {
    $("#dueList").insertAdjacentHTML("afterbegin", overdue.slice(0, 3).map((item) => renderReminderRow(item, true)).join(""));
  }

  $("#timeline").innerHTML = reminders.filter((item) => item.at >= now).slice(0, 7).map(renderTimelineItem).join("") ||
    emptyState("Sin agenda próxima");
}

function renderTasks() {
  const filter = $("#taskFilter").value;
  const now = new Date();
  let tasks = [...state.tasks];

  if (filter === "open") tasks = tasks.filter((task) => !task.done);
  if (filter === "today") {
    tasks = tasks.filter((task) => {
      const date = parseDate(task.due);
      return date && isSameDay(date, now);
    });
  }

  tasks.sort((a, b) => {
    const aDate = parseDate(a.due)?.getTime() || Infinity;
    const bDate = parseDate(b.due)?.getTime() || Infinity;
    return aDate - bDate;
  });

  $("#taskList").innerHTML = tasks.map((task) => `
    <article class="item ${task.done ? "done" : ""}">
      <div>
        <div class="item-title">${escapeHtml(task.title)}</div>
        <div class="item-meta">${task.due ? formatDateTime.format(parseDate(task.due)) : "Sin vencimiento"} · prioridad ${escapeHtml(task.priority)}</div>
        ${task.notes ? `<p>${escapeHtml(task.notes)}</p>` : ""}
      </div>
      <div class="item-actions">
        <button type="button" data-action="toggle-task" data-id="${task.id}">${task.done ? "Abrir" : "Listo"}</button>
        <button type="button" data-action="delete-task" data-id="${task.id}">Borrar</button>
      </div>
    </article>
  `).join("") || emptyState("Sin pendientes en esta vista");
}

function renderAttentions() {
  const query = cleanText($("#attentionSearch").value).toLowerCase();
  const attentions = state.attentions
    .filter((attention) => {
      const text = `${attention.person} ${attention.subject} ${attention.notes}`.toLowerCase();
      return text.includes(query);
    })
    .sort((a, b) => (parseDate(a.followUp)?.getTime() || Infinity) - (parseDate(b.followUp)?.getTime() || Infinity));

  $("#attentionList").innerHTML = attentions.map((attention) => `
    <article class="item">
      <div>
        <div class="item-title">${escapeHtml(attention.person)}</div>
        <div class="item-meta">${escapeHtml(attention.subject)} · ${escapeHtml(attention.status)}</div>
        <div class="item-meta">${attention.followUp ? `Seguimiento: ${formatDateTime.format(parseDate(attention.followUp))}` : "Sin seguimiento programado"}</div>
        ${attention.notes ? `<p>${escapeHtml(attention.notes)}</p>` : ""}
      </div>
      <div class="item-actions">
        <button type="button" data-action="close-attention" data-id="${attention.id}">Cerrar</button>
        <button type="button" data-action="delete-attention" data-id="${attention.id}">Borrar</button>
      </div>
    </article>
  `).join("") || emptyState("Sin atenciones registradas");
}

function renderSchedule() {
  const selectedRange = $("#scheduleRange").value;
  const range = rangeFor(selectedRange);
  const items = agendaItemsForRange(selectedRange);

  $("#scheduleSummary").innerHTML = `
    <strong>${items.length}</strong>
    <span>${items.length === 1 ? "registro" : "registros"} para ${escapeHtml(range.label)}</span>
  `;
  $("#scheduleList").innerHTML = items.map(renderScheduleItem).join("") ||
    emptyState(`Sin eventos ni vencimientos para ${range.label}`);
}

function financialItems() {
  return [...(state.transactions || [])].map((item) => ({
    ...item,
    type: item.type === "income" ? "income" : "expense"
  }));
}

function financeYears(items = financialItems()) {
  const years = items
    .map((item) => parseDate(item.date)?.getFullYear())
    .filter((year) => Number.isInteger(year));

  years.push(new Date().getFullYear());
  return [...new Set(years)].sort((a, b) => b - a);
}

function syncFinanceYears() {
  const select = $("#financeYear");
  const current = select.value || String(new Date().getFullYear());
  const years = financeYears();

  select.innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join("");
  select.value = years.includes(Number(current)) ? current : String(years[0]);
}

function inDateRange(date, range) {
  if (!date) return false;
  if (range.start && date < range.start) return false;
  if (range.end && date > range.end) return false;
  return true;
}

function financeTotals(items) {
  const income = items
    .filter((item) => item.type === "income")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const expense = items
    .filter((item) => item.type === "expense")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  return {
    income,
    expense,
    balance: income - expense
  };
}

function renderFinance() {
  syncFinanceYears();

  const period = $("#financePeriod").value;
  const type = $("#financeType").value;
  const range = financeRangeFor(period, $("#financeYear").value);
  const baseItems = financialItems().filter((item) => {
    const date = parseDate(item.date);
    return period === "all" || inDateRange(date, range);
  });
  const items = baseItems.filter((item) => type === "all" || item.type === type)
    .sort((a, b) => parseDate(b.date) - parseDate(a.date));

  const totals = financeTotals(baseItems);

  $("#financeIncome").textContent = formatMoney.format(totals.income);
  $("#financeExpense").textContent = formatMoney.format(totals.expense);
  $("#financeBalance").textContent = formatMoney.format(totals.balance);
  $("#financeYear").hidden = period !== "year";

  $("#financeList").innerHTML = items.map((item) => {
    const amount = Number(item.amount || 0);
    const signedAmount = item.type === "income" ? amount : -amount;
    const label = item.type === "income" ? "Ingreso" : "Gasto";

    return `
      <article class="item finance-item ${item.type}">
        <div>
          <div class="item-title">${escapeHtml(item.description)}</div>
          <div class="item-meta">${label} · ${escapeHtml(item.category)} · ${item.date ? formatDate.format(parseDate(item.date)) : "Sin fecha"}</div>
          ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
        </div>
        <div class="money ${item.type}">${formatMoney.format(signedAmount)}</div>
        <div class="item-actions">
          <button type="button" data-action="delete-finance" data-id="${item.id}">Borrar</button>
        </div>
      </article>
    `;
  }).join("") || emptyState(`Sin movimientos para ${range.label}`);
}

function renderReminderRow(item, urgent = false) {
  return `
    <article class="mini-row ${urgent ? "urgent" : ""}">
      <span>${escapeHtml(item.kind)}</span>
      <strong>${escapeHtml(item.title)}</strong>
      <time>${formatDateTime.format(item.at)}</time>
    </article>
  `;
}

function renderTimelineItem(item) {
  return `
    <article class="timeline-item">
      <time>${formatDateTime.format(item.at)}</time>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.kind)}${item.detail ? ` · ${escapeHtml(item.detail)}` : ""}</span>
      </div>
    </article>
  `;
}

function renderScheduleItem(item) {
  const actions = {
    tasks: `<button type="button" data-action="toggle-task" data-id="${item.rawId}">Listo</button>`,
    attentions: `<button type="button" data-action="close-attention" data-id="${item.rawId}">Cerrar</button>`,
    events: `<button type="button" data-action="delete-event" data-id="${item.rawId}">Borrar</button>`
  };

  return `
    <article class="timeline-item agenda-item ${escapeHtml(item.collection)}">
      <time>${formatDateTime.format(item.at)}</time>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.kind)}${item.detail ? ` · ${escapeHtml(item.detail)}` : ""}</span>
        ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
      </div>
      ${actions[item.collection] || ""}
    </article>
  `;
}

function emptyState(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `asistente-control-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      state = mergeState(defaultState, imported);
      saveState();
      render();
      toast("Datos importados");
    } catch {
      toast("No se pudo importar el archivo");
    }
  };
  reader.readAsText(file);
}

function setDefaultDates() {
  const today = inputDateValue();
  $("#financeForm [name='date']").value = today;
}

function bindEvents() {
  $$("form[data-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      createItem(form.dataset.form, new FormData(form));
      form.reset();
      setDefaultDates();
    });
  });

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((button) => button.classList.remove("active"));
      $$(".view").forEach((view) => view.classList.remove("active"));
      tab.classList.add("active");
      $(`#${tab.dataset.view}`).classList.add("active");
    });
  });

  $("#enableAlarms").addEventListener("click", async () => {
    ensureAudio();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    state.settings.alarmsEnabled = !state.settings.alarmsEnabled;
    saveState();
    renderControls();
    const message = state.settings.alarmsEnabled ? "Alarmas activadas" : "Alarmas pausadas";
    toast(message);
    speak(message);
    checkAlarms();
  });

  $("#speakNow").addEventListener("click", speakPending);
  $("#speakSchedule").addEventListener("click", speakSchedule);
  $("#exportData").addEventListener("click", exportData);
  $("#importData").addEventListener("change", (event) => importData(event.target.files[0]));

  $("#alarmOptions").addEventListener("change", () => {
    state.settings.leadTimes = $$("input[name='leadTimes']:checked").map((input) => Number(input.value));
    saveState();
    renderControls();
    checkAlarms();
  });

  $("#taskFilter").addEventListener("change", renderTasks);
  $("#attentionSearch").addEventListener("input", renderAttentions);
  $("#scheduleRange").addEventListener("change", renderSchedule);
  $("#financePeriod").addEventListener("change", renderFinance);
  $("#financeType").addEventListener("change", renderFinance);
  $("#financeYear").addEventListener("change", renderFinance);

  document.body.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;

    if (action === "toggle-task") {
      const task = state.tasks.find((item) => item.id === id);
      updateItem("tasks", id, { done: !task.done });
    }
    if (action === "delete-task") deleteItem("tasks", id);
    if (action === "close-attention") updateItem("attentions", id, { status: "cerrada" });
    if (action === "delete-attention") deleteItem("attentions", id);
    if (action === "delete-event") deleteItem("events", id);
    if (action === "delete-expense") deleteItem("expenses", id);
    if (action === "delete-finance") deleteItem("transactions", id);
  });
}

bindEvents();
bindPwa();
setDefaultDates();
render();
window.setInterval(() => {
  renderDashboard();
  checkAlarms();
}, 30000);

function bindPwa() {
  const installButton = $("#installApp");

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.hidden = true;
  });

  if ("serviceWorker" in navigator && window.location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {
      toast("Modo offline no disponible en este origen");
    });
  }
}
