// Forge entrypoint: start the server, register its port with the trial
// environment, and wait until the environment says the trial is over.
// All forge behaviour lives in app.ts. The environment address comes from
// MAKEFUN_ENV_URL; the server binds an ephemeral port (never 8080).

import { createApp } from "./app.ts";

const envUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

if (envUrl === "") {
  process.stderr.write("error: MAKEFUN_ENV_URL is not set, cannot join a trial\n");
  process.exit(1);
}

// One request may take at most 30s; retries pause 250ms, doubling to 2000ms.
const REQUEST_TIMEOUT = 30_000;
const RETRY_START_MS = 250;
const RETRY_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Pause before retry `attempt`: 250, 500, 1000, then 2000 ms.
function retryPauseMs(attempt: number): number {
  const pause = RETRY_START_MS * 2 ** attempt;
  return pause < RETRY_CAP_MS ? pause : RETRY_CAP_MS;
}

// Register the bound port. 200 records it, 409 means another entry won the
// race (fine). 400/405 are fatal; anything else is retried.
async function registerForge(port: number): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT)
      });
      if (response.status === 200 || response.status === 409) {
        return;
      }
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register rejected with HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("register rejected")) {
        throw error;
      }
      // Transient failure: retry after a pause.
    }
    await sleep(retryPauseMs(attempt));
    attempt += 1;
  }
}

// Poll until the environment reports the trial finished; failed polls retry.
async function waitForTrialEnd(): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT)
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) {
          return;
        }
      }
    } catch (e) {
      // No answer yet; try again after a pause.
    }
    await sleep(retryPauseMs(attempt));
    attempt += 1;
  }
}

async function boot(): Promise<void> {
  const forge = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    forge.once("error", reject);
    forge.listen(0, () => {
      const address = forge.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  process.stdout.write(`forge listening on port ${port}\n`);

  await registerForge(port);
  process.stdout.write("forge registered with trial environment\n");

  await waitForTrialEnd();
  forge.close();
  process.stdout.write("trial done, shutting down\n");
}

boot().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
