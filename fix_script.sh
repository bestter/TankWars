sed -i 's/import { VGA_PALETTE, type Color }/import { VGA_PALETTE }/' src/components/MainMenu.tsx
sed -i 's/color: Color/color: (typeof VGA_PALETTE)[keyof typeof VGA_PALETTE]/' src/components/MainMenu.tsx
sed -i 's/readonly Color\[\]/readonly (typeof VGA_PALETTE)[keyof typeof VGA_PALETTE]\[\]/' src/components/MainMenu.tsx
sed -i 's/newColor: Color/newColor: (typeof VGA_PALETTE)[keyof typeof VGA_PALETTE]/' src/components/MainMenu.tsx
