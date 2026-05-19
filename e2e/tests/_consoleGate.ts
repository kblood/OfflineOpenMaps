/**
 * Shared helper that attaches a console-error gate to a launched Electron
 * app. Every renderer-side `console.error(...)` is accumulated; the test
 * calls `assertNoConsoleErrors()` at the end and fails if anything was
 * logged.
 *
 * Why: the conversation that birthed this file shipped a build where the
 * map didn't render because MapLibre's style validator rejected the style
 * spec and logged the rejection to console.error. No vitest, no main-
 * process check, and no Playwright assertion caught it — the data-layer
 * IPC kept working fine. A console-error gate would have failed
 * pack-install.spec.ts immediately on the first run, before a single
 * .exe shipped to the user.
 *
 * Ignored noise: a small allow-list filters out known-benign messages
 * (e.g. GPU process churn during teardown) that aren't related to renderer
 * code. Keep that list short — every entry is a potential blind spot.
 */
import type { ElectronApplication, Page } from '@playwright/test';

const KNOWN_NOISE = [
  // SIGTERM during test teardown — not a real error.
  /GPU process exited unexpectedly.*exit_code=143/,
  // Chromium occasionally restarts the network service when we flip
  // offline mode mid-test. Not a renderer-code defect.
  /Network service crashed or was terminated/,
];

export interface ConsoleGate {
  /** Throws if any non-noise console.error has been observed since attach. */
  assertNoConsoleErrors(): void;
  /** Snapshot of collected errors (mainly for diagnostics). */
  errors(): readonly string[];
}

export async function attachConsoleGate(app: ElectronApplication): Promise<ConsoleGate> {
  const collected: string[] = [];
  const observe = (page: Page): void => {
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (KNOWN_NOISE.some((re) => re.test(text))) return;
      collected.push(text);
    });
    page.on('pageerror', (err) => {
      collected.push(`PAGEERROR: ${err.message}`);
    });
  };
  // Observe all current and future windows.
  for (const p of app.windows()) observe(p);
  app.on('window', observe);

  return {
    assertNoConsoleErrors(): void {
      if (collected.length === 0) return;
      const msg = collected.map((e, i) => `  [${i}] ${e}`).join('\n');
      throw new Error(
        `Renderer logged ${collected.length} console.error(s) during the test — these would have rendered as a broken map to the user:\n${msg}\n` +
          `If a message is genuinely benign, add it to KNOWN_NOISE in e2e/tests/_consoleGate.ts.`,
      );
    },
    errors(): readonly string[] {
      return collected.slice();
    },
  };
}
