🔒 Fix inadequate validation of slot parameter

🎯 **What:** The `slot` query parameter was parsed as a Number, but if an invalid non-numeric string (like "NaN") was provided, `Number.isNaN()` was not checked. This meant that `NaN < 0` and `NaN > 3` would both evaluate to `false`, bypassing the check entirely.
⚠️ **Risk:** By passing `slot=NaN`, an attacker could bypass the `slot` boundary constraints (`0` to `3`) and provide an invalid or uncontrolled slot identifier, potentially leading to unauthorized access, unexpected errors, or denial of service in the downstream WebSocket connection handler.
🛡️ **Solution:** Added `Number.isNaN(slot)` to the validation condition. This ensures that any input resulting in `NaN` will be explicitly caught and rejected with a 400 Bad Request.
