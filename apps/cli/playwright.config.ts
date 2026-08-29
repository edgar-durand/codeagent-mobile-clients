import { defineConfig, devices } from '@playwright/test';

/**
 * E2E del inspector de preview, en un navegador REAL.
 *
 * ⚠️ Existe porque las dos mitades solo se pueden juzgar juntas. El proxy se
 * prueba contra sockets de verdad (`__tests__/preview/inspector-proxy.int`) y
 * el script inyectado se evalúa en un DOM (`…/inspector-client`), pero ninguno
 * de los dos demuestra lo que de verdad importa: que una página cargada A
 * TRAVÉS del proxy trae el script vivo, que el padre puede encenderlo por
 * `postMessage`, y que un clic devuelve el elemento. Eso solo lo dice un
 * navegador.
 *
 * Vive en el repo de clientes, no en el del dashboard, porque proxy y script
 * son de aquí: probarlos allí sería una dependencia entre repos para no ganar
 * nada.
 *
 * No entra en `npm test`: es un `npm run e2e` aparte para no obligar a
 * descargar navegadores en cada instalación.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
