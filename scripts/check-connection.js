const API_BASE = 'https://api.sleeper.app/v1';
const username = String(process.argv[2] ?? process.env.SLEEPER_USERNAME ?? '').trim();

if (!username) {
  console.error('Usage: node scripts/check-connection.js YOUR_SLEEPER_USERNAME');
  process.exit(1);
}

async function get(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'sleeper-fantasy-mcp/1.0' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from Sleeper API`);
  return response.json();
}

try {
  const account = await get(`/user/${encodeURIComponent(username)}`);
  if (!account?.user_id) throw new Error(`No Sleeper user found for “${username}”.`);

  const state = await get('/state/nfl');
  const season = String(state.league_season ?? state.season);
  const leagues = await get(`/user/${account.user_id}/leagues/nfl/${season}`);

  console.log(`Connected to Sleeper as ${account.display_name ?? account.username} (${account.user_id}).`);
  console.log(`Active league season: ${season}. Found ${leagues.length} league(s):`);
  for (const league of leagues) {
    console.log(`- ${league.name} — ${league.league_id} — ${league.status}`);
  }
} catch (error) {
  console.error(`Connection check failed: ${error.message}`);
  process.exit(1);
}
