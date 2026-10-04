const STORAGE_KEY = "asistente-control-v1";
const GOOGLE_SYNC_STORAGE_KEY = "asistente-control-google-sync-v1";

const VIEW_COPY = {
  today: ["Mi día", "Lo importante, ordenado para hoy."],
  schedule: ["Agenda", "Citas, reuniones y programación en un solo lugar."],
  tasks: ["Pendientes", "Tareas abiertas, prioridades y vencimientos."],
  followups: ["Seguimientos", "Asuntos que necesitan continuidad hasta cerrarse."],
  finance: ["Finanzas", "Ingresos, gastos, deudas y compromisos."],
  alarms: ["Alarmas y conexiones", "Avisos y sincronización automática de tu agenda."]
};

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

const FINANCE_FREQUENCIES = {
  once: { label: "Una vez", months: 0 },
  monthly: { label: "Mensual fijo", months: 1 },
  semiannual: { label: "Semestral", months: 6 },
  annual: { label: "Anual", months: 12 }
};

const FINANCE_TYPE_LABELS = {
  income: "Ingreso",
  expense: "Gasto",
  debt: "Deuda"
};

const FINANCE_STATUS_LABELS = {
  paid: "Pagado",
  pending: "Pendiente"
};

let state = loadState();
let calendarSyncConfig = loadCalendarSyncConfig();
let calendarSyncPending = 0;
let audioContext = null;
let deferredInstallPrompt = null;
let pendingVoiceAction = null;

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

function loadCalendarSyncConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(GOOGLE_SYNC_STORAGE_KEY));
    return {
      endpoint: cleanText(stored?.endpoint),
      secret: cleanText(stored?.secret),
      enabled: Boolean(stored?.enabled && stored?.endpoint && stored?.secret)
    };
  } catch {
    return { endpoint: "", secret: "", enabled: false };
  }
}

function saveCalendarSyncConfig() {
  localStorage.setItem(GOOGLE_SYNC_STORAGE_KEY, JSON.stringify(calendarSyncConfig));
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
      frequency: "once",
      status: "paid",
      notes: expense.notes || ""
    }));
  }

  merged.transactions = (merged.transactions || []).map(normalizeFinanceItem);

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

function calendarSyncReady() {
  return Boolean(calendarSyncConfig.enabled && calendarSyncConfig.endpoint && calendarSyncConfig.secret);
}

function calendarSyncPayload(event) {
  const start = parseDate(event?.start);
  if (!event || !start) return null;
  const end = eventEndDate(event) || addMinutes(start, 60);
  return {
    sourceId: event.id,
    title: event.title,
    start: start.toISOString(),
    end: end.toISOString(),
    location: event.place || "",
    description: event.notes || "",
    reminders: activeLeadTimes()
  };
}

function updateCalendarSyncUi() {
  const connected = calendarSyncReady();
  const syncing = connected && calendarSyncPending > 0;
  const label = syncing ? "Sincronizando..." : connected ? "Calendar conectado" : "Conectar Calendar";
  const sidebarLabel = syncing ? "Sincronizando agenda" : connected ? "Calendar conectado" : "Calendar sin conectar";
  const message = connected
    ? "Las citas nuevas, editadas y eliminadas se sincronizan automáticamente con Google Calendar."
    : "Conecta tu calendario para sincronizar las citas automáticamente.";

  [$("#calendarConnectionDot"), $("#sidebarSyncDot")].filter(Boolean).forEach((dot) => {
    dot.classList.toggle("connected", connected && !syncing);
    dot.classList.toggle("syncing", syncing);
  });
  if ($("#calendarConnectionLabel")) $("#calendarConnectionLabel").textContent = label;
  if ($("#sidebarSyncLabel")) $("#sidebarSyncLabel").textContent = sidebarLabel;
  if ($("#calendarSyncMessage")) $("#calendarSyncMessage").textContent = message;
  if ($("#calendarSyncEndpoint")) $("#calendarSyncEndpoint").value = calendarSyncConfig.endpoint;
  if ($("#calendarSyncSecret")) $("#calendarSyncSecret").value = calendarSyncConfig.secret;
  if ($("#syncCalendarNow")) $("#syncCalendarNow").disabled = !connected || syncing;
  if ($("#disconnectCalendar")) $("#disconnectCalendar").hidden = !connected;
}

async function sendCalendarSync(action, event, quiet = false) {
  if (!calendarSyncReady()) return false;
  const eventPayload = action === "delete" ? { sourceId: event?.id } : calendarSyncPayload(event);
  if (!eventPayload?.sourceId) return false;

  calendarSyncPending += 1;
  updateCalendarSyncUi();
  const body = new URLSearchParams({
    secret: calendarSyncConfig.secret,
    action,
    payload: JSON.stringify(eventPayload)
  });

  try {
    await fetch(calendarSyncConfig.endpoint, {
      method: "POST",
      mode: "no-cors",
      body
    });
    if (!quiet) toast(action === "delete" ? "Cita retirada de Google Calendar" : "Cita enviada a Google Calendar");
    return true;
  } catch {
    if (!quiet) toast("No se pudo sincronizar con Google Calendar");
    return false;
  } finally {
    calendarSyncPending = Math.max(0, calendarSyncPending - 1);
    updateCalendarSyncUi();
  }
}

async function syncAllCalendarEvents() {
  if (!calendarSyncReady()) {
    toast("Primero conecta Google Calendar");
    return;
  }
  const events = state.events.filter((event) => event.start && !isEventFinished(event));
  if (!events.length) {
    toast("No hay citas próximas para sincronizar");
    return;
  }
  await Promise.all(events.map((event) => sendCalendarSync("upsert", event, true)));
  toast(`${events.length} ${events.length === 1 ? "cita sincronizada" : "citas sincronizadas"}`);
}

function checkCalendarService(endpoint) {
  return new Promise((resolve) => {
    const callbackName = `__calendarCheck${Date.now()}`;
    const script = document.createElement("script");
    let settled = false;
    const timer = window.setTimeout(() => finish(false), 9000);
    const finish = (success) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.remove();
      delete window[callbackName];
      resolve(success);
    };
    window[callbackName] = (response) => finish(Boolean(response?.ok));
    script.onerror = () => finish(false);
    const url = new URL(endpoint);
    url.searchParams.set("prefix", callbackName);
    url.searchParams.set("check", "1");
    script.src = url.toString();
    document.head.appendChild(script);
  });
}

function activateView(viewName) {
  const target = $(`.tab[data-view='${viewName}']`);
  const view = $(`#${viewName}`);
  if (!target || !view) return;
  $$(".tab").forEach((button) => button.classList.toggle("active", button === target));
  $$(".view").forEach((section) => section.classList.toggle("active", section === view));
  const [title, subtitle] = VIEW_COPY[viewName] || VIEW_COPY.today;
  $("#viewTitle").textContent = title;
  $("#viewSubtitle").textContent = subtitle;
  if (window.innerWidth < 861) window.scrollTo({ top: 0, behavior: "smooth" });
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

function parseReminderDate(value, fallbackHour = 9) {
  const date = parseDate(value);
  if (!date) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setHours(fallbackHour, 0, 0, 0);
  }
  return date;
}

function inputDateValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function inputDateTimeValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
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

function addMinutes(date, amount) {
  return new Date(date.getTime() + amount * 60 * 1000);
}

function addDays(date, amount) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function addMonths(date, amount) {
  const copy = new Date(date);
  const day = copy.getDate();
  copy.setDate(1);
  copy.setMonth(copy.getMonth() + amount);
  copy.setDate(Math.min(day, new Date(copy.getFullYear(), copy.getMonth() + 1, 0).getDate()));
  return copy;
}

function eventEndDate(event) {
  const start = parseDate(event.start);
  const end = parseDate(event.end);
  if (end && start && end > start) return end;
  return start ? addMinutes(start, 60) : null;
}

function isEventFinished(event, now = new Date()) {
  const end = eventEndDate(event);
  return end ? end <= now : false;
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

function normalizeFinanceType(type) {
  return ["income", "expense", "debt"].includes(type) ? type : "expense";
}

function normalizeFinanceFrequency(frequency) {
  return Object.prototype.hasOwnProperty.call(FINANCE_FREQUENCIES, frequency) ? frequency : "once";
}

function normalizeFinanceStatus(status, type = "expense") {
  if (["paid", "pending"].includes(status)) return status;
  return type === "debt" ? "pending" : "paid";
}

function normalizeFinanceItem(item) {
  const type = normalizeFinanceType(item.type);
  return {
    ...item,
    type,
    due: item.due || "",
    frequency: normalizeFinanceFrequency(item.frequency),
    status: normalizeFinanceStatus(item.status, type),
    notes: item.notes || ""
  };
}

function createItem(type, formData) {
  const base = {
    id: uid(),
    createdAt: new Date().toISOString()
  };
  let createdEvent = null;

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
    toast("Seguimiento guardado");
  }

  if (type === "event") {
    const editingId = cleanText(formData.get("id"));
    const eventData = {
      title: cleanText(formData.get("title")),
      start: formData.get("start"),
      end: formData.get("end"),
      place: cleanText(formData.get("place")),
      notes: cleanText(formData.get("notes"))
    };
    if (editingId) {
      state.events = state.events.map((item) => item.id === editingId ? { ...item, ...eventData } : item);
      createdEvent = state.events.find((item) => item.id === editingId) || null;
      toast("Evento actualizado");
    } else {
      createdEvent = { ...base, ...eventData };
      state.events.unshift(createdEvent);
      toast("Evento guardado");
    }
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
    const itemType = normalizeFinanceType(formData.get("type"));
    state.transactions.unshift({
      ...base,
      type: itemType,
      description: cleanText(formData.get("description")),
      amount: Number(formData.get("amount") || 0),
      category: formData.get("category"),
      date: formData.get("date"),
      due: formData.get("due"),
      frequency: normalizeFinanceFrequency(formData.get("frequency")),
      status: normalizeFinanceStatus(formData.get("status"), itemType),
      notes: cleanText(formData.get("notes"))
    });
    toast("Movimiento guardado");
  }

  saveState();
  render();
  if (createdEvent) sendCalendarSync("upsert", createdEvent);
}

function addTask({ title, due = "", priority = "media", notes = "" }) {
  state.tasks.unshift({
    id: uid(),
    createdAt: new Date().toISOString(),
    title: cleanText(title),
    due,
    priority,
    notes: cleanText(notes),
    done: false
  });
}

function addFollowUp({ person, subject, followUp = "", notes = "" }) {
  state.attentions.unshift({
    id: uid(),
    createdAt: new Date().toISOString(),
    person: cleanText(person || "Seguimiento"),
    subject: cleanText(subject),
    status: "abierta",
    followUp,
    notes: cleanText(notes)
  });
}

function addEvent({ title, start, end = "", place = "", notes = "" }) {
  const event = {
    id: uid(),
    createdAt: new Date().toISOString(),
    title: cleanText(title),
    start,
    end,
    place: cleanText(place),
    notes: cleanText(notes)
  };
  state.events.unshift(event);
  sendCalendarSync("upsert", event);
  return event;
}

function setEventEditMode(event = null) {
  const form = $("#eventForm");
  form.elements.id.value = event?.id || "";
  $("#eventFormTitle").textContent = event ? "Editar cita o evento" : "Nueva cita o evento";
  $("#saveEventButton").textContent = event ? "Guardar cambios" : "Guardar evento";
  $("#cancelEventEdit").hidden = !event;
}

function editEvent(id) {
  const event = state.events.find((item) => item.id === id);
  if (!event) return;
  activateView("schedule");
  const form = $("#eventForm");
  setEventEditMode(event);
  form.elements.title.value = event.title || "";
  form.elements.start.value = event.start || "";
  form.elements.end.value = event.end || "";
  form.elements.place.value = event.place || "";
  form.elements.notes.value = event.notes || "";
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.title.focus({ preventScroll: true });
}

function cancelEventEdit() {
  const form = $("#eventForm");
  form.reset();
  setEventEditMode();
  setDefaultDates();
}

function updateItem(collection, id, patch) {
  state[collection] = state[collection].map((item) => item.id === id ? { ...item, ...patch } : item);
  saveState();
  render();
  if (collection === "events") {
    const event = state.events.find((item) => item.id === id);
    if (event) sendCalendarSync("upsert", event);
  }
}

function deleteItem(collection, id) {
  const removedItem = state[collection].find((item) => item.id === id);
  state[collection] = state[collection].filter((item) => item.id !== id);
  saveState();
  render();
  if (collection === "events" && $("#eventForm")?.elements.id.value === id) cancelEventEdit();
  if (collection === "events" && removedItem) sendCalendarSync("delete", removedItem);
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
      kind: "Seguimiento",
      title: `${attention.person}: ${attention.subject}`,
      detail: attention.status,
      at: parseDate(attention.followUp),
      notes: attention.notes
    }));

  const events = state.events
    .filter((event) => event.start && !isEventFinished(event))
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

  const finances = financeReminderItems().map((item) => {
    const at = parseReminderDate(financeOccurrenceDate(item));
    return {
      id: `finance-${item.id}-${inputDateValue(at)}`,
      rawId: item.id,
      collection: "transactions",
      kind: item.type === "debt" ? "Deuda" : "Finanzas",
      title: item.description,
      detail: `${financeTypeLabel(item)} · ${financeFrequencyLabel(item.frequency)}`,
      at,
      notes: item.notes
    };
  });

  return [...tasks, ...attentions, ...events, ...finances]
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
  const openAttentions = openFollowUps();
  const nextItems = reminderItems().filter((item) => item.at >= new Date()).slice(0, 4);
  const monthRange = financeRangeFor("month");
  const monthItems = expandFinancialItems(monthRange).filter((item) => {
    const date = parseDate(financeOccurrenceDate(item));
    return date && isThisMonth(date);
  });
  const { balance } = financeTotals(monthItems);

  if (!openTasks.length && !openAttentions.length && !nextItems.length) {
    speak("No tienes pendientes abiertos por ahora.");
    toast("No hay pendientes abiertos");
    return;
  }

  const parts = [
    `Tienes ${openTasks.length} pendientes abiertos y ${openAttentions.length} seguimientos activos.`
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

function openFollowUps() {
  return state.attentions.filter((attention) => attention.status !== "cerrada");
}

function tasksDueToday() {
  const now = new Date();
  return state.tasks.filter((task) => {
    const due = parseDate(task.due);
    return !task.done && due && isSameDay(due, now);
  });
}

function overdueTasks() {
  const now = new Date();
  return state.tasks.filter((task) => {
    const due = parseDate(task.due);
    return !task.done && due && due < now && !isSameDay(due, now);
  });
}

function eventsToday() {
  const now = new Date();
  return state.events
    .map((event) => ({ ...event, startDate: parseDate(event.start), endDate: parseDate(event.end) }))
    .filter((event) => event.startDate && isSameDay(event.startDate, now) && !isEventFinished(event, now))
    .sort((a, b) => a.startDate - b.startDate);
}

function freeSlotsToday() {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0);
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0);
  let cursor = now > dayStart ? addMinutes(now, 15 - (now.getMinutes() % 15 || 15)) : dayStart;

  if (cursor >= dayEnd) return [];

  const busy = eventsToday()
    .map((event) => ({
      start: event.startDate,
      end: event.endDate && event.endDate > event.startDate ? event.endDate : addMinutes(event.startDate, 60)
    }))
    .filter((slot) => slot.end > cursor && slot.start < dayEnd)
    .sort((a, b) => a.start - b.start);

  const slots = [];
  busy.forEach((slot) => {
    const start = slot.start < cursor ? cursor : slot.start;
    if (start - cursor >= 30 * 60 * 1000) {
      slots.push({ start: cursor, end: start });
    }
    if (slot.end > cursor) cursor = slot.end;
  });

  if (dayEnd - cursor >= 30 * 60 * 1000) slots.push({ start: cursor, end: dayEnd });
  return slots;
}

function buildDayPlan() {
  const agenda = agendaItemsForRange("today");
  const todayTasks = tasksDueToday();
  const lateTasks = overdueTasks();
  const followUps = openFollowUps();
  const withoutDate = followUps.filter((attention) => !attention.followUp);
  const financeDue = financeReminderItems().filter((item) => {
    const due = parseReminderDate(financeOccurrenceDate(item));
    return due && isSameDay(due, new Date());
  });
  const slots = freeSlotsToday();
  const recommendations = [];

  if (lateTasks.length) {
    recommendations.push(`Resolver primero ${lateTasks.length} pendiente${lateTasks.length === 1 ? "" : "s"} vencido${lateTasks.length === 1 ? "" : "s"}.`);
  }
  if (todayTasks.length) {
    recommendations.push(`Separar tiempo para ${todayTasks.length} pendiente${todayTasks.length === 1 ? "" : "s"} de hoy.`);
  }
  if (withoutDate.length) {
    recommendations.push(`Programar próxima fecha para ${withoutDate.length} seguimiento${withoutDate.length === 1 ? "" : "s"} abierto${withoutDate.length === 1 ? "" : "s"} sin revisión.`);
  }
  if (financeDue.length) {
    recommendations.push(`Revisar ${financeDue.length} compromiso${financeDue.length === 1 ? "" : "s"} financiero${financeDue.length === 1 ? "" : "s"} que vence${financeDue.length === 1 ? "" : "n"} hoy.`);
  }
  if (slots.length && (lateTasks.length || todayTasks.length || withoutDate.length || financeDue.length)) {
    const first = slots[0];
    recommendations.push(`Usar el espacio de ${formatTime.format(first.start)} a ${formatTime.format(first.end)} para avanzar lo más urgente.`);
  }
  if (!recommendations.length) {
    recommendations.push("La agenda está manejable. Mantén el día para cerrar pendientes pequeños y actualizar seguimientos.");
  }

  return {
    agenda,
    todayTasks,
    lateTasks,
    followUps,
    withoutDate,
    financeDue,
    slots,
    recommendations
  };
}

function renderDayPlan(speakResult = false) {
  const plan = buildDayPlan();
  const slotText = plan.slots.length
    ? plan.slots.slice(0, 3).map((slot) => `${formatTime.format(slot.start)} - ${formatTime.format(slot.end)}`).join(", ")
    : "Sin espacios libres claros en horario laboral";
  const dueToday = plan.agenda
    .filter((item) => isSameDay(item.at, new Date()))
    .slice(0, 6);

  $("#dayPlan").innerHTML = `
    <div class="plan-grid">
      <article><strong>${plan.agenda.length}</strong><span>citas, vencimientos o revisiones hoy</span></article>
      <article><strong>${plan.lateTasks.length}</strong><span>pendientes vencidos</span></article>
      <article><strong>${plan.withoutDate.length}</strong><span>seguimientos sin próxima fecha</span></article>
      <article><strong>${plan.financeDue.length}</strong><span>compromisos financieros hoy</span></article>
    </div>
    <div class="plan-block">
      <span>Vence hoy</span>
      ${dueToday.length ? `<ul>${dueToday.map((item) => `<li>${escapeHtml(item.kind)}: ${escapeHtml(item.title)} · ${formatTime.format(item.at)}</li>`).join("")}</ul>` : "<p>Nada con vencimiento para hoy.</p>"}
    </div>
    <div class="plan-block">
      <span>Disponibilidad</span>
      <p>${escapeHtml(slotText)}</p>
    </div>
    <div class="plan-block">
      <span>Recomendación</span>
      <ul>${plan.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </div>
  `;

  if (speakResult) {
    speak(`Mi día. Tienes ${plan.agenda.length} registros en agenda, ${plan.lateTasks.length} pendientes vencidos y ${plan.withoutDate.length} seguimientos sin próxima fecha. ${plan.recommendations.join(" ")}`);
  }
}

function render() {
  renderHeader();
  renderMetrics();
  renderDashboard();
  renderDayPlan();
  renderTasks();
  renderAttentions();
  renderSchedule();
  renderFinance();
  renderControls();
}

function renderHeader() {
  const value = new Intl.DateTimeFormat("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(new Date());
  $("#currentDateLabel").textContent = value.charAt(0).toUpperCase() + value.slice(1);
  updateCalendarSyncUi();
}

function renderControls() {
  const activeLeads = activeLeadTimes();
  $$("input[name='leadTimes']").forEach((input) => {
    input.checked = activeLeads.includes(Number(input.value));
  });
  $("#alarmProfile").textContent = `${activeLeads.length} alarmas`;
  $("#enableAlarms").textContent = state.settings.alarmsEnabled ? "Alarmas activas" : "Activar alarmas";
  $("#enableAlarms").classList.toggle("active", state.settings.alarmsEnabled);
  renderAlarmPreview();
  updateCalendarSyncUi();
}

function renderAlarmPreview() {
  const now = new Date();
  const items = reminderItems().filter((item) => item.at >= now).slice(0, 10);
  const target = $("#alarmPreview");
  if (!target) return;
  target.innerHTML = items.map(renderTimelineItem).join("") || emptyState("Sin avisos programados");
}

function renderMetrics() {
  const now = new Date();
  const openTasks = state.tasks.filter((task) => !task.done);
  const dueToday = reminderItems().filter((item) => isSameDay(item.at, now));
  const openAttentions = openFollowUps();
  const monthRange = financeRangeFor("month");
  const monthItems = expandFinancialItems(monthRange).filter((item) => {
    const date = parseDate(financeOccurrenceDate(item));
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
  const overdue = reminders.filter((item) => item.at < now).sort((a, b) => b.at - a.at).slice(0, 3);
  const today = reminders.filter((item) => item.at >= now && isSameDay(item.at, now)).slice(0, 5);
  const rows = [...overdue, ...today];

  $("#nextReminder").innerHTML = next
    ? `<span>Próximo</span><strong>${escapeHtml(next.title)}</strong><small>${next.kind} · ${formatDateTime.format(next.at)}</small>`
    : `<span>Próximo</span><strong>Sin recordatorios programados</strong><small>Agenda despejada</small>`;

  $("#dueList").innerHTML = rows.length
    ? rows.map((item) => renderReminderRow(item, item.at < now)).join("")
    : emptyState("Nada vence hoy");

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
  `).join("") || emptyState("Sin seguimientos registrados");
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
  return [...(state.transactions || [])].map(normalizeFinanceItem);
}

function financeYears(items = financialItems()) {
  const years = items
    .flatMap((item) => [item.date, item.due])
    .map((value) => parseDate(value)?.getFullYear())
    .filter((year) => Number.isInteger(year));

  const currentYear = new Date().getFullYear();
  items.forEach((item) => {
    const anchorYear = financeItemAnchor(item)?.getFullYear();
    if (!anchorYear || item.frequency === "once") return;
    for (let year = anchorYear; year <= currentYear + 1; year += 1) years.push(year);
  });
  years.push(currentYear, currentYear + 1);
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

function financeTypeLabel(item) {
  return FINANCE_TYPE_LABELS[item.type] || "Movimiento";
}

function financeFrequencyLabel(frequency) {
  return FINANCE_FREQUENCIES[normalizeFinanceFrequency(frequency)].label;
}

function financeStatusLabel(status) {
  return FINANCE_STATUS_LABELS[status] || "Pendiente";
}

function financeOccurrenceDate(item) {
  return item.occurrenceDate || item.due || item.date;
}

function financeItemAnchor(item) {
  return parseDate(item.due || item.date);
}

function expandFinancialItems(range, items = financialItems()) {
  return items.flatMap((item) => {
    const anchor = financeItemAnchor(item);
    if (!anchor) return [];

    const frequency = normalizeFinanceFrequency(item.frequency);
    const months = FINANCE_FREQUENCIES[frequency].months;

    if (!months || !range.start || !range.end) {
      return [{
        ...item,
        frequency,
        occurrenceDate: inputDateValue(anchor)
      }];
    }

    let occurrence = new Date(anchor);
    let guard = 0;
    while (occurrence < range.start && guard < 240) {
      occurrence = addMonths(occurrence, months);
      guard += 1;
    }

    const occurrences = [];
    while (occurrence <= range.end && guard < 300) {
      occurrences.push({
        ...item,
        frequency,
        occurrenceDate: inputDateValue(occurrence)
      });
      occurrence = addMonths(occurrence, months);
      guard += 1;
    }
    return occurrences;
  });
}

function financeReminderItems() {
  const now = new Date();
  const range = {
    start: startOfDay(addDays(now, -365)),
    end: endOfDay(addDays(now, 365))
  };

  return expandFinancialItems(range)
    .filter((item) => item.status === "pending")
    .filter((item) => parseReminderDate(financeOccurrenceDate(item)))
    .sort((a, b) => parseReminderDate(financeOccurrenceDate(a)) - parseReminderDate(financeOccurrenceDate(b)));
}

function financeTotals(items) {
  const income = items
    .filter((item) => item.type === "income")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const expense = items
    .filter((item) => item.type === "expense")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const debt = items
    .filter((item) => item.type === "debt" && item.status !== "paid")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  return {
    income,
    expense,
    debt,
    balance: income - expense
  };
}

function renderFinance() {
  syncFinanceYears();

  const period = $("#financePeriod").value;
  const type = $("#financeType").value;
  const range = financeRangeFor(period, $("#financeYear").value);
  const expandedItems = expandFinancialItems(range);
  const baseItems = expandedItems.filter((item) => {
    const date = parseDate(financeOccurrenceDate(item));
    return period === "all" || inDateRange(date, range);
  });
  const items = baseItems.filter((item) => type === "all" || item.type === type)
    .sort((a, b) => parseDate(financeOccurrenceDate(b)) - parseDate(financeOccurrenceDate(a)));

  const totals = financeTotals(baseItems);

  $("#financeIncome").textContent = formatMoney.format(totals.income);
  $("#financeExpense").textContent = formatMoney.format(totals.expense);
  $("#financeBalance").textContent = formatMoney.format(totals.balance);
  $("#financeDebt").textContent = formatMoney.format(totals.debt);
  $("#financeYear").hidden = period !== "year";

  $("#financeList").innerHTML = items.map((item) => {
    const amount = Number(item.amount || 0);
    const signedAmount = item.type === "income" ? amount : -amount;
    const label = financeTypeLabel(item);
    const calendarDate = financeOccurrenceDate(item);
    const occurrenceDate = parseDate(calendarDate);
    const frequency = financeFrequencyLabel(item.frequency);
    const status = financeStatusLabel(item.status);
    const calendarActions = occurrenceDate ? `
      <button type="button" data-action="google-calendar" data-collection="transactions" data-id="${item.id}" data-date="${escapeHtml(calendarDate)}">Google</button>
      <button type="button" data-action="ics-calendar" data-collection="transactions" data-id="${item.id}" data-date="${escapeHtml(calendarDate)}">.ics</button>
    ` : "";

    return `
      <article class="item finance-item ${item.type}">
        <div>
          <div class="item-title">${escapeHtml(item.description)}</div>
          <div class="item-meta">${label} · ${escapeHtml(item.category)} · ${occurrenceDate ? formatDate.format(occurrenceDate) : "Sin fecha"} · ${escapeHtml(frequency)} · ${escapeHtml(status)}</div>
          ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
        </div>
        <div class="money ${item.type}">${formatMoney.format(signedAmount)}</div>
        <div class="item-actions">
          ${calendarActions}
          ${item.status === "pending" ? `<button type="button" data-action="mark-finance-paid" data-id="${item.id}">Pagado</button>` : ""}
          <button type="button" data-action="delete-finance" data-id="${item.id}">Borrar</button>
        </div>
      </article>
    `;
  }).join("") || emptyState(`Sin movimientos para ${range.label}`);
}

function renderReminderRow(item, urgent = false) {
  const label = urgent ? (item.collection === "events" ? "En curso" : "Vencido") : (isSameDay(item.at, new Date()) ? "Vence hoy" : item.kind);
  return `
    <article class="mini-row ${urgent ? "urgent" : ""}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(item.title)}</strong>
      <time>${escapeHtml(item.kind)} · ${formatTime.format(item.at)}</time>
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
  const calendarDate = inputDateValue(item.at);
  const calendarActions = `
    <button type="button" data-action="google-calendar" data-collection="${escapeHtml(item.collection)}" data-id="${escapeHtml(item.rawId)}" data-date="${escapeHtml(calendarDate)}">Google</button>
    <button type="button" data-action="ics-calendar" data-collection="${escapeHtml(item.collection)}" data-id="${escapeHtml(item.rawId)}" data-date="${escapeHtml(calendarDate)}">.ics</button>
  `;
  const actions = {
    tasks: `<button type="button" data-action="toggle-task" data-id="${item.rawId}">Listo</button>`,
    attentions: `<button type="button" data-action="close-attention" data-id="${item.rawId}">Cerrar</button>`,
    events: `<button type="button" data-action="edit-event" data-id="${item.rawId}">Editar</button><button type="button" data-action="delete-event" data-id="${item.rawId}">Borrar</button>`,
    transactions: `<button type="button" data-action="delete-finance" data-id="${item.rawId}">Borrar</button>`
  };

  return `
    <article class="timeline-item agenda-item ${escapeHtml(item.collection)}">
      <time>${formatDateTime.format(item.at)}</time>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.kind)}${item.detail ? ` · ${escapeHtml(item.detail)}` : ""}</span>
        ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
      </div>
      <div class="item-actions timeline-actions">
        ${calendarActions}
        ${actions[item.collection] || ""}
      </div>
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

function calendarRecord(collection, id, occurrenceDate = "") {
  if (collection === "tasks") {
    const task = state.tasks.find((item) => item.id === id);
    const start = parseDate(task?.due);
    if (!task || !start) return null;
    return {
      id: `task-${task.id}`,
      title: `Pendiente: ${task.title}`,
      start,
      end: addMinutes(start, 30),
      details: [task.notes, `Prioridad: ${task.priority}`].filter(Boolean).join("\n")
    };
  }

  if (collection === "attentions") {
    const attention = state.attentions.find((item) => item.id === id);
    const start = parseDate(attention?.followUp);
    if (!attention || !start) return null;
    return {
      id: `seguimiento-${attention.id}`,
      title: `Seguimiento: ${attention.person} - ${attention.subject}`,
      start,
      end: addMinutes(start, 30),
      details: [attention.notes, `Estado: ${attention.status}`].filter(Boolean).join("\n")
    };
  }

  if (collection === "events") {
    const event = state.events.find((item) => item.id === id);
    const start = parseDate(event?.start);
    if (!event || !start) return null;
    return {
      id: `evento-${event.id}`,
      title: event.title,
      start,
      end: eventEndDate(event) || addMinutes(start, 60),
      location: event.place,
      details: event.notes
    };
  }

  if (collection === "transactions") {
    const item = financialItems().find((entry) => entry.id === id);
    const start = parseReminderDate(occurrenceDate || financeOccurrenceDate(item));
    if (!item || !start) return null;
    const amount = formatMoney.format(Number(item.amount || 0));
    const titlePrefix = item.type === "income" ? "Ingreso" : item.type === "debt" ? "Pago deuda" : "Pago";
    return {
      id: `finanzas-${item.id}-${inputDateValue(start)}`,
      title: `${titlePrefix}: ${item.description}`,
      start,
      end: addMinutes(start, 30),
      details: [
        `${financeTypeLabel(item)} por ${amount}`,
        `Categoría: ${item.category}`,
        `Frecuencia: ${financeFrequencyLabel(item.frequency)}`,
        `Estado: ${financeStatusLabel(item.status)}`,
        item.notes
      ].filter(Boolean).join("\n")
    };
  }

  return null;
}

function calendarRecordFromReminder(item) {
  const occurrenceDate = item.collection === "transactions" ? inputDateValue(item.at) : "";
  return calendarRecord(item.collection, item.rawId, occurrenceDate);
}

function calendarReminderText() {
  const leads = activeLeadTimes();
  if (!leads.length) return "Sin recordatorios configurados en la app.";
  return `Recordatorios sugeridos: ${leads.map(leadLabel).join(", ")}.`;
}

function toCalendarDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00Z`;
}

function googleCalendarUrl(record) {
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", record.title);
  url.searchParams.set("dates", `${toCalendarDateTime(record.start)}/${toCalendarDateTime(record.end)}`);
  url.searchParams.set("details", [record.details, calendarReminderText()].filter(Boolean).join("\n\n"));
  if (record.location) url.searchParams.set("location", record.location);
  return url.toString();
}

function icsEscape(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsTrigger(minutes) {
  if (minutes === 0) return "PT0M";
  if (minutes % 1440 === 0) return `-P${minutes / 1440}D`;
  if (minutes % 60 === 0) return `-PT${minutes / 60}H`;
  return `-PT${minutes}M`;
}

function foldIcsLine(line) {
  if (line.length <= 74) return line;
  const parts = [];
  let rest = line;
  while (rest.length > 74) {
    parts.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  parts.push(rest);
  return parts.join("\r\n");
}

function buildIcs(records) {
  const now = toCalendarDateTime(new Date());
  const alarms = activeLeadTimes();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Asistente de Control//Calendario//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];

  records.forEach((record) => {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(record.id)}@asistente-control`,
      `DTSTAMP:${now}`,
      `DTSTART:${toCalendarDateTime(record.start)}`,
      `DTEND:${toCalendarDateTime(record.end)}`,
      `SUMMARY:${icsEscape(record.title)}`
    );
    if (record.location) lines.push(`LOCATION:${icsEscape(record.location)}`);
    const description = [record.details, calendarReminderText()].filter(Boolean).join("\n\n");
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    alarms.forEach((minutes) => {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${icsEscape(record.title)}`,
        `TRIGGER:${icsTrigger(minutes)}`,
        "END:VALARM"
      );
    });
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function safeFileName(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "calendario";
}

function downloadCalendarRecords(records, filename) {
  if (!records.length) {
    toast("No hay registros con fecha para calendario");
    return;
  }
  const blob = new Blob([buildIcs(records)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  toast("Calendario descargado");
}

function openGoogleCalendar(collection, id, occurrenceDate = "") {
  const record = calendarRecord(collection, id, occurrenceDate);
  if (!record) {
    toast("Ese registro no tiene fecha para calendario");
    return;
  }
  window.open(googleCalendarUrl(record), "_blank", "noopener");
}

function downloadCalendarItem(collection, id, occurrenceDate = "") {
  const record = calendarRecord(collection, id, occurrenceDate);
  if (!record) {
    toast("Ese registro no tiene fecha para calendario");
    return;
  }
  downloadCalendarRecords([record], `${safeFileName(record.title)}.ics`);
}

function exportVisibleCalendar() {
  const selectedRange = $("#scheduleRange").value;
  const records = agendaItemsForRange(selectedRange).map(calendarRecordFromReminder).filter(Boolean);
  downloadCalendarRecords(records, `agenda-${selectedRange}-${inputDateValue()}.ics`);
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
  $("#financeForm [name='due']").value = "";
  syncFinanceFormDefaults();
}

function syncFinanceFormDefaults() {
  const form = $("#financeForm");
  const type = form.querySelector("[name='type']").value;
  const status = form.querySelector("[name='status']");
  if (type === "debt") status.value = "pending";
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function compactVoiceSubject(text, keywords) {
  let result = text;
  keywords.forEach((keyword) => {
    result = result.replace(keyword, "");
  });
  return cleanText(result.replace(/\b(hoy|manana|pasado manana|a las|para las|recordarme|crear|agendar|programar|agregar)\b/gi, " "));
}

function parseVoiceDate(text) {
  const normalized = normalizeText(text);
  const now = new Date();
  let date = startOfDay(now);

  if (normalized.includes("pasado manana")) date = startOfDay(addDays(now, 2));
  else if (normalized.includes("manana")) date = startOfDay(addDays(now, 1));

  const time = parseVoiceTime(normalized);
  if (time) {
    date.setHours(time.hour, time.minute, 0, 0);
  } else {
    date.setHours(9, 0, 0, 0);
  }

  return date;
}

function parseVoiceTime(text) {
  const wordNumbers = {
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
    once: 11,
    doce: 12
  };
  const numeric = text.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?\b/);
  const word = Object.keys(wordNumbers).find((key) => new RegExp(`\\b${key}\\b`).test(text));

  let hour = numeric ? Number(numeric[1]) : wordNumbers[word];
  let minute = numeric && numeric[2] ? Number(numeric[2]) : 0;
  const meridian = numeric?.[3] || "";

  if (!hour) return null;
  if ((meridian.includes("p") || text.includes("tarde") || text.includes("noche")) && hour < 12) hour += 12;
  if ((meridian.includes("a") || text.includes("manana")) && hour === 12) hour = 0;

  return { hour, minute };
}

function parseVoiceCommand(transcript) {
  const normalized = normalizeText(transcript);
  const date = parseVoiceDate(transcript);
  const due = inputDateTimeValue(date);

  if (normalized.includes("planear mi dia")) {
    return { intent: "plan", transcript };
  }

  if (normalized.includes("cerrar seguimiento")) {
    const query = compactVoiceSubject(transcript, [/cerrar seguimiento/gi]);
    const match = openFollowUps().find((item) => normalizeText(`${item.person} ${item.subject}`).includes(normalizeText(query)));
    return {
      intent: "close-followup",
      transcript,
      label: "Cerrar seguimiento",
      items: match ? [{ type: "closeFollowUp", id: match.id, title: `${match.person}: ${match.subject}` }] : []
    };
  }

  if (normalized.includes("seguimiento")) {
    const subject = compactVoiceSubject(transcript, [/crear seguimiento/gi, /seguimiento/gi, /caso/gi]);
    const items = [{
      type: "followup",
      title: "Seguimiento",
      data: {
        person: subject.split(",")[0] || "Seguimiento",
        subject,
        followUp: normalized.includes("manana") || normalized.includes("hoy") || normalized.includes("pasado manana") ? due : "",
        notes: transcript
      }
    }];

    if (normalized.includes("llamar") || normalized.includes("recordar")) {
      items.push({
        type: "task",
        title: subject,
        data: {
          title: subject,
          due,
          priority: "media",
          notes: `Relacionado con seguimiento: ${subject}`
        }
      });
    }

    return { intent: "create", transcript, label: "Crear seguimiento", items };
  }

  if (normalized.includes("cita") || normalized.includes("reunion") || normalized.includes("evento") || normalized.includes("agendar") || normalized.includes("programar")) {
    const title = compactVoiceSubject(transcript, [/agendar cita/gi, /programar reunion/gi, /agregar evento/gi, /programar/gi, /agendar/gi, /cita/gi, /reunion/gi, /evento/gi]);
    return {
      intent: "create",
      transcript,
      label: "Crear cita o evento",
      items: [{
        type: "event",
        title,
        data: {
          title: title || transcript,
          start: due,
          end: inputDateTimeValue(addMinutes(date, 60)),
          place: "",
          notes: transcript
        }
      }]
    };
  }

  if (normalized.includes("pendiente") || normalized.includes("recordarme")) {
    const title = compactVoiceSubject(transcript, [/crear pendiente/gi, /pendiente/gi, /recordarme/gi]);
    return {
      intent: "create",
      transcript,
      label: "Crear pendiente",
      items: [{
        type: "task",
        title,
        data: {
          title: title || transcript,
          due,
          priority: "media",
          notes: transcript
        }
      }]
    };
  }

  return {
    intent: "create",
    transcript,
    label: "Crear pendiente",
    items: [{
      type: "task",
      title: transcript,
      data: { title: transcript, due: "", priority: "media", notes: "Creado por voz" }
    }]
  };
}

function showVoiceConfirmation(action) {
  if (action.intent === "plan") {
    renderDayPlan(true);
    toast("Planeando tu día");
    return;
  }

  pendingVoiceAction = action;
  $("#voiceTranscript").textContent = `Escuché: "${action.transcript}"`;

  if (!action.items?.length) {
    $("#voicePreview").innerHTML = emptyState("No encontré un seguimiento abierto que coincida.");
    $("#confirmVoice").hidden = true;
  } else {
    $("#confirmVoice").hidden = false;
    $("#voicePreview").innerHTML = `
      <span>${escapeHtml(action.label)}</span>
      ${action.items.map((item) => `
        <article class="voice-item">
          <strong>${escapeHtml(item.title || item.data?.title || item.data?.subject || "Acción")}</strong>
          <small>${escapeHtml(voiceItemSummary(item))}</small>
        </article>
      `).join("")}
    `;
  }

  $("#voicePanel").hidden = false;
}

function voiceItemSummary(item) {
  if (item.type === "task") return `Pendiente · ${item.data.due ? formatDateTime.format(parseDate(item.data.due)) : "sin fecha"}`;
  if (item.type === "event") return `Agenda · ${formatDateTime.format(parseDate(item.data.start))}`;
  if (item.type === "followup") return `Seguimiento · ${item.data.followUp ? formatDateTime.format(parseDate(item.data.followUp)) : "sin próxima fecha"}`;
  if (item.type === "closeFollowUp") return "Cerrar seguimiento abierto";
  return "Acción";
}

function confirmVoiceAction() {
  if (!pendingVoiceAction?.items?.length) return;

  pendingVoiceAction.items.forEach((item) => {
    if (item.type === "task") addTask(item.data);
    if (item.type === "event") addEvent(item.data);
    if (item.type === "followup") addFollowUp(item.data);
    if (item.type === "closeFollowUp") updateItem("attentions", item.id, { status: "cerrada" });
  });

  pendingVoiceAction = null;
  $("#voicePanel").hidden = true;
  saveState();
  render();
  toast("Guardado desde voz");
}

function startVoiceCommand() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    toast("Tu navegador no reconoce voz aquí");
    speak("Tu navegador no reconoce voz aquí.");
    return;
  }

  const recognition = new Recognition();
  recognition.lang = "es-CO";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => toast("Escuchando...");
  recognition.onerror = () => toast("No pude escuchar bien");
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    showVoiceConfirmation(parseVoiceCommand(transcript));
  };
  recognition.start();
}

function bindEvents() {
  $$("form[data-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      createItem(form.dataset.form, new FormData(form));
      form.reset();
      if (form.dataset.form === "event") setEventEditMode();
      setDefaultDates();
    });
  });

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => activateView(tab.dataset.view));
  });

  $("#calendarConnection").addEventListener("click", () => {
    activateView("alarms");
    if (!calendarSyncReady()) $("#calendarSyncEndpoint").focus();
  });

  $("#calendarSyncForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const endpoint = cleanText(formData.get("endpoint"));
    const secret = cleanText(formData.get("secret"));
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      toast("Escribe una dirección válida del servicio de Google");
      return;
    }
    if (url.protocol !== "https:" || url.hostname !== "script.google.com" || !url.pathname.includes("/macros/s/")) {
      toast("La dirección debe pertenecer a Google Apps Script");
      return;
    }
    if (!secret) {
      toast("Escribe la clave privada del servicio");
      return;
    }

    toast("Comprobando el servicio de Google...");
    const available = await checkCalendarService(endpoint);
    if (!available) {
      toast("No pude comprobar el servicio. Revisa la dirección y el despliegue");
      return;
    }

    calendarSyncConfig = { endpoint, secret, enabled: true };
    saveCalendarSyncConfig();
    updateCalendarSyncUi();
    toast("Google Calendar conectado");
    syncAllCalendarEvents();
  });

  $("#syncCalendarNow").addEventListener("click", syncAllCalendarEvents);
  $("#cancelEventEdit").addEventListener("click", cancelEventEdit);
  $("#disconnectCalendar").addEventListener("click", () => {
    calendarSyncConfig = { endpoint: "", secret: "", enabled: false };
    localStorage.removeItem(GOOGLE_SYNC_STORAGE_KEY);
    updateCalendarSyncUi();
    toast("Google Calendar desconectado");
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

  $("#voiceCommand").addEventListener("click", startVoiceCommand);
  $("#planDay").addEventListener("click", () => renderDayPlan(true));
  $("#speakNow").addEventListener("click", () => renderDayPlan(true));
  $("#speakSchedule").addEventListener("click", speakSchedule);
  $("#exportScheduleCalendar").addEventListener("click", exportVisibleCalendar);
  $("#confirmVoice").addEventListener("click", confirmVoiceAction);
  $("#cancelVoice").addEventListener("click", () => {
    pendingVoiceAction = null;
    $("#voicePanel").hidden = true;
  });
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
  $("#financeForm [name='type']").addEventListener("change", syncFinanceFormDefaults);
  $("#financePeriod").addEventListener("change", renderFinance);
  $("#financeType").addEventListener("change", renderFinance);
  $("#financeYear").addEventListener("change", renderFinance);

  document.body.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;

    if (action === "google-calendar") openGoogleCalendar(button.dataset.collection, id, button.dataset.date);
    if (action === "ics-calendar") downloadCalendarItem(button.dataset.collection, id, button.dataset.date);

    if (action === "toggle-task") {
      const task = state.tasks.find((item) => item.id === id);
      updateItem("tasks", id, { done: !task.done });
    }
    if (action === "delete-task") deleteItem("tasks", id);
    if (action === "close-attention") updateItem("attentions", id, { status: "cerrada" });
    if (action === "delete-attention") deleteItem("attentions", id);
    if (action === "edit-event") editEvent(id);
    if (action === "delete-event") deleteItem("events", id);
    if (action === "delete-expense") deleteItem("expenses", id);
    if (action === "mark-finance-paid") updateItem("transactions", id, { status: "paid" });
    if (action === "delete-finance") deleteItem("transactions", id);
  });
}

bindEvents();
bindPwa();
setDefaultDates();
render();
window.setInterval(() => {
  renderMetrics();
  renderDashboard();
  renderDayPlan();
  renderSchedule();
  renderAlarmPreview();
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
