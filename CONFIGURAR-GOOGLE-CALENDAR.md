# Conectar Google Calendar

Esta configuración se hace una sola vez. La aplicación seguirá publicada en GitHub Pages y Google Apps Script se encargará de crear, actualizar y eliminar las citas en tu calendario.

## 1. Crear el servicio

1. Abre [Google Apps Script](https://script.google.com/) con la misma cuenta de Google que usas en Calendar.
2. Pulsa **Nuevo proyecto** y llámalo `Asistente Calendar`.
3. Borra el contenido inicial del editor.
4. Copia todo el contenido del archivo `google-calendar-script.js` y pégalo en el editor.
5. Pulsa **Guardar**.

## 2. Generar la clave privada

1. En la lista de funciones selecciona `generarClavePrivada`.
2. Pulsa **Ejecutar** y acepta el permiso para administrar Google Calendar.
3. Abre **Registro de ejecución** y guarda el texto que aparece después de `CLAVE PRIVADA:`.

No escribas esa clave dentro de los archivos de GitHub ni la compartas. La aplicación la guardará solamente en el dispositivo donde la conectes.

## 3. Publicar el servicio

1. Pulsa **Implementar** y después **Nueva implementación**.
2. En **Tipo**, selecciona **Aplicación web**.
3. En **Ejecutar como**, selecciona **Yo**.
4. En **Quién tiene acceso**, selecciona **Cualquier usuario**.
5. Pulsa **Implementar** y copia la dirección que termina en `/exec`.

La dirección puede ser pública porque cada solicitud de modificación también debe llevar la clave privada generada en el paso anterior.

## 4. Conectar la aplicación

1. Abre Asistente y entra en **Alarmas y conexiones**.
2. Pega la dirección `/exec` en **Dirección del servicio de Google**.
3. Pega la clave en **Clave privada**.
4. Pulsa **Conectar calendario**.

La aplicación comprobará el servicio y sincronizará las citas futuras existentes. Después, cada cita nueva se crea automáticamente en Google Calendar y cada cita borrada desde Asistente también se elimina allí.

## Actualizar el servicio

Si se modifica `google-calendar-script.js`, pega de nuevo el código en Apps Script y usa **Implementar > Administrar implementaciones > Editar > Nueva versión**. Conserva la misma dirección `/exec` y la misma clave privada.
