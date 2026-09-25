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

    // ¿Estamos dentro del WebView de la app movil?
    //
    // ⚠️ En un WebView el documento es de NIVEL SUPERIOR, asi que
    // \`window.parent === window\` y la via del iframe no existe: el script
    // hablaba solo, y en movil el inspector no devolvia nada. React Native
    // expone su propio canal, que es el unico que sale de ahi.
    function rnBridge() {
      return typeof window.ReactNativeWebView !== 'undefined' &&
        window.ReactNativeWebView &&
        typeof window.ReactNativeWebView.postMessage === 'function'
        ? window.ReactNativeWebView
        : null;
    }

    function send(type, payload) {
      if (!driver) return;
      var msg = { source: CHANNEL, type: type };
      for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];

      var rn = rnBridge();
      if (rn) {
        // El canal de RN transporta CADENAS, no objetos: pasarle el objeto
        // llega al otro lado como "[object Object]".
        rn.postMessage(JSON.stringify(msg));
        return;
      }
      if (window.parent === window) return;
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
    /**
     * Las marcas FIJADAS, dibujadas DENTRO de la pagina.
     *
     * ⚠️ Antes las pintaba el dashboard, en una capa sobre el iframe. Como esa
     * capa vive fuera del documento, sus coordenadas son del VIEWPORT: al
     * hacer scroll dentro del preview las marcas se quedaban clavadas en la
     * pantalla mientras el elemento se iba (reportado el 2026-08-29).
     *
     * Aqui se anclan al DOCUMENTO (position:absolute mas el scroll sumado), asi
     * que acompañan al contenido igual que cualquier otro nodo de la pagina — y
     * ademas se recolocan si el layout cambia, que una capa externa no puede
     * saber.
     */
    var picked = [];
    var seq = 0;
    var marksHost = null;

    function ensureMarksHost() {
      if (marksHost && marksHost.parentNode) return marksHost;
      marksHost = document.createElement('div');
      marksHost.setAttribute('data-codeam', 'marks');
      marksHost.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646';
      document.body.appendChild(marksHost);
      return marksHost;
    }

    function redrawMarks() {
      if (picked.length === 0) {
        if (marksHost && marksHost.parentNode) marksHost.parentNode.removeChild(marksHost);
        marksHost = null;
        return;
      }
      var host = ensureMarksHost();
      host.innerHTML = '';
      for (var i = 0; i < picked.length; i++) {
        var r = picked[i].el.getBoundingClientRect();
        // Coordenadas de DOCUMENTO: es lo que hace que la marca viaje con el
        // contenido en vez de quedarse pegada a la pantalla.
        var top = r.top + (window.scrollY || window.pageYOffset || 0);
        var left = r.left + (window.scrollX || window.pageXOffset || 0);

        var box = document.createElement('div');
        box.setAttribute('data-codeam', 'mark');
        box.style.cssText = [
          'position:absolute', 'pointer-events:none', 'box-sizing:border-box',
          'border:1.5px solid #a855f7', 'background:rgba(168,85,247,0.12)',
          'border-radius:3px',
          'left:' + left + 'px', 'top:' + top + 'px',
          'width:' + r.width + 'px', 'height:' + r.height + 'px'
        ].join(';');

        var badge = document.createElement('div');
        badge.setAttribute('data-codeam', 'mark-badge');
        badge.style.cssText = [
          'position:absolute', 'left:-10px', 'top:-10px', 'width:20px', 'height:20px',
          'border-radius:10px', 'background:#a855f7', 'color:#000',
          'font:700 11px/20px ui-monospace,SFMono-Regular,Menlo,monospace',
          'text-align:center', 'pointer-events:none'
        ].join(';');
        badge.textContent = String(i + 1);

        box.appendChild(badge);
        host.appendChild(box);
      }
    }

    function reposition() { if (picked.length) redrawMarks(); }

    // Captura, y se traga el evento: mientras el modo esta activo un clic
    // SELECCIONA, no navega. Sin esto, pulsar un enlace se llevaria el
    // preview a otra pagina en mitad del gesto.
    function onClick(e) {
      if (!enabled) return;
      var el = e.target;
      if (el && el.getAttribute && el.getAttribute('data-codeam')) return;
      e.preventDefault();
      e.stopPropagation();
      if (!el) return;
      var id = 'p' + (++seq);
      picked.push({ id: id, el: el });
      redrawMarks();
      var described = describe(el);
      described.markId = id;
      send('pick', { element: described });
    }

    /**
     * El dashboard manda la lista de ids que SIGUEN vivos, en su orden.
     *
     * Es la otra mitad de «la marca es un objeto»: si el usuario borra un chip
     * en el composer, la marca tiene que desaparecer de la pagina — y las que
     * quedan renumerarse, porque lo que el usuario escribe («① se sale») mira
     * a estos numeros.
     */
    function syncMarks(ids) {
      var byId = {};
      for (var i = 0; i < picked.length; i++) byId[picked[i].id] = picked[i];
      var next = [];
      for (var j = 0; j < ids.length; j++) if (byId[ids[j]]) next.push(byId[ids[j]]);
      picked = next;
      redrawMarks();
    }

    /**
     * Las marcas del AGENTE — la herramienta highlight_element.
     *
     * Van aparte de las del usuario a proposito: no se numeran, no se pueden
     * borrar desde el composer y no dependen de que el modo inspector este
     * encendido. Son el agente SEÑALANDO algo, y el usuario las ve aunque no
     * haya tocado nada: un cursor que viaja hasta el elemento, lo centra en
     * pantalla y deja una caja con su etiqueta.
     *
     * Mismo anclaje que las marcas fijadas (coordenadas de documento), asi que
     * acompañan al scroll. Un selector que no encuentra nada no pinta nada: el
     * agente ya sabe por la herramienta que puede fallar.
     */
    var AGENT = '#22d3ee';
    var agentMarks = [];
    var agentHost = null;
    var agentCursor = null;
    var agentStyle = null;
    var agentListening = false;

    function ensureAgentStyle() {
      if (agentStyle && agentStyle.parentNode) return;
      agentStyle = document.createElement('style');
      agentStyle.setAttribute('data-codeam', 'agent-style');
      agentStyle.textContent =
        '@keyframes codeam-agent-pulse{0%{box-shadow:0 0 0 0 rgba(34,211,238,.55)}' +
        '70%{box-shadow:0 0 0 10px rgba(34,211,238,0)}100%{box-shadow:0 0 0 0 rgba(34,211,238,0)}}' +
        '@keyframes codeam-agent-in{from{opacity:0;transform:scale(1.06)}to{opacity:1;transform:scale(1)}}';
      (document.head || document.documentElement).appendChild(agentStyle);
    }

    function ensureAgentCursor() {
      if (agentCursor && agentCursor.parentNode) return agentCursor;
      agentCursor = document.createElement('div');
      agentCursor.setAttribute('data-codeam', 'agent-cursor');
      agentCursor.style.cssText = [
        'position:fixed', 'pointer-events:none', 'z-index:2147483647',
        'left:' + Math.round(window.innerWidth / 2) + 'px', 'top:' + Math.round(window.innerHeight - 40) + 'px',
        'transition:left .6s cubic-bezier(.22,1,.36,1),top .6s cubic-bezier(.22,1,.36,1),opacity .3s',
        'opacity:0'
      ].join(';');
      agentCursor.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">' +
        '<path d="M4 2l15 8.5-6.6 1.6L9 18.5z" fill="' + AGENT + '" stroke="#000" stroke-width="1.2"/></svg>' +
        '<div style="margin:2px 0 0 14px;background:' + AGENT + ';color:#000;font:700 10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
        'padding:1px 6px;border-radius:8px;white-space:nowrap">Agent</div>';
      document.body.appendChild(agentCursor);
      return agentCursor;
    }

    function redrawAgentMarks() {
      if (agentMarks.length === 0) {
        if (agentHost && agentHost.parentNode) agentHost.parentNode.removeChild(agentHost);
        agentHost = null;
        return;
      }
      if (!agentHost || !agentHost.parentNode) {
        agentHost = document.createElement('div');
        agentHost.setAttribute('data-codeam', 'agent-marks');
        agentHost.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646';
        document.body.appendChild(agentHost);
      }
      agentHost.innerHTML = '';
      var sx = window.scrollX || window.pageXOffset || 0;
      var sy = window.scrollY || window.pageYOffset || 0;
      for (var i = 0; i < agentMarks.length; i++) {
        var m = agentMarks[i];
        if (!m.el.isConnected) continue;
        var r = m.el.getBoundingClientRect();
        var box = document.createElement('div');
        box.setAttribute('data-codeam', 'agent-mark');
        box.style.cssText = [
          'position:absolute', 'pointer-events:none', 'box-sizing:border-box',
          'border:2px solid ' + AGENT, 'background:rgba(34,211,238,0.10)', 'border-radius:4px',
          'left:' + (r.left + sx - 3) + 'px', 'top:' + (r.top + sy - 3) + 'px',
          'width:' + (r.width + 6) + 'px', 'height:' + (r.height + 6) + 'px',
          'animation:codeam-agent-in .25s ease-out,codeam-agent-pulse 1.6s ease-out 3'
        ].join(';');
        if (m.label) {
          var tag = document.createElement('div');
          tag.setAttribute('data-codeam', 'agent-mark-label');
          tag.style.cssText = [
            'position:absolute', 'left:-2px', (r.top >= 22 ? 'top:-22px' : 'bottom:-22px'),
            'background:' + AGENT, 'color:#000', 'font:700 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
            'padding:0 6px', 'border-radius:3px', 'white-space:nowrap', 'max-width:260px',
            'overflow:hidden', 'text-overflow:ellipsis'
          ].join(';');
          tag.textContent = m.label;
          box.appendChild(tag);
        }
        agentHost.appendChild(box);
      }
    }

    function listenAgentLayout() {
      if (agentListening) return;
      agentListening = true;
      window.addEventListener('scroll', redrawAgentMarks, true);
      window.addEventListener('resize', redrawAgentMarks);
    }

    function agentHighlight(selector, labelText) {
      var el = null;
      try { el = document.querySelector(String(selector)); } catch (e) { el = null; }
      if (!el || !el.getBoundingClientRect) return false;
      ensureAgentStyle();
      listenAgentLayout();
      try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (e) { /* viejo */ }
      var cursor = ensureAgentCursor();
      // Tras el scroll suave: el cursor viaja al centro del elemento y, al
      // llegar, aparece la caja. El orden es lo que se lee como «el agente
      // lo esta señalando» y no como un recuadro que salta.
      setTimeout(function () {
        var r = el.getBoundingClientRect();
        cursor.style.opacity = '1';
        cursor.style.left = Math.round(r.left + Math.min(r.width / 2, 40)) + 'px';
        cursor.style.top = Math.round(r.top + Math.min(r.height / 2, 24)) + 'px';
        setTimeout(function () {
          agentMarks.push({ el: el, label: labelText ? String(labelText).slice(0, 80) : '' });
          redrawAgentMarks();
        }, 620);
      }, 380);
      return true;
    }

    function agentClear() {
      agentMarks = [];
      redrawAgentMarks();
      if (agentCursor && agentCursor.parentNode) agentCursor.parentNode.removeChild(agentCursor);
      agentCursor = null;
      if (agentStyle && agentStyle.parentNode) agentStyle.parentNode.removeChild(agentStyle);
      agentStyle = null;
      if (agentListening) {
        window.removeEventListener('scroll', redrawAgentMarks, true);
        window.removeEventListener('resize', redrawAgentMarks);
        agentListening = false;
      }
    }

    function enable(origin) {
      if (enabled) return;
      enabled = true;
      driver = origin;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      // El scroll y el resize mueven los elementos; las marcas los siguen.
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      send('ready', {});
    }

    function disable() {
      if (!enabled) return;
      enabled = false;
      current = null;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      removeOverlay();
      // Las marcas fijadas SI sobreviven a salir del modo: siguen siendo el
      // contexto del mensaje que el usuario esta escribiendo.
      driver = null;
    }

    window.addEventListener('message', function (e) {
      if (!allowed(e.origin)) return;
      var data = e.data;
      if (!data || data.source !== CHANNEL) return;
      if (data.type === 'enable') enable(e.origin);
      else if (data.type === 'disable') disable();
      else if (data.type === 'marks' && data.ids) syncMarks(data.ids);
      else if (data.type === 'agent-highlight' && data.selector) agentHighlight(data.selector, data.label);
      else if (data.type === 'agent-clear') agentClear();
    });

    /**
     * La puerta para React Native, que no puede usar \`postMessage\`.
     *
     * ⚠️ Aqui NO hay lista blanca de origenes, y no es un descuido: quien
     * llama esto es la app anfitriona sobre SU PROPIO WebView, via
     * \`injectJavaScript\` — no hay un tercero al que filtrar. La lista blanca
     * protege el caso del iframe, donde cualquier pagina puede embeber el
     * preview y mandar mensajes; ese caso sigue exactamente igual de cerrado.
     *
     * Solo se expone donde ese puente existe, para no dejar en una pagina
     * normal una funcion global que encienda el inspector sin permiso.
     */
    if (rnBridge()) {
      window.__codeamInspector = {
        enable: function () { enable('react-native'); },
        disable: disable,
        // La app movil ya llamaba \`marks\` al borrar un chip y no existia:
        // la marca se quedaba pintada en la pagina.
        marks: function (ids) { if (ids && ids.length !== undefined) syncMarks(ids); },
        highlight: function (selector, text) { return agentHighlight(selector, text); },
        clear: agentClear,
      };
    }
  } catch (e) {
    // Pase lo que pase, la app del usuario sigue funcionando.
  }
})();
</script>`;
}
