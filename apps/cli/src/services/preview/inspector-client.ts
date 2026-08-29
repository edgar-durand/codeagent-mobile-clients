/**
 * El script que el proxy inyecta en la página del preview.
 *
 * Es lo que convierte «señalar un rectángulo» en «seleccionar un elemento»:
 * resalta lo que hay bajo el cursor como el inspector del navegador y, al
 * pulsar, devuelve al dashboard QUÉ se pulsó — etiqueta, clases, texto, caja
 * y, en desarrollo con React, el fichero y la línea del componente.
 *
 * ⚠️ **Esto corre dentro de la app de otra persona.** Las reglas no son
 * negociables y cada una está en el código de abajo:
 *
 *  1. **Inerte por defecto.** Al cargar no observa nada, no pinta nada y no
 *     toca el DOM. Solo escucha `message`. Hasta que el padre no lo enciende
 *     explícitamente, la página se comporta como si no estuviéramos.
 *  2. **Lista blanca de orígenes.** Un `message` de cualquier otro sitio se
 *     ignora. Sin esto, cualquier página que embeba el preview podría
 *     encender el inspector y leer su estructura.
 *  3. **Describe, no extrae.** Reporta la forma del elemento señalado; no
 *     recorre el documento, no lee formularios ni almacenamiento, y nunca
 *     manda nada que el usuario no haya señalado con el dedo.
 *  4. **Reversible del todo.** Al apagarlo se quitan los listeners y el
 *     overlay: no queda ni un nodo nuestro.
 *
 * Se genera como TEXTO y no se importa como módulo porque su destino es el
 * `<head>` de una página ajena, no nuestro bundle.
 */

export interface InspectorClientOptions {
  /**
   * Orígenes autorizados a manejar el inspector — los del dashboard.
   * Cualquier `message` de otro sitio se descarta sin responder.
   */
  allowedOrigins: string[];
}

/** El canal, para que ni nosotros ni la app confundamos mensajes ajenos. */
export const INSPECTOR_CHANNEL = 'codeam-inspector';

/**
 * Devuelve el `<script>` completo, listo para insertar.
 *
 * La lista blanca se serializa con `JSON.stringify` y no interpolada a pelo:
 * un origen con una comilla rompería el script y dejaría la página del
 * usuario sin cargar.
 */
export function inspectorClientSource(opts: InspectorClientOptions): string {
  const origins = JSON.stringify(opts.allowedOrigins);
  const channel = JSON.stringify(INSPECTOR_CHANNEL);

  return `<script id="codeam-inspector" data-codeam="inspector">
(function () {
  'use strict';
  try {
    var CHANNEL = ${channel};
    var ALLOWED = ${origins};

    var enabled = false;
    var driver = null;   // el origen que nos encendio
    var overlay = null;
    var label = null;
    var current = null;

    function allowed(origin) {
      return ALLOWED.indexOf(origin) !== -1;
    }

    function send(type, payload) {
      if (!driver || window.parent === window) return;
      var msg = { source: CHANNEL, type: type };
      for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
      window.parent.postMessage(msg, driver);
    }

    // El resaltado. Un div fijo por encima de todo que NUNCA captura el
    // puntero: si lo capturara, el elemento de debajo dejaria de recibir el
    // mousemove y el resaltado se quedaria pegado al primero que tocara.
    function ensureOverlay() {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.setAttribute('data-codeam', 'inspector-overlay');
      overlay.style.cssText = [
        'position:fixed', 'pointer-events:none', 'z-index:2147483647',
        'border:1px solid #a855f7', 'background:rgba(168,85,247,0.14)',
        'border-radius:2px', 'transition:none', 'display:none'
      ].join(';');
      label = document.createElement('div');
      label.setAttribute('data-codeam', 'inspector-label');
      label.style.cssText = [
        'position:fixed', 'pointer-events:none', 'z-index:2147483647',
        'background:#a855f7', 'color:#000', 'font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
        'padding:2px 6px', 'border-radius:3px', 'white-space:nowrap', 'display:none'
      ].join(';');
      document.body.appendChild(overlay);
      document.body.appendChild(label);
    }

    function removeOverlay() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (label && label.parentNode) label.parentNode.removeChild(label);
      overlay = null;
      label = null;
    }

    // Fichero y linea del componente de React, cuando el dev server los
    // expone. Es lo que hace que el agente reciba
    // "components/whatsapp-button.tsx:42" en vez de "x:0.62 y:0.81".
    // Solo existe en builds de desarrollo; en produccion devuelve null y se
    // cae al selector CSS.
    function reactSource(el) {
      try {
        for (var key in el) {
          if (key.indexOf('__reactFiber$') !== 0) continue;
          var fiber = el[key];
          while (fiber) {
            var src = fiber._debugSource;
            if (src && src.fileName) {
              return { file: String(src.fileName), line: Number(src.lineNumber) || null };
            }
            fiber = fiber.return;
          }
        }
      } catch (e) { /* nunca romper la pagina por esto */ }
      return null;
    }

    // Un selector corto y legible, el respaldo cuando no hay React.
    function selectorFor(el) {
      if (el.id) return '#' + el.id;
      var name = el.tagName ? el.tagName.toLowerCase() : 'node';
      var cls = (el.className && typeof el.className === 'string')
        ? el.className.trim().split(/\\s+/).slice(0, 3).join('.')
        : '';
      return cls ? name + '.' + cls : name;
    }

    function describe(el) {
      var r = el.getBoundingClientRect();
      var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        tag: el.tagName ? el.tagName.toLowerCase() : 'node',
        id: el.id || null,
        classes: (el.className && typeof el.className === 'string') ? el.className.trim() : '',
        selector: selectorFor(el),
        // Un recorte, no el contenido: describir no es extraer.
        text: text.length > 120 ? text.slice(0, 120) + '…' : text,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        source: reactSource(el)
      };
    }

    function paint(el) {
      ensureOverlay();
      var r = el.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = r.left + 'px';
      overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
      label.style.display = 'block';
      label.textContent = selectorFor(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
      // Encima si cabe; si no, dentro. Una etiqueta cortada por el borde
      // superior no se lee.
      var above = r.top >= 20;
      label.style.left = r.left + 'px';
      label.style.top = (above ? r.top - 20 : r.top + 2) + 'px';
    }

    function onMove(e) {
      if (!enabled) return;
      var el = e.target;
      if (!el || el === current || !el.getBoundingClientRect) return;
      if (el.getAttribute && el.getAttribute('data-codeam')) return;
      current = el;
      paint(el);
      send('hover', { element: describe(el) });
    }

    // Captura, y se traga el evento: mientras el modo esta activo un clic
    // SELECCIONA, no navega. Sin esto, pulsar un enlace se llevaria el
    // preview a otra pagina en mitad del gesto.
    function onClick(e) {
      if (!enabled) return;
      var el = e.target;
      if (el && el.getAttribute && el.getAttribute('data-codeam')) return;
      e.preventDefault();
      e.stopPropagation();
      if (el) send('pick', { element: describe(el) });
    }

    function enable(origin) {
      if (enabled) return;
      enabled = true;
      driver = origin;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      send('ready', {});
    }

    function disable() {
      if (!enabled) return;
      enabled = false;
      current = null;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      removeOverlay();
      driver = null;
    }

    window.addEventListener('message', function (e) {
      if (!allowed(e.origin)) return;
      var data = e.data;
      if (!data || data.source !== CHANNEL) return;
      if (data.type === 'enable') enable(e.origin);
      else if (data.type === 'disable') disable();
    });
  } catch (e) {
    // Pase lo que pase, la app del usuario sigue funcionando.
  }
})();
</script>`;
}
