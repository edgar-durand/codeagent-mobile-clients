import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  inspectorClientSource,
  INSPECTOR_CHANNEL,
} from '../../src/services/preview/inspector-client';

/**
 * Tests del script INYECTADO, ejecutando los bytes que de verdad se envían.
 *
 * ⚠️ Se evalúa la fuente real en un DOM, no una reimplementación paralela. Es
 * la diferencia entre probar lo que se despliega y probar algo que se le
 * parece: este script corre dentro de la app de OTRA persona, así que lo que
 * hay que demostrar es que sus cuatro reglas se cumplen en el código que sale
 * por el cable.
 *
 *   1. inerte hasta que lo enciendan
 *   2. solo obedece a orígenes de la lista blanca
 *   3. describe el elemento señalado, no extrae la página
 *   4. al apagarlo no queda ni un nodo nuestro
 */

const DASHBOARD = 'https://www.codeagent-mobile.com';
const ATTACKER = 'https://evil.example.com';

interface Harness {
  dom: JSDOM;
  win: Window & typeof globalThis;
  sent: Array<Record<string, unknown>>;
  drive: (type: string, origin?: string) => void;
  hoverOver: (selector: string) => void;
  clickOn: (selector: string) => void;
}

function mount(html: string): Harness {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`,
    { runScripts: 'dangerously', url: 'https://preview-abc.codeagent-mobile.com/' },
  );
  const win = dom.window as unknown as Window & typeof globalThis;

  // El padre: el dashboard. Se captura lo que el script le manda.
  const sent: Array<Record<string, unknown>> = [];
  Object.defineProperty(win, 'parent', {
    value: {
      postMessage: (msg: Record<string, unknown>) => {
        sent.push(msg);
      },
    },
    configurable: true,
  });

  // Se evalúa la fuente REAL, quitándole las etiquetas <script>.
  const source = inspectorClientSource({ allowedOrigins: [DASHBOARD] });
  const body = source.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  win.eval(body);

  // jsdom no calcula layout: `getBoundingClientRect` devuelve ceros. Se le dan
  // medidas para poder afirmar sobre la caja del resaltado.
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const n = Number((this as HTMLElement).dataset?.box ?? 0);
    return {
      left: n, top: n, width: n + 10, height: n + 5,
      right: 0, bottom: 0, x: n, y: n, toJSON: () => ({}),
    } as DOMRect;
  };

  const post = (type: string, origin = DASHBOARD) => {
    const ev = new win.MessageEvent('message', {
      data: { source: INSPECTOR_CHANNEL, type },
    });
    Object.defineProperty(ev, 'origin', { value: origin });
    win.dispatchEvent(ev);
  };

  const fire = (selector: string, kind: 'mousemove' | 'click') => {
    const el = win.document.querySelector(selector);
    if (!el) throw new Error(`no existe ${selector}`);
    el.dispatchEvent(new win.MouseEvent(kind, { bubbles: true }));
  };

  return {
    dom,
    win,
    sent,
    drive: post,
    hoverOver: (s) => fire(s, 'mousemove'),
    clickOn: (s) => fire(s, 'click'),
  };
}

describe('inspector client — inerte hasta que lo enciendan', () => {
  /**
   * ⚠️ La regla 1. Al cargar no debe observar nada ni pintar nada: la página
   * del usuario tiene que comportarse como si no estuviéramos. Un script que
   * empieza escuchando el ratón de todo el mundo no es aceptable dentro de la
   * app de otro.
   */
  it('sin encender, un movimiento del ratón no manda nada', () => {
    const h = mount('<button id="cta">Comprar</button>');
    h.hoverOver('#cta');
    expect(h.sent).toEqual([]);
  });

  it('sin encender no añade ningún nodo al documento', () => {
    const h = mount('<button id="cta">Comprar</button>');
    h.hoverOver('#cta');
    expect(h.win.document.querySelectorAll('[data-codeam]').length).toBe(0);
  });

  it('encendido, avisa de que está listo', () => {
    const h = mount('<button id="cta">Comprar</button>');
    h.drive('enable');
    expect(h.sent.map((m) => m.type)).toContain('ready');
  });
});

describe('inspector client — lista blanca de orígenes', () => {
  /**
   * ⚠️ La regla 2, y la que de verdad importa. Sin ella, CUALQUIER página que
   * embeba el preview en un iframe podría encender el inspector y leerle la
   * estructura al proyecto del usuario. La comprobación es sobre `e.origin`,
   * que el navegador rellena y no se puede falsificar desde el contenido.
   */
  it('ignora un enable de un origen que no está en la lista', () => {
    const h = mount('<button id="cta">Comprar</button>');
    h.drive('enable', ATTACKER);
    h.hoverOver('#cta');
    expect(h.sent).toEqual([]);
  });

  it('un origen ajeno tampoco puede apagarlo', () => {
    const h = mount('<button id="cta">Comprar</button>');
    h.drive('enable');
    h.drive('disable', ATTACKER);
    h.hoverOver('#cta');
    expect(h.sent.map((m) => m.type)).toContain('hover');
  });
});

describe('inspector client — lo que reporta', () => {
  it('describe el elemento bajo el cursor', () => {
    const h = mount('<button id="cta" class="btn primary">Comprar ahora</button>');
    h.drive('enable');
    h.hoverOver('#cta');
    const hover = h.sent.find((m) => m.type === 'hover');
    expect(hover?.element).toMatchObject({
      tag: 'button',
      id: 'cta',
      classes: 'btn primary',
      selector: '#cta',
      text: 'Comprar ahora',
    });
  });

  it('al pulsar manda el elegido', () => {
    const h = mount('<a href="/otra" id="link">Ir</a>');
    h.drive('enable');
    h.clickOn('#link');
    const pick = h.sent.find((m) => m.type === 'pick');
    expect(pick?.element).toMatchObject({ tag: 'a', id: 'link' });
  });

  /**
   * ⚠️ Con el modo activo, un clic SELECCIONA — no navega. Sin tragarse el
   * evento, pulsar un enlace se llevaría el preview a otra página en mitad
   * del gesto y el usuario perdería lo que estaba señalando.
   */
  it('se traga el clic para que un enlace no navegue', () => {
    const h = mount('<a href="/otra" id="link">Ir</a>');
    h.drive('enable');
    const el = h.win.document.querySelector('#link')!;
    const ev = new h.win.MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  // La regla 3: se manda un RECORTE, no el contenido. Describir no es extraer.
  it('recorta el texto largo en vez de mandarlo entero', () => {
    const h = mount(`<p id="long">${'a'.repeat(500)}</p>`);
    h.drive('enable');
    h.hoverOver('#long');
    const hover = h.sent.find((m) => m.type === 'hover');
    const text = (hover?.element as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(121);
    expect(text.endsWith('…')).toBe(true);
  });

  // Sin React el selector CSS es el respaldo; con React llega el fichero, que
  // es lo que convierte esto en algo mejor que unas coordenadas.
  it('sin React, source es null y queda el selector', () => {
    const h = mount('<div class="card wide extra deep">x</div>');
    h.drive('enable');
    h.hoverOver('.card');
    const hover = h.sent.find((m) => m.type === 'hover');
    expect((hover?.element as { source: unknown }).source).toBeNull();
    expect((hover?.element as { selector: string }).selector).toBe('div.card.wide.extra');
  });

  it('con el fiber de React reporta fichero y línea', () => {
    const h = mount('<button id="cta">Comprar</button>');
    const el = h.win.document.querySelector('#cta') as unknown as Record<string, unknown>;
    el['__reactFiber$abc'] = {
      _debugSource: null,
      return: { _debugSource: { fileName: 'components/whatsapp-button.tsx', lineNumber: 42 } },
    };
    h.drive('enable');
    h.hoverOver('#cta');
    const hover = h.sent.find((m) => m.type === 'hover');
    expect((hover?.element as { source: unknown }).source).toEqual({
      file: 'components/whatsapp-button.tsx',
      line: 42,
    });
  });
});

describe('inspector client — el resaltado', () => {
  it('pinta un recuadro sobre lo señalado, con su medida', () => {
    const h = mount('<button id="cta" data-box="12">Comprar</button>');
    h.drive('enable');
    h.hoverOver('#cta');
    const overlay = h.win.document.querySelector('[data-codeam="inspector-overlay"]');
    const label = h.win.document.querySelector('[data-codeam="inspector-label"]');
    expect((overlay as HTMLElement).style.left).toBe('12px');
    expect((overlay as HTMLElement).style.width).toBe('22px');
    expect(label?.textContent).toContain('#cta');
    expect(label?.textContent).toContain('22×17');
  });

  /**
   * ⚠️ El overlay NUNCA captura el puntero. Si lo hiciera, el elemento de
   * debajo dejaría de recibir `mousemove` y el resaltado se quedaría pegado
   * al primero que se tocara — el inspector dejaría de seguir al cursor.
   */
  it('el recuadro no captura el puntero', () => {
    const h = mount('<button id="cta">Comprar</button>');
    h.drive('enable');
    h.hoverOver('#cta');
    const overlay = h.win.document.querySelector('[data-codeam="inspector-overlay"]');
    expect((overlay as HTMLElement).style.pointerEvents).toBe('none');
  });

  // Y no se describe a sí mismo: sin la guarda, pasar el cursor por encima del
  // resaltado reportaria nuestro propio div.
  it('no se reporta a sí mismo', () => {
    const h = mount('<button id="cta">Comprar</button>');
    h.drive('enable');
    h.hoverOver('#cta');
    const before = h.sent.length;
    const overlay = h.win.document.querySelector('[data-codeam="inspector-overlay"]')!;
    overlay.dispatchEvent(new h.win.MouseEvent('mousemove', { bubbles: true }));
    expect(h.sent.length).toBe(before);
  });
});

describe('inspector client — apagarlo lo deja todo como estaba', () => {
  /** La regla 4: reversible del todo, ni un nodo nuestro. */
  it('quita el recuadro y deja de escuchar', () => {
    const h = mount('<button id="cta">Comprar</button>');
    h.drive('enable');
    h.hoverOver('#cta');
    h.drive('disable');
    expect(h.win.document.querySelectorAll('[data-codeam]').length).toBe(0);
    const after = h.sent.length;
    h.hoverOver('#cta');
    expect(h.sent.length).toBe(after);
  });

  it('se puede volver a encender', () => {
    const h = mount('<button id="cta">Comprar</button>');
    h.drive('enable');
    h.drive('disable');
    h.drive('enable');
    h.hoverOver('#cta');
    expect(h.sent.filter((m) => m.type === 'hover').length).toBe(1);
  });
});

/**
 * El puente de React Native.
 *
 * ⚠️ En un WebView el documento es de NIVEL SUPERIOR, asi que
 * `window.parent === window` y la via del iframe no existe: el script hablaba
 * solo y en movil el inspector no devolvia NADA. Reportado el 2026-08-29 —
 * seguian llegando coordenadas donde debia llegar el elemento.
 */
describe('inspector client — dentro del WebView de la app', () => {
  interface RnHarness {
    win: Window & typeof globalThis;
    sent: string[];
    hoverOver: (selector: string) => void;
  }

  function mountInWebView(html: string): RnHarness {
    const dom = new JSDOM(
      `<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`,
      { runScripts: 'dangerously', url: 'https://preview-abc.codeagent-mobile.com/' },
    );
    const win = dom.window as unknown as Window & typeof globalThis;

    // El canal de RN, tal cual lo inyecta react-native-webview.
    const sent: string[] = [];
    (win as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = {
      postMessage: (s: string) => sent.push(s),
    };

    const source = inspectorClientSource({ allowedOrigins: [DASHBOARD] });
    win.eval(source.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));

    win.Element.prototype.getBoundingClientRect = function () {
      return {
        left: 0, top: 0, width: 10, height: 5,
        right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}),
      } as DOMRect;
    };

    return {
      win,
      sent,
      hoverOver: (selector) => {
        const el = win.document.querySelector(selector);
        if (!el) throw new Error(`no existe ${selector}`);
        el.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true }));
      },
    };
  }

  it('expone la puerta que RN puede invocar', () => {
    const h = mountInWebView('<button id="cta">x</button>');
    const api = (h.win as unknown as { __codeamInspector?: { enable: () => void } })
      .__codeamInspector;
    expect(typeof api?.enable).toBe('function');
  });

  /**
   * ⚠️ Esa puerta solo existe DENTRO del WebView. En una pagina normal seria
   * una funcion global que enciende el inspector sin permiso de nadie —
   * exactamente lo que la lista blanca de origenes existe para impedir.
   */
  it('y NO la expone en una pagina normal', () => {
    const h = mount('<button id="cta">x</button>');
    expect(
      (h.win as unknown as { __codeamInspector?: unknown }).__codeamInspector,
    ).toBeUndefined();
  });

  it('publica por el canal de RN, no por window.parent', () => {
    const h = mountInWebView('<button id="cta" class="btn">Comprar</button>');
    (h.win as unknown as { __codeamInspector: { enable: () => void } })
      .__codeamInspector.enable();
    h.hoverOver('#cta');
    const msgs = h.sent.map((s) => JSON.parse(s) as { type: string });
    expect(msgs.map((m) => m.type)).toContain('ready');
    expect(msgs.map((m) => m.type)).toContain('hover');
  });

  // El canal de RN transporta CADENAS: pasarle el objeto llega al otro lado
  // como "[object Object]".
  it('serializa el mensaje, porque ese canal solo lleva texto', () => {
    const h = mountInWebView('<button id="cta">Comprar</button>');
    (h.win as unknown as { __codeamInspector: { enable: () => void } })
      .__codeamInspector.enable();
    h.hoverOver('#cta');
    for (const raw of h.sent) {
      expect(typeof raw).toBe('string');
      expect(raw).not.toContain('[object Object]');
    }
    const hover = h.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'hover');
    expect(hover.element).toMatchObject({ tag: 'button', text: 'Comprar' });
  });

  it('apagarlo desde RN deja de publicar', () => {
    const h = mountInWebView('<button id="cta">x</button>');
    const api = (h.win as unknown as {
      __codeamInspector: { enable: () => void; disable: () => void };
    }).__codeamInspector;
    api.enable();
    h.hoverOver('#cta');
    const before = h.sent.length;
    api.disable();
    h.hoverOver('#cta');
    expect(h.sent.length).toBe(before);
  });
});

describe('inspector client — la fuente', () => {
  // Un origen con una comilla rompería el script y dejaría la página del
  // usuario SIN CARGAR. Por eso la lista va serializada, no interpolada.
  it('serializa la lista blanca en vez de interpolarla', () => {
    const src = inspectorClientSource({ allowedOrigins: [`https://x.com/'"`] });
    expect(src).toContain(JSON.stringify([`https://x.com/'"`]));
  });

  // Un `</script>` dentro del cuerpo cerraría la etiqueta antes de tiempo y
  // volcaría el resto del script como texto en la página.
  it('no contiene un </script> que cierre la etiqueta antes de tiempo', () => {
    const src = inspectorClientSource({ allowedOrigins: [DASHBOARD] });
    expect(src.split('</script>').length - 1).toBe(1);
  });
});
