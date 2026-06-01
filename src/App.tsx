import { useState } from 'react'
import './App.css'
import { GameCanvas } from './components/GameCanvas'
import { MainMenu } from './components/MainMenu'
import type { GamePhase } from './types/game'
import type { Player } from './types/player'

/**
 * TankWars - Root App (src/App.tsx)
 *
 * Gère le gamePhase haut niveau (React-owned) :
 * - 'MENU' → affiche MainMenu (pas de Canvas → économies ressources)
 * - 'COMBAT' / autres → monte GameCanvas (qui gère son propre sous-état de phases internes + overlays)
 *
 * Au démarrage depuis le menu : les Player[] sont créés + passés à GameCanvas
 * qui les injecte dans l'engine (TerrainManager.generate + TankManager.spawnTanks faits à l'intérieur).
 */

function App() {
  const [phase, setPhase] = useState<GamePhase>('MENU')
  const [players, setPlayers] = useState<Player[] | null>(null)

  const handleStartGame = (initialPlayers: Player[]): void => {
    setPlayers(initialPlayers)
    setPhase('COMBAT')
  }

  const handleReturnToMenu = (): void => {
    // Démontage du canvas/engine → libération ressources + retour config
    setPlayers(null)
    setPhase('MENU')
  }

  const showMenu = phase === 'MENU' && players === null

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#000000',
        fontFamily: 'monospace',
        // Padding seulement hors menu (le menu gère son propre centrage full black)
        padding: showMenu ? 0 : '12px',
      }}
    >
      {showMenu ? (
        <MainMenu onStartGame={handleStartGame} />
      ) : (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <GameCanvas
            initialPlayers={players ?? undefined}
            onReturnToMenu={handleReturnToMenu}
          />
        </div>
      )}
    </div>
  )
}

export default App
