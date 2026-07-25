🧪 Add tests for PhysicsEngine checkSettlement

🎯 **What:** The testing gap addressed
The `checkSettlement` method in `src/game/engine/PhysicsEngine.ts` was missing unit tests. This method ensures that the `onAllProjectilesSettled` callback is triggered exactly when all projectiles have settled (i.e. dropped from a positive count to 0).

📊 **Coverage:** What scenarios are now tested
- Ensuring the callback is not triggered when the projectile count remains 0 (previous was 0, current is 0).
- Ensuring the callback is not triggered when projectiles are newly added (e.g. `launchProjectile` is called).
- Ensuring the callback is correctly triggered exactly once when the active projectiles count drops from >0 to 0.
- Ensuring the callback is not repeatedly triggered on subsequent calls when the count remains 0 after having settled.

✨ **Result:** The improvement in test coverage
The test coverage for `PhysicsEngine.ts` has increased, capturing the internal settlement event behaviour correctly and providing a safety net to prevent regressions in how the game determines the end of a physical action sequence.
