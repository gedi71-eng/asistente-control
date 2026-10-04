# Conectar Google Calendar con un clic

Esta configuración la hace una sola vez el propietario de la aplicación. Después, en el computador o en el celular, cada usuario solo pulsa **Conectar con Google**, elige su cuenta y acepta el permiso.

La aplicación seguirá publicada gratis en GitHub Pages. Google Apps Script se encargará de crear, actualizar y eliminar las citas en Google Calendar. El secreto de Google nunca se sube a GitHub ni se guarda en el teléfono.

## 1. Crear el servicio en Apps Script

1. Abre [Google Apps Script](https://script.google.com/) con tu cuenta de Google.
2. Pulsa **Nuevo proyecto** y llámalo `Asistente Calendar`.
3. Borra el contenido inicial del editor.
4. Copia todo el contenido de `google-calendar-script.js` y pégalo en el editor.
5. Pulsa **Guardar**.
6. Pulsa **Implementar > Nueva implementación**.
7. En **Tipo**, elige **Aplicación web**.
8. En **Ejecutar como**, elige **Yo**.
9. En **Quién tiene acceso**, elige **Cualquier usuario**.
10. Pulsa **Implementar** y copia la dirección completa que termina en `/exec`.

Guarda esa dirección. Será la **dirección de redireccionamiento autorizada** y también la dirección pública del servicio.

## 2. Preparar Google Cloud

1. Abre [Google Cloud Console](https://console.cloud.google.com/).
2. Crea un proyecto o selecciona uno existente.
3. En **APIs y servicios > Biblioteca**, busca y habilita **Google Calendar API**.
4. En **APIs y servicios > Pantalla de consentimiento OAuth**, escribe el nombre `Asistente de Control`, selecciona **Externo** y completa los datos obligatorios.
5. Si la aplicación está en modo de prueba, agrega como **usuario de prueba** cada correo que vaya a conectarse.
6. En **APIs y servicios > Credenciales**, pulsa **Crear credenciales > ID de cliente de OAuth**.
7. Selecciona **Aplicación web**.
8. En **URI de redireccionamiento autorizados**, pega exactamente la dirección `/exec` copiada en el paso anterior.
9. Pulsa **Crear** y guarda estos dos datos:
   - ID de cliente, que termina en `.apps.googleusercontent.com`.
   - Secreto del cliente.

Importante: en el modo de prueba de Google, una autorización de una aplicación externa puede vencer después de siete días. Para un uso estable, cambia el estado de publicación a **En producción** cuando termines las pruebas. Google puede solicitar verificación si la aplicación se ofrece públicamente a muchas personas.

## 3. Guardar el secreto solamente en Apps Script

1. Vuelve al editor de Apps Script.
2. Al comienzo de `google-calendar-script.js`, dentro de `configurarServicio()`, reemplaza:
   - `PEGA_AQUI_EL_ID_DE_CLIENTE.apps.googleusercontent.com` por tu ID de cliente.
   - `PEGA_AQUI_EL_SECRETO_DEL_CLIENTE` por tu secreto.
3. Deja `APP_ORIGIN` como `https://gedi71-eng.github.io`.
4. Guarda el archivo.
5. En la lista de funciones, selecciona `configurarServicio` y pulsa **Ejecutar**.
6. Acepta los permisos que pida Google.
7. Pulsa **Implementar > Administrar implementaciones > Editar**.
8. En **Versión**, selecciona **Nueva versión** y pulsa **Implementar**.

La dirección `/exec` seguirá siendo la misma. No publiques el secreto del cliente en GitHub ni lo escribas en `google-config.js`.

## 4. Preparar la aplicación

Abre `google-config.js` y escribe solamente los dos datos públicos:

```js
window.ASISTENTE_CONFIG = {
  googleSyncEndpoint: "PEGA_AQUI_LA_DIRECCION_QUE_TERMINA_EN_EXEC",
  googleOAuthClientId: "PEGA_AQUI_EL_ID_DE_CLIENTE.apps.googleusercontent.com"
};
```

Después sube a GitHub los archivos actualizados de la aplicación. La configuración administrativa ya no tendrá que escribirse en cada teléfono.

## 5. Conectar un computador o celular

1. Abre la aplicación publicada.
2. Entra en **Alarmas y conexiones** o pulsa **Conectar Calendar**.
3. Pulsa **Conectar con Google**.
4. Elige la cuenta de Google y acepta el permiso de Calendar.

Eso se hace una vez por dispositivo. A partir de ahí:

- Una cita nueva en Asistente se crea automáticamente en Google Calendar.
- Una cita modificada en Asistente se actualiza en Google Calendar.
- Una cita eliminada en Asistente se elimina de Google Calendar.
- Los avisos configurados en Asistente se envían como recordatorios del evento de Google.

La sincronización actual es de Asistente hacia Google Calendar. Los cambios hechos directamente en Google Calendar no regresan todavía a Asistente.

## Actualizar el servicio después

Cuando se cambie `google-calendar-script.js`, pega el código nuevo en Apps Script y usa **Implementar > Administrar implementaciones > Editar > Nueva versión**. Conserva la misma dirección `/exec`, el mismo ID de cliente y el mismo secreto.
