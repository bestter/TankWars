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
## 2026-06-12 - [Remove unsafe-inline from CSP script-src]
**Vulnerability:** The Content-Security-Policy (CSP) in `public/_headers` included the `'unsafe-inline'` directive in `script-src`.
**Learning:** This directive allows the execution of inline scripts (e.g., via `<script>...</script>` blocks or inline event handlers like `onclick="`), which significantly increases the risk and impact of Cross-Site Scripting (XSS) attacks. In modern React/Vite applications, this is generally unnecessary for production environments.
**Prevention:** Avoid using `'unsafe-inline'` in the `script-src` directive of the CSP. Ensure the configuration in HTTP headers matches the secure configuration in `index.html`.
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
- Ensured strict structural validation and length constraints on WebSocket payloads to mitigate potential DoS and null references.
## 2026-07-28 - [Reflected XSS via Unvalidated Origin Payload]
**Vulnerability:** In `worker/src/game-room.ts` during room creation, the worker accepted an `origin` string from the user payload and directly injected it into a join URL (e.g. `<origin>/?room=...`), which was subsequently returned and rendered by the frontend as an unescaped link (`<a href={s.url}>`). Providing an `origin` like `javascript:alert(1);//` resulted in Reflected Cross-Site Scripting (XSS).
**Learning:** Any user-provided URL components, especially base origins, must be strictly validated before being trusted and reflected back to clients. A missing validation check on seemingly innocuous config (like origin overriding for local development) can expose the system to XSS if reflected into HTML anchor tags.
**Prevention:** Validate user-supplied origins against a strict whitelist or regex matching expected domains (e.g., `https://tankwars.pages.dev` or `http://localhost:\d+`). Fallback to a safe default if the validation fails.

## 2026-07-29 - [Origin Spoofing / Open Redirect via Client-Provided Origin]
**Vulnerability:** In `worker/src/index.ts`, the `POST /api/rooms` endpoint trusted the `body.origin` value sent by the client to generate join URLs, rather than using the server-side validated `Origin` header.
**Learning:** Even if a request's `Origin` header is strictly validated for CORS, trusting user-supplied `origin` values in the request body to construct URLs creates an open redirect and spoofing vulnerability. An attacker can bypass CORS checks from a legitimate origin but submit a malicious `origin` payload in the body, leading to generated links pointing to an attacker-controlled site or triggering XSS.
**Prevention:** Never trust client-provided base URLs or origins in request bodies for constructing links or redirects. Always rely on server-side validated origins (like the `allowedOrigin` derived from the `Origin` header) or predefined safe domains.
## 2026-07-16 - [Origin Spoofing in Room Creation]
**Vulnerability:** The `POST /api/rooms` endpoint in the Cloudflare Worker passed a client-provided `body.origin` directly into the Durable Object's `/create` logic to generate invite links, acting as an open redirect/spoofing vulnerability.
**Learning:** Client-provided origins in request bodies are inherently untrusted. Relying on them to build URLs (like invite links) allows an attacker to generate valid game states but surface malicious domains to users (e.g., for phishing).
**Prevention:** Never trust client-provided payloads for origins. Always use the server-side validated origin (e.g., `allowedOrigin` derived from CORS checks against a whitelist) when constructing secure URLs or redirect links.
- To prevent low-entropy vulnerabilities when generating room IDs or other secure identifiers, use the full string from `crypto.randomUUID()` or a dedicated high-entropy generator rather than aggressively truncating standard UUIDs (e.g., limiting to 8 characters).
## 2026-08-01 - [Missing Input Validation on Complex Object Arrays]
**Vulnerability:** The `POST /api/rooms` endpoint in `worker/src/index.ts` verified `Array.isArray(body.slots)` and length but failed to validate the structure and content of the objects within the array.
**Learning:** Blindly trusting the contents of an array (even if the array itself is verified) allows attackers to inject unexpected properties or invalid enums (like an unsupported `aiProfile`). This can lead to unhandled exceptions, corrupted state, or unexpected behavior downstream.
**Prevention:** When accepting arrays of objects, use `Array.map` to explicitly validate, safely cast, and pick only the allowed properties for each element before processing them. Verify enums against a whitelist of valid values.

## 2026-08-05 - [Missing Input Validation on Complex Object Arrays in WebSocket]
**Vulnerability:** The \`worker/src/game-room.ts\` WebSocket message handlers for events like \`ROUND_END\` and \`SHOP_READY\` relied on a weak structural check (\`isValidPlayerArray\`) that only verified if elements were objects containing an \`id\` string. It blindly trusted client payloads for all other nested properties (\`money\`, \`tank\`, \`inventory\`).
**Learning:** Blindly trusting complex nested objects in arrays from WebSocket payloads enables attackers to inject unexpected fields, invalid types, or bypass game logic (like adding unauthorized weapons or modifying state), leading to DoS or severe state corruption across all connected clients.
**Prevention:** Always implement a strict sanitization function (e.g., \`sanitizePlayer\`) that explicitly extracts, bounds-checks, and type-casts only allowed properties based on the core interfaces. Use this function with \`Array.map()\` to rebuild the objects entirely before storing them in server state.

## 2026-08-01 - [Insecure Direct Object Reference (IDOR) in State Updates]
**Vulnerability:** In `worker/src/game-room.ts`, the `mergeShopPlayerUpdate` function accepted a `patch` object from a client and updated the server's authoritative game state. If the `patch.id` did not match the expected player ID for the sender's slot, the function fell back to finding the player by the provided `patch.id` and updated that slot instead. This allowed a malicious client to modify another player's inventory or money.
**Learning:** Never trust a client to specify the ID of an entity they are updating if the action is implicitly bound to their own session/slot. Allowing a fallback ID lookup for a slot-specific action introduces an IDOR vulnerability, bypassing authorization.
**Prevention:** Strictly enforce that a client can only modify data associated with their own authenticated or assigned slot. Reject patches where the provided entity ID does not match the server's expected ID for that client's slot.
## 2024-05-18 - [Floating-Point Array Index Vulnerability]
**Vulnerability:** In `worker/src/index.ts` and `worker/src/game-room.ts`, `slot` variables parsed from request URL parameters/headers were validated using `Number.isNaN(slot)` before being checked against integer bounds (e.g., `slot < 0 || slot >= this.state.numPlayers`) and subsequently used as array indices (`state.slotConfigs[slot]`).
**Learning:** Checking for `NaN` is insufficient when processing untrusted numbers intended for array indexing. Attackers can supply floating-point numbers (e.g., `slot=0.5`). Since `0.5 < 0` and `0.5 >= 2` are both false, the bounds check passes, but accessing `slotConfigs[0.5]` returns `undefined`. Subsequent property access (e.g., `cfg.type`) then throws a `TypeError: undefined is not an object`, resulting in an unhandled exception and crashing the request handler (Denial of Service).
**Prevention:** When parsing numerical input from HTTP requests (e.g., URL parameters, headers) for use as array indices or bounded counts, strictly validate them using `Number.isInteger()` rather than `Number.isNaN()` to ensure the value is a safe integer before applying bounds checks.
## 2026-08-03 - [Missing Input Validation on JSON Payload]
**Vulnerability:** Unhandled exception (Denial of Service risk) in the Cloudflare Worker when processing array or null payloads on the `POST /api/rooms` endpoint.
**Learning:** The `request.json()` method will successfully parse valid JSON arrays (e.g. `[1, 2]`) and `null` values, meaning the fallback `catch` block will not be triggered. If the code blindly assumes the result is an object (via a typecast like `as Record<string, unknown>`) without validating its shape at runtime, accessing a property like `body.numPlayers` on `null` will throw a `TypeError: Cannot read properties of null`. This results in an unhandled exception that crashes the request handler, posing a Denial of Service risk.
**Prevention:** Always enforce strict runtime validation on the result of `request.json()`. Before assuming it is an object and accessing its properties, verify it is neither null nor an array using `if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))`.

## 2026-08-05 - [Infinity/NaN Injection via Insufficient Numeric Validation]
**Vulnerability:** In `worker/src/game-room.ts` and `src/components/useGameSession.ts`, untrusted numeric values from WebSocket payloads were validated using `!Number.isNaN(value)` or merely `typeof value === 'number'`. This allowed malicious clients to inject `Infinity` or `-Infinity` for properties like `health`, `money`, `angle`, and `power`.
**Learning:** `typeof x === 'number'` and `!Number.isNaN(x)` both allow `Infinity` and `-Infinity`. If these values propagate into physics calculations, monetary balances, or entity stats, they can lead to Denial of Service (DoS via physics engine crashes/infinite loops) or severe logic bypasses (e.g., infinite money or health).
**Prevention:** Always use `Number.isFinite()` when validating continuous numeric inputs from untrusted sources, and `Number.isInteger()` for indices or counts. Never rely on `!Number.isNaN()` alone for complete numeric safety.

## 2024-05-18 - [Infinity/-Infinity Injection via isNaN]
**Vulnerability:** In `worker/src/game-room.ts`, untrusted numeric inputs inside `sanitizePlayer` were validated using `!Number.isNaN()`. This allows `Infinity` and `-Infinity` to pass the validation and be injected into the game state.
**Learning:** `!Number.isNaN(x)` returns true for `Infinity` and `-Infinity`. If these values are used in calculations or bounding logic, they can cause unexpected behavior, out-of-bounds exceptions, or Denial of Service (DoS).
**Prevention:** Use `Number.isFinite()` instead of `!Number.isNaN()` when validating untrusted continuous numeric inputs (e.g., game stats, coordinates, physics parameters) to ensure they are safe finite numbers.

## 2026-08-07 - [Prevent Stack Trace Leakage via Durable Object Error Proxies]
**Vulnerability:** The Cloudflare Worker proxy code in `worker/src/index.ts` was forwarding raw error response texts (including stack traces generated by Durable Objects) directly to the frontend when a 500 status code occurred on the internal `fetch` paths (`/internal/create` and `join`).
**Learning:** Returning unhandled or proxied 5xx status codes blindly from Durable Objects can expose sensitive server-side details (e.g. implementation details or stack traces) to untrusted clients.
**Prevention:** In Cloudflare Workers, always intercept 5xx proxy responses. Log the raw error (`await response.text()`) securely using `console.error` and return a sanitized JSON error payload (e.g., `{"error":"Internal Server Error"}`) to the client.

## 2024-05-18 - [TypeError DoS via Unvalidated JSON Parsing]
**Vulnerability:** In `worker/src/game-room.ts`, the `fetchCreate` method parsed the JSON payload using `await request.json()` and immediately accessed its properties (e.g. `body.roomId`) without validating the parsed object's type. A malicious client could send a JSON payload like `"null"` or `[1, 2, 3]`, which parses successfully but causes a `TypeError` when properties are accessed, resulting in a Denial of Service.
**Learning:** `request.json()` can return null or an array if the input is valid JSON of those types. Typecasting (`as Record<string, unknown>`) does not protect against runtime errors when accessing properties on null.
**Prevention:** Always use strict runtime type checking (`typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)`) after parsing JSON before assigning or accessing properties.

## 2026-08-08 - [Missing Origin Validation for WebSocket Upgrades]
**Vulnerability:** The `/api/rooms/:roomId/ws` route in `worker/src/index.ts` accepted WebSocket upgrade requests without validating the `Origin` header, bypassing the CORS protections enforced on HTTP fetch routes.
**Learning:** WebSocket connections do not adhere to CORS preflight restrictions. If a server does not explicitly validate the `Origin` header during the initial HTTP upgrade request, it is vulnerable to Cross-Site WebSocket Hijacking (CSWSH), allowing malicious sites to establish connections and interact with the server on behalf of authenticated/active users.
**Prevention:** Always implement explicit `Origin` validation before granting a WebSocket connection upgrade, ensuring that the request originates from an allowed and trusted domain.

## 2026-08-09 - [Cloudflare API Unhandled Exception DoS]
**Vulnerability:** The `worker/src/index.ts` endpoint passed an unvalidated, user-supplied `roomId` directly to `env.GAME_ROOM.idFromName(roomId)`.
**Learning:** Cloudflare's `idFromName` API enforces a strict maximum length (256 bytes). Passing a string larger than this limit causes the API to throw an unhandled exception (`Error: idFromName must be 256 bytes or less`), which crashes the Worker execution for that request. Without a try-catch or length check, attackers can trigger this exception repeatedly, resulting in a Denial of Service (DoS) and excessive internal server errors.
**Prevention:** Always validate the length of user-provided strings before passing them to strict internal APIs like Cloudflare's `idFromName`, restricting them to safe limits (e.g., `<= 256` bytes).

## 2026-10-18 - [DoS via Unvalidated roomId length]
**Vulnerability:** In `worker/src/index.ts`, the `roomId` parsed from the URL was passed directly into `env.GAME_ROOM.idFromName(roomId)` without length validation.
**Learning:** Cloudflare Durable Object `idFromName` requires a string of 256 bytes or fewer. Passing an exceptionally large string (e.g., 1MB) causes an unhandled exception, which crashes the worker proxy loop and creates a Denial of Service risk.
**Prevention:** Always perform length validation on dynamic identifiers from untrusted URL paths or headers before passing them to backend APIs with strict limits like `idFromName`.
