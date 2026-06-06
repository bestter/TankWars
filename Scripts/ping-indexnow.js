// scripts/ping-indexnow.js
const config = {
  host: "tankwars.pages.dev",
  key: "2ac691dd3c8b01eb5b5cb4204a8372145e2bac620f98286f384e968d1d9d9a83", // Remplace par ta vraie clé
  keyLocation: "https://tankwars.pages.dev/2ac691dd3c8b01eb5b5cb4204a8372145e2bac620f98286f384e968d1d9d9a83.txt",
  urlList: ["https://tankwars.pages.dev/"]
};

async function notifySearchEngines() {
  try {
    const response = await fetch('https://api.indexnow.org/IndexNow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(config)
    });

    if (response.ok) {
      console.log('✅ IndexNow: Bing et DuckDuckGo ont été notifiés.');
    } else {
      console.error(`❌ IndexNow Error: Status ${response.status}`);
    }
  } catch (error) {
    console.error('❌ IndexNow Réseau Error:', error.message);
  }
}

notifySearchEngines();