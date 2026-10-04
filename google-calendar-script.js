const SECRET_PROPERTY = "ASISTENTE_SYNC_SECRET";
const EVENT_PREFIX = "ASISTENTE_EVENT_";

function generarClavePrivada() {
  const secret = `${Utilities.getUuid()}${Utilities.getUuid()}`.replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty(SECRET_PROPERTY, secret);
  console.log(`CLAVE PRIVADA: ${secret}`);
  return secret;
}

function doGet(request) {
  const result = { ok: true, service: "Asistente Calendar", version: 1 };
  const prefix = String(request?.parameter?.prefix || "");

  if (prefix && /^[A-Za-z_$][\w$]*$/.test(prefix)) {
    return ContentService
      .createTextOutput(`${prefix}(${JSON.stringify(result)})`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(request) {
  const expectedSecret = PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY);
  const receivedSecret = String(request?.parameter?.secret || "");
  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return jsonResponse({ ok: false, error: "Acceso no autorizado" });
  }

  let payload;
  try {
    payload = JSON.parse(request.parameter.payload || "{}");
  } catch (error) {
    return jsonResponse({ ok: false, error: "Datos inválidos" });
  }

  const action = String(request.parameter.action || "");
  const sourceId = String(payload.sourceId || "");
  if (!sourceId) return jsonResponse({ ok: false, error: "Falta el identificador" });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, error: "Servicio ocupado" });

  try {
    if (action === "upsert") return jsonResponse(upsertEvent(sourceId, payload));
    if (action === "delete") return jsonResponse(deleteEvent(sourceId));
    return jsonResponse({ ok: false, error: "Acción desconocida" });
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, error: String(error.message || error) });
  } finally {
    lock.releaseLock();
  }
}

function upsertEvent(sourceId, payload) {
  const start = new Date(payload.start);
  const end = new Date(payload.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    throw new Error("La fecha de la cita no es válida");
  }

  const calendar = CalendarApp.getDefaultCalendar();
  const properties = PropertiesService.getScriptProperties();
  const propertyKey = eventPropertyKey(sourceId);
  const storedId = properties.getProperty(propertyKey);
  let event = storedId ? calendar.getEventById(storedId) : null;

  if (event) {
    event
      .setTitle(String(payload.title || "Cita"))
      .setTime(start, end)
      .setDescription(String(payload.description || ""))
      .setLocation(String(payload.location || ""));
  } else {
    event = calendar.createEvent(String(payload.title || "Cita"), start, end, {
      description: String(payload.description || ""),
      location: String(payload.location || "")
    });
  }

  event.setTag("asistenteSourceId", sourceId);
  applyReminders(event, payload.reminders);
  properties.setProperty(propertyKey, event.getId());
  return { ok: true, action: storedId ? "updated" : "created", eventId: event.getId() };
}

function deleteEvent(sourceId) {
  const calendar = CalendarApp.getDefaultCalendar();
  const properties = PropertiesService.getScriptProperties();
  const propertyKey = eventPropertyKey(sourceId);
  const storedId = properties.getProperty(propertyKey);
  const event = storedId ? calendar.getEventById(storedId) : null;

  if (event) event.deleteEvent();
  properties.deleteProperty(propertyKey);
  return { ok: true, action: event ? "deleted" : "not-found" };
}

function applyReminders(event, reminders) {
  const validReminders = [...new Set((Array.isArray(reminders) ? reminders : []).map(Number))]
    .filter((minutes) => Number.isInteger(minutes) && minutes >= 5 && minutes <= 40320)
    .slice(0, 5);

  event.removeAllReminders();
  if (!validReminders.length) {
    event.resetRemindersToDefault();
    return;
  }
  validReminders.forEach((minutes) => event.addPopupReminder(minutes));
}

function eventPropertyKey(sourceId) {
  const safeId = sourceId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 180);
  return `${EVENT_PREFIX}${safeId}`;
}

function jsonResponse(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
