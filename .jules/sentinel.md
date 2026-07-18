## 2025-02-27 - [Insecure Randomness Mitigation]
**Vulnerability:** Extensive use of `Math.random()` across critical engine components (physics, AI strategies, wind randomness).
**Learning:** While `Math.random()` is sufficient for non-critical visual effects, using it for sensitive logic such as AI behavior or UUID generation creates a vulnerability to "Insecure Randomness". Attackers can potentially predict the outcome of future random events if they can observe enough past events or control the seed/environment.
**Prevention:** Use a cryptographically secure pseudo-random number generator (CSPRNG). The application provides a `secureRandom()` utility function backed by `crypto.getRandomValues()` which should be used for all critical random operations.
## 2026-06-10 - [Remove unsafe-eval from CSP]
**Vulnerability:** The Content-Security-Policy (CSP) in `index.html` included the `'unsafe-eval'` directive in `script-src`.
**Learning:** This directive allows the execution of strings as code (e.g., via `eval()`, `setTimeout(string)`), which significantly increases the risk and impact of Cross-Site Scripting (XSS) attacks. In modern React/Vite applications, this is generally unnecessary for production environments.
**Prevention:** Avoid using `'unsafe-eval'` in the CSP. If dynamic code execution is absolutely necessary, isolate it to specific, tightly controlled sandboxes or look for alternative approaches that don't rely on string evaluation.
## 2026-06-11 - [Secure Error Handling]
**Vulnerability:** Use of raw error objects in `console.error` logs (e.g., in analytics and AI turn management) potentially leaking stack traces and structural details to client-side consoles.
**Learning:** Exposing raw error objects in client-side code can aid attackers by revealing internal paths, module names, and structural logic through stack traces. This is considered an information leakage vulnerability.
**Prevention:** When logging errors using `console.error`, explicitly extract and log the error message using `error instanceof Error ? error.message : String(error)` rather than logging the entire error object.
## 2026-06-12 - [Remove unsafe-inline from CSP script-src]
**Vulnerability:** The Content-Security-Policy (CSP) in `index.html` included the `'unsafe-inline'` directive in `script-src`.
**Learning:** This directive allows the execution of inline scripts (e.g., via `<script>...</script>` blocks or inline event handlers like `onclick="), which significantly increases the risk and impact of Cross-Site Scripting (XSS) attacks. In modern React/Vite applications, this is generally unnecessary for production environments.
**Prevention:** Avoid using `'unsafe-inline'` in the `script-src` directive of the CSP. If inline scripts are absolutely necessary, use nonces or hashes to whitelist specific inline scripts.

## Fix for Predictable Date.now() in ID Generation
Replaced hardcoded 'p-1' and 'p-2' (and any remaining Date.now()) with crypto.randomUUID() to ensure secure and unique ID generation for player configurations in MainMenu.tsx.
Added caching to `TankManager.getAlivePlayers()` to prevent array allocations inside game loop.
Tested performance using a benchmark, verified functionality via test suite.
No security impact, strictly an internal performance cache.
## 2026-06-12 - [Remove unsafe-inline from CSP script-src]\n**Vulnerability:** The Content-Security-Policy (CSP) in `public/_headers` included the `'unsafe-inline'` directive in `script-src`.\n**Learning:** This directive allows the execution of inline scripts (e.g., via `<script>...</script>` blocks or inline event handlers like `onclick="), which significantly increases the risk and impact of Cross-Site Scripting (XSS) attacks. In modern React/Vite applications, this is generally unnecessary for production environments.\n**Prevention:** Avoid using `'unsafe-inline'` in the `script-src` directive of the CSP. Ensure the configuration in HTTP headers matches the secure configuration in `index.html`.
## 2026-06-12 - [Remove unsafe-inline from CSP style-src]
**Vulnerability:** The Content-Security-Policy (CSP) in `index.html` and `public/_headers` included the `'unsafe-inline'` directive in `style-src`.
**Learning:** This directive allows the execution of inline styles (e.g., via `<style>...</style>` blocks or inline `style="..."` attributes), which significantly increases the risk and impact of CSS-based attacks, such as data exfiltration via CSS injection.
**Prevention:** Avoid using `'unsafe-inline'` in the `style-src` directive of the CSP. Ensure the configuration in HTTP headers matches the secure configuration in `index.html`.
## 2026-06-24 - [Secure CI/CD Dependency Installation]
**Vulnerability:** CI pipelines (like `deploy.yml`) were using `npm ci` without the `--ignore-scripts` flag.
**Learning:** Running `npm ci` executes post-install and pre-install scripts defined in dependencies' `package.json`. Malicious packages can use these scripts to execute arbitrary code during the CI build process, potentially stealing secrets or modifying the build output.
**Prevention:** Always use `npm ci --ignore-scripts` in CI/CD pipelines to prevent unintended code execution during dependency installation, unless execution of specific scripts is explicitly required and trusted.
## 2026-06-25 - [Input Length Exhaustion]
**Vulnerability:** Missing state-level programmatic enforcement of maximum string length for user inputs (e.g. `handleNameChange` in `MainMenu.tsx`).
**Learning:** Relying solely on the HTML `maxLength` attribute is insufficient. If a malicious user bypasses the client-side HTML restriction (e.g. via direct script interaction or API manipulation, though here it's purely frontend state), extremely large strings could be loaded into React component state. Over time, or with multiple properties, this can cause excessive memory usage or Denial of Service (DoS) conditions on the client.
**Prevention:** As a defense-in-depth measure, enforce input constraints programmatically (e.g. using `value.slice(0, MAX_LENGTH)`) before passing data to state updaters.
## 2026-06-25 - [Client-Side Data Exposure in Logs]
**Vulnerability:** Extensive use of `console.log` and `console.error` exposing sensitive game state and PII data (e.g., exact player coordinates, player names, internal IDs) during combat events and errors.
**Learning:** Even though non-error console methods are neutralized in production via `main.tsx`, leaving verbose sensitive data in development or staging logs can inadvertently leak internal state logic, PII, and structural details to developers, beta testers, or anyone accessing the environment before production minification/neutralization. It's a "Data/PII exposure" risk.
**Prevention:** Always sanitize or redact sensitive information (like exact coordinates, UUIDs, or player names) before logging to `console`. Log generic event structures instead (e.g., `(coordinates redacted)`, `(player redacted)`).
## 2026-06-25 - [Client-Side Data Exposure in Logs]
**Vulnerability:** The exact coordinates of projectile hits were being logged in `src/components/useGameSession.ts` via `console.log`.
**Learning:** This is an extension of the existing Client-Side Data Exposure in Logs vulnerability pattern found earlier. Even seemingly harmless physics data like exact coordinates should be redacted to prevent leaking precise internal state and logic to clients.
**Prevention:** Redact the exact `hit.x` and `hit.y` values and replace them with `(coordinates redacted)` in console output.
## 2026-06-25 - [Overly Permissive CORS]
**Vulnerability:** The API returned `Access-Control-Allow-Origin: '*'` which allows any origin to read data if the endpoint is called from the browser.
**Learning:** While wildcard CORS might be necessary for fully public APIs, it introduces risks for APIs that handle user data or authenticated actions. Even if authentication isn't fully implemented yet, defaulting to wildcard CORS sets a bad precedent.
**Prevention:** Validate the `Origin` request header against a whitelist of expected origins (like production domains and localhost for development) and echo the allowed origin instead of using the wildcard.

## 2026-07-15 - [Strict CORS Origin Validation]
**Vulnerability:** CORS validation in the Cloudflare Worker used `origin.endsWith('.tankwars.pages.dev')`.
**Learning:** Using `.endsWith` for CORS origin validation is overly permissive and can be bypassed by an attacker registering a domain that ends with the targeted string (e.g., `https://eviltankwars.pages.dev`). This allows unauthorized cross-origin requests.
**Prevention:** Use a strict equality check for specific domains or a tight, anchored regular expression (e.g., `/^https:\/\/[a-zA-Z0-9-]+\.tankwars\.pages\.dev$/`) to properly validate subdomains.

## Security Issue: Missing Input Validation on WebSocket Messages
**Date**: 2024-05-18
**Vulnerability Type**: Missing Input Validation / Unhandled Exception
**Description**: The `handleClientMessage` handler in `worker/src/game-room.ts` did not validate the structure or payload types of the `FIRE` message `command` property before casting it and passing it to the core authoritative simulation (`executeFire`). This allowed malformed WebSocket payloads to crash or break the simulation via undefined reference exceptions.
**Mitigation**: Added structural validation checks to the `FIRE` message handler to ensure the `command` property is an object and contains `angle` (number), `power` (number), and `weaponId` (string). Invalid payloads log a warning and return early. Always validate input structures from external client sockets before casting.
## 2026-07-16 - [Missing Input Validation on WebSocket Payloads]
**Vulnerability:** The `handleClientMessage` handler in `worker/src/game-room.ts` did not validate that `msg.name` was a string before calling `.trim()` on it during `IDENTIFY` messages. Additionally, there were no length restrictions on player names sent via WebSocket or query parameters during connection (`nameFromQuery`).
**Learning:** External inputs over WebSocket or query parameters must always be validated for type and length. Failing to do so can lead to Unhandled Exceptions (if an object or array is passed where a string method is expected) and DoS/memory bloating (if extremely large strings are passed and persisted into the Durable Object state).
**Prevention:** Always verify the type of incoming data (`typeof msg.name === 'string'`) before calling string methods. As a defense-in-depth measure, aggressively truncate input strings (e.g., `name.slice(0, 16)`) at the edge before passing them into state or memory.
