🧪 Add tests for PlayerConfigRow component to achieve 100% coverage

🎯 What:
- Added comprehensive unit tests for `PlayerConfigRow.tsx`.
- Previously missing coverage for interactions with the `ColorPicker` and the compact status indicator logic.
- Ensured tests handle different `isHuman` and `aiProfile` settings effectively.

📊 Coverage:
- Compact status indicator text mapped against its corresponding controller (`P`, `CPU`, `OK`, `SNIP`, `EXPT`).
- Handled `nameInputRef` verification.
- Interacted with `ColorPicker` child component correctly reflecting to `onColorSelect`.
- Verified UI falls back to 'CPU' if an `aiProfile` is somewhat missing but the entity isn't a human.

✨ Result:
- Achieved 100% test coverage for the `PlayerConfigRow.tsx` component.
