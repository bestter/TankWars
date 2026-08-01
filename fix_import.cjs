const fs = require('fs');
let content = fs.readFileSync('src/components/MainMenu.tsx', 'utf8');
content = content.replace(
  'import { VGA_PALETTE, type Color } from "../types/game";',
  'import { VGA_PALETTE } from "../types/game";\ntype Color = (typeof VGA_PALETTE)[keyof typeof VGA_PALETTE];'
);
fs.writeFileSync('src/components/MainMenu.tsx', content);
