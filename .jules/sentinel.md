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
