
## 🧪 Testing Improvement Task

🎯 **What:** The testing gap for `PhysicsEngine.hasActiveProjectiles` addressed. The original suite verified the status on direct instantiation, launch, clear, and single out-of-bounds removal. It lacked explicit validations that test edge cases specifically related to how `hasActiveProjectiles()` interoperates with the engine's internal settlement notification phase, and scenarios when the flag should safely be reset externally by forced clears (like during soft phase resets) ensuring no phantom settlements trigger.

📊 **Coverage:** Added coverage for two key scenarios to firmly lock down the API behaviour boundary:
1. **Settlement triggering synchronization**: A test now confirms that `hasActiveProjectiles()` transitioning to `false` reliably guarantees that the `onAllProjectilesSettled` callback is triggered internally during an engine update loop when a projectile vanishes out of bounds.
2. **Direct Clear Without Notification**: Verified the behaviour when the engine is directly cleared without settlement notification, confirming that `hasActiveProjectiles()` accurately defaults to `false` without triggering any side-effects.

✨ **Result:** Solidifies the boolean property and prevents any regressions that could decouple the status boolean from internal mechanics during refactoring. The `hasActiveProjectiles` method test block is now thoroughly comprehensive.
