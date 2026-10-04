const OAUTH_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const DEVICE_PREFIX = "DEVICE_";
const STATE_PREFIX = "OAUTH_STATE_";
const STATE_TTL_MS = 10 * 60 * 1000;

function configurarServicio() {
  const CLIENT_ID = "PEGA_AQUI_EL_ID_DE_CLIENTE.apps.googleusercontent.com";
  const CLIENT_SECRET = "PEGA_AQUI_EL_SECRETO_DEL_CLIENTE";
  const APP_ORIGIN = "https://gedi71-eng.github.io";

  if (CLIENT_ID.includes("PEGA_AQUI") || CLIENT_SECRET.includes("PEGA_AQUI")) {
    throw new Error("Reemplaza CLIENT_ID y CLIENT_SECRET antes de ejecutar esta función.");
  }

  PropertiesService.getScriptProperties().setProperties({
    OAUTH_CLIENT_ID: CLIENT_ID,
    OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    APP_ORIGIN: APP_ORIGIN.replace(/\/$/, "")
  });

  console.log(`REDIRECCIÓN AUTORIZADA: ${ScriptApp.getService().getUrl()}`);
  console.log(`ID DE CLIENTE PARA LA APP: ${CLIENT_ID}`);
}

function doGet(request) {
  const params = request?.parameter || {};

  if (params.code && params.state) return handleOAuthCallback(params);
  if (params.error) return connectionPage(false, `Google no autorizó la conexión: ${params.error}`);

  if (params.action === "status") {
    const deviceId = validDeviceId(params.deviceId);
    const device = deviceId ? loadDevice(deviceId) : null;
    return browserResponse(params.prefix, {
      ok: true,
      connected: Boolean(device?.refreshToken),
      service: "Asistente Calendar",
      version: 2
    });
  }

  return browserResponse(params.prefix, {
    ok: true,
    connected: false,
    service: "Asistente Calendar",
    version: 2
  });
}

function doPost(request) {
  const action = String(request?.parameter?.action || "");
  const deviceId = validDeviceId(request?.parameter?.deviceId);
  let payload = {};

  try {
    payload = JSON.parse(request?.parameter?.payload || "{}");
  } catch {
    return jsonResponse({ ok: false, error: "Datos inválidos" });
  }

  if (action === "prepare") return prepareOAuth(deviceId, payload);
  if (!deviceId || !loadDevice(deviceId)?.refreshToken) {
    return jsonResponse({ ok: false, error: "Dispositivo no conectado" });
  }

  if (action === "disconnect") return jsonResponse(disconnectDevice(deviceId));

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonResponse({ ok: false, error: "Servicio ocupado" });

  try {
    if (action === "upsert") return jsonResponse(upsertEvent(deviceId, payload));
    if (action === "delete") return jsonResponse(deleteEvent(deviceId, payload));
    return jsonResponse({ ok: false, error: "Acción desconocida" });
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, error: String(error.message || error) });
  } finally {
    lock.releaseLock();
  }
}

function prepareOAuth(deviceId, payload) {
  const config = serviceConfig();
  const state = String(payload.state || "");
  const origin = String(payload.origin || "").replace(/\/$/, "");

  if (!deviceId || !/^[a-f0-9]{64}$/.test(state)) {
    return jsonResponse({ ok: false, error: "Solicitud de conexión inválida" });
  }
  if (origin !== config.appOrigin) {
    return jsonResponse({ ok: false, error: "Origen no autorizado" });
  }

  PropertiesService.getScriptProperties().setProperty(`${STATE_PREFIX}${state}`, JSON.stringify({
    deviceId,
    createdAt: Date.now()
  }));
  return jsonResponse({ ok: true });
}

function handleOAuthCallback(params) {
  const properties = PropertiesService.getScriptProperties();
  const stateKey = `${STATE_PREFIX}${String(params.state || "")}`;
  const storedState = parseJson(properties.getProperty(stateKey));
  properties.deleteProperty(stateKey);

  if (!storedState?.deviceId || Date.now() - Number(storedState.createdAt || 0) > STATE_TTL_MS) {
    return connectionPage(false, "La solicitud venció. Regresa a Asistente e inténtalo nuevamente.");
  }

  try {
    const config = serviceConfig();
    const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
      method: "post",
      payload: {
        code: params.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: ScriptApp.getService().getUrl(),
        grant_type: "authorization_code"
      },
      muteHttpExceptions: true
    });
    const tokens = parseJson(response.getContentText());
    if (response.getResponseCode() !== 200 || !tokens?.refresh_token) {
      throw new Error(tokens?.error_description || "Google no entregó un permiso renovable");
    }

    saveDevice(storedState.deviceId, {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token || "",
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
      connectedAt: new Date().toISOString()
    });
    return connectionPage(true, "Google Calendar quedó conectado correctamente.");
  } catch (error) {
    console.error(error);
    return connectionPage(false, String(error.message || error));
  }
}

function upsertEvent(deviceId, payload) {
  const sourceId = String(payload.sourceId || "");
  const start = new Date(payload.start);
  const end = new Date(payload.end);
  if (!sourceId || isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    throw new Error("La cita no tiene un identificador o una fecha válida");
  }

  const eventId = eventIdFor(deviceId, sourceId);
  const eventBody = {
    summary: String(payload.title || "Cita"),
    description: String(payload.description || ""),
    location: String(payload.location || ""),
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    reminders: calendarReminders(payload.reminders),
    extendedProperties: { private: { asistenteSourceId: sourceId } }
  };

  const baseUrl = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const existing = calendarRequest(deviceId, "get", `${baseUrl}/${encodeURIComponent(eventId)}`);

  if (existing.code === 200) {
    const updated = calendarRequest(deviceId, "patch", `${baseUrl}/${encodeURIComponent(eventId)}?sendUpdates=none`, eventBody);
    if (updated.code < 200 || updated.code >= 300) throw new Error(apiError(updated));
    return { ok: true, action: "updated", eventId };
  }

  if (existing.code !== 404) throw new Error(apiError(existing));
  const created = calendarRequest(deviceId, "post", `${baseUrl}?sendUpdates=none`, { ...eventBody, id: eventId });
  if (created.code < 200 || created.code >= 300) throw new Error(apiError(created));
  return { ok: true, action: "created", eventId };
}

function deleteEvent(deviceId, payload) {
  const sourceId = String(payload.sourceId || "");
  if (!sourceId) throw new Error("Falta el identificador de la cita");
  const eventId = eventIdFor(deviceId, sourceId);
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`;
  const response = calendarRequest(deviceId, "delete", url);
  if (![204, 404, 410].includes(response.code)) throw new Error(apiError(response));
  return { ok: true, action: response.code === 204 ? "deleted" : "not-found" };
}

function calendarRequest(deviceId, method, url, body) {
  const accessToken = getAccessToken(deviceId);
  const options = {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
    muteHttpExceptions: true
  };
  if (body !== undefined) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(body);
  }
  const response = UrlFetchApp.fetch(url, options);
  return {
    code: response.getResponseCode(),
    body: response.getContentText()
  };
}

function getAccessToken(deviceId) {
  const device = loadDevice(deviceId);
  if (!device?.refreshToken) throw new Error("El dispositivo no está conectado");
  if (device.accessToken && Number(device.expiresAt || 0) > Date.now() + 60000) return device.accessToken;

  const config = serviceConfig();
  const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: device.refreshToken,
      grant_type: "refresh_token"
    },
    muteHttpExceptions: true
  });
  const tokens = parseJson(response.getContentText());
  if (response.getResponseCode() !== 200 || !tokens?.access_token) {
    throw new Error(tokens?.error_description || "No fue posible renovar el acceso a Google");
  }

  device.accessToken = tokens.access_token;
  device.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
  saveDevice(deviceId, device);
  return device.accessToken;
}

function disconnectDevice(deviceId) {
  const device = loadDevice(deviceId);
  if (device?.refreshToken) {
    UrlFetchApp.fetch("https://oauth2.googleapis.com/revoke", {
      method: "post",
      payload: { token: device.refreshToken },
      muteHttpExceptions: true
    });
  }
  PropertiesService.getScriptProperties().deleteProperty(`${DEVICE_PREFIX}${deviceId}`);
  return { ok: true };
}

function calendarReminders(values) {
  const reminders = [...new Set((Array.isArray(values) ? values : []).map(Number))]
    .filter((minutes) => Number.isInteger(minutes) && minutes >= 0 && minutes <= 40320)
    .slice(0, 5)
    .map((minutes) => ({ method: "popup", minutes }));
  return reminders.length ? { useDefault: false, overrides: reminders } : { useDefault: true };
}

function eventIdFor(deviceId, sourceId) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `${deviceId}:${sourceId}`);
  return `a${bytes.map((value) => ((value + 256) % 256).toString(16).padStart(2, "0")).join("")}`;
}

function serviceConfig() {
  const properties = PropertiesService.getScriptProperties();
  const config = {
    clientId: properties.getProperty("OAUTH_CLIENT_ID"),
    clientSecret: properties.getProperty("OAUTH_CLIENT_SECRET"),
    appOrigin: properties.getProperty("APP_ORIGIN")
  };
  if (!config.clientId || !config.clientSecret || !config.appOrigin) {
    throw new Error("Ejecuta configurarServicio antes de publicar el servicio.");
  }
  return config;
}

function loadDevice(deviceId) {
  return parseJson(PropertiesService.getScriptProperties().getProperty(`${DEVICE_PREFIX}${deviceId}`));
}

function saveDevice(deviceId, value) {
  PropertiesService.getScriptProperties().setProperty(`${DEVICE_PREFIX}${deviceId}`, JSON.stringify(value));
}

function validDeviceId(value) {
  const deviceId = String(value || "");
  return /^[a-f0-9]{64}$/.test(deviceId) ? deviceId : "";
}

function apiError(response) {
  const value = parseJson(response.body);
  return value?.error?.message || `Google Calendar respondió ${response.code}`;
}

function parseJson(value) {
  try {
    return JSON.parse(value || "null");
  } catch {
    return null;
  }
}

function browserResponse(prefix, value) {
  const callback = String(prefix || "");
  if (callback && /^[A-Za-z_$][\w$]*$/.test(callback)) {
    return ContentService
      .createTextOutput(`${callback}(${JSON.stringify(value)})`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonResponse(value);
}

function jsonResponse(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function connectionPage(success, message) {
  const color = success ? "#0b6f73" : "#ad3f36";
  const title = success ? "Google Calendar conectado" : "No se pudo conectar";
  const safeMessage = escapeHtml(String(message || ""));
  const html = `<!doctype html>
    <html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef1f2;color:#172126;font-family:Arial,sans-serif;padding:24px;box-sizing:border-box}.box{max-width:440px;background:#fff;border:1px solid #d8e0e2;border-top:5px solid ${color};border-radius:8px;padding:28px;box-shadow:0 14px 40px rgba(23,33,38,.1)}h1{font-size:24px;margin:0 0 10px}p{color:#66747a;line-height:1.5;margin:0}</style></head>
    <body><main class="box"><h1>${title}</h1><p>${safeMessage}</p></main>
    <script>try{if(window.opener){window.opener.postMessage({type:"asistente-calendar-connected"},"*");setTimeout(function(){window.close()},900)}}catch(e){}</script></body></html>`;
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
