import './App.css'
import { GameCanvas } from './components/GameCanvas'

function App() {
  return (
    <div style={{ 
      minHeight: '100vh', 
      background: '#000000',
      padding: '20px',
      fontFamily: 'monospace'
    }}>
      <header style={{ 
        textAlign: 'center', 
        marginBottom: '12px',
        color: '#55FFFF'
      }}>
        <h1 style={{ margin: 0, fontSize: '28px' }}>TANKWARS</h1>
        <p style={{ margin: '4px 0 0', color: '#AAAAAA', fontSize: '13px' }}>
          Destructible terrain prototype — click to explode
        </p>
      </header>

      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <GameCanvas />
      </div>

      <footer style={{ 
        textAlign: 'center', 
        marginTop: '16px', 
        color: '#555555', 
        fontSize: '11px' 
      }}>
        Terrain: heightmap + circular crater destruction • VGA palette rendering
      </footer>
    </div>
  )
}

export default App
