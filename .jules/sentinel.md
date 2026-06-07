## 2025-02-27 - [Insecure Randomness Mitigation]
**Vulnerability:** Extensive use of `Math.random()` across critical engine components (physics, AI strategies, wind randomness).
**Learning:** While `Math.random()` is sufficient for non-critical visual effects, using it for sensitive logic such as AI behavior or UUID generation creates a vulnerability to "Insecure Randomness". Attackers can potentially predict the outcome of future random events if they can observe enough past events or control the seed/environment.
**Prevention:** Use a cryptographically secure pseudo-random number generator (CSPRNG). The application provides a `secureRandom()` utility function backed by `crypto.getRandomValues()` which should be used for all critical random operations.
