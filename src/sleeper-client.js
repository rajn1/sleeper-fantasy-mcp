import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const API_BASE = 'https://api.sleeper.app/v1';
const REQUEST_TIMEOUT_MS = 20_000;
const PLAYER_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const accountCache = new Map();
let playersMemory = null;
let playersLoadedAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathPart(value) {
  return encodeURIComponent(String(value));
}

function assertNumericId(label, value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label} must be a numeric Sleeper ID.`);
  }
  return normalized;
}

function assertSeason(value) {
  const normalized = String(value ?? '').trim();
  if (!/^20\d{2}$/.test(normalized)) {
    throw new Error('season must be a four-digit year such as 2026.');
  }
  return normalized;
}

async function fetchJson(endpoint, { retries = 2 } = {}) {
  const url = `${API_BASE}${endpoint}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'sleeper-fantasy-mcp/1.0'
        },
        signal: controller.signal
      });

      const body = await response.text();
      if (!response.ok) {
        const detail = body.slice(0, 300).replace(/\s+/g, ' ').trim();
        const error = new Error(
          `Sleeper API returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`
        );
        error.status = response.status;
        throw error;
      }

      return body ? JSON.parse(body) : null;
    } catch (error) {
      lastError = error;
      const retryable =
        error?.name === 'AbortError' ||
        error?.status === 429 ||
        (Number.isInteger(error?.status) && error.status >= 500);

      if (!retryable || attempt === retries) {
        throw error;
      }

      await sleep(350 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

function configuredLocator(usernameOverride) {
  const explicitUserId = String(process.env.SLEEPER_USER_ID ?? '').trim();
  if (explicitUserId) return explicitUserId;

  const username = String(usernameOverride ?? process.env.SLEEPER_USERNAME ?? '').trim();
  if (!username) {
    throw new Error(
      'No Sleeper account is configured. Set SLEEPER_USERNAME in the MCP server environment.'
    );
  }
  return username;
}

export async function getAccount(usernameOverride) {
  const locator = configuredLocator(usernameOverride);
  if (accountCache.has(locator)) return accountCache.get(locator);

  const account = await fetchJson(`/user/${pathPart(locator)}`);
  if (!account?.user_id) {
    throw new Error(`Sleeper account “${locator}” was not found.`);
  }

  accountCache.set(locator, account);
  accountCache.set(String(account.user_id), account);
  return account;
}

export async function getNflState() {
  return fetchJson('/state/nfl');
}

export async function getLeague(leagueId) {
  return fetchJson(`/league/${assertNumericId('league_id', leagueId)}`);
}

export async function getLeagueRosters(leagueId) {
  return fetchJson(`/league/${assertNumericId('league_id', leagueId)}/rosters`);
}

export async function getLeagueUsers(leagueId) {
  return fetchJson(`/league/${assertNumericId('league_id', leagueId)}/users`);
}

export async function getLeagueDrafts(leagueId) {
  return fetchJson(`/league/${assertNumericId('league_id', leagueId)}/drafts`);
}

export async function getLeagueTradedPicks(leagueId) {
  return fetchJson(`/league/${assertNumericId('league_id', leagueId)}/traded_picks`);
}

export async function listLeagues({ season, username, includeRosterIds = true } = {}) {
  const [account, state] = await Promise.all([getAccount(username), getNflState()]);
  const selectedSeason = assertSeason(
    season ?? process.env.SLEEPER_DEFAULT_SEASON ?? state.league_season ?? state.season
  );
  const leagues = await fetchJson(
    `/user/${pathPart(account.user_id)}/leagues/nfl/${pathPart(selectedSeason)}`
  );

  let rosterIdByLeague = new Map();
  if (includeRosterIds && Array.isArray(leagues) && leagues.length > 0) {
    const entries = await Promise.all(
      leagues.map(async (league) => {
        try {
          const rosters = await getLeagueRosters(league.league_id);
          const mine = rosters.find(
            (roster) =>
              String(roster.owner_id) === String(account.user_id) ||
              asStringArray(roster.co_owners).includes(String(account.user_id))
          );
          return [String(league.league_id), mine?.roster_id ?? null];
        } catch {
          return [String(league.league_id), null];
        }
      })
    );
    rosterIdByLeague = new Map(entries);
  }

  return {
    account: compactAccount(account),
    season: selectedSeason,
    nfl_state: state,
    leagues: (leagues ?? []).map((league) => ({
      league_id: String(league.league_id),
      name: league.name,
      season: league.season,
      status: league.status,
      league_type: leagueType(league),
      total_rosters: league.total_rosters,
      my_roster_id: rosterIdByLeague.get(String(league.league_id)) ?? null,
      lineup: league.roster_positions ?? [],
      scoring_summary: scoringSummary(league),
      previous_league_id: league.previous_league_id ?? null,
      draft_id: league.draft_id ?? null
    }))
  };
}

function cacheDirectory() {
  return (
    String(process.env.SLEEPER_CACHE_DIR ?? '').trim() ||
    path.join(os.homedir(), '.cache', 'sleeper-fantasy-mcp')
  );
}

async function readPlayerCache(cacheFile, allowStale = false) {
  try {
    const stat = await fs.stat(cacheFile);
    if (!allowStale && Date.now() - stat.mtimeMs > PLAYER_CACHE_TTL_MS) return null;
    const raw = await fs.readFile(cacheFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getPlayersMap({ forceRefresh = false } = {}) {
  if (!forceRefresh && playersMemory && Date.now() - playersLoadedAt < PLAYER_CACHE_TTL_MS) {
    return playersMemory;
  }

  const dir = cacheDirectory();
  const cacheFile = path.join(dir, 'players-nfl.json');

  if (!forceRefresh) {
    const cached = await readPlayerCache(cacheFile);
    if (cached) {
      playersMemory = cached;
      playersLoadedAt = Date.now();
      return cached;
    }
  }

  try {
    const players = await fetchJson('/players/nfl', { retries: 1 });
    playersMemory = players ?? {};
    playersLoadedAt = Date.now();

    try {
      await fs.mkdir(dir, { recursive: true });
      const tempFile = `${cacheFile}.${process.pid}.tmp`;
      await fs.writeFile(tempFile, JSON.stringify(playersMemory), 'utf8');
      await fs.rename(tempFile, cacheFile);
    } catch (error) {
      console.error(`Sleeper MCP: could not write player cache: ${error.message}`);
    }

    return playersMemory;
  } catch (error) {
    const stale = await readPlayerCache(cacheFile, true);
    if (stale) {
      playersMemory = stale;
      playersLoadedAt = Date.now();
      console.error(`Sleeper MCP: using stale player cache because refresh failed: ${error.message}`);
      return stale;
    }
    throw error;
  }
}

export function compactAccount(account) {
  return {
    user_id: String(account.user_id),
    username: account.username ?? null,
    display_name: account.display_name ?? null
  };
}

export function leagueType(league) {
  const value = Number(league?.settings?.type);
  if (value === 2) return 'dynasty';
  if (value === 1) return 'keeper';
  return 'redraft';
}

export function scoringSummary(league) {
  const scoring = league?.scoring_settings ?? {};
  const lineup = league?.roster_positions ?? [];
  const ppr = Number(scoring.rec ?? 0);
  return {
    reception_scoring: ppr === 1 ? 'PPR' : ppr === 0.5 ? 'half-PPR' : `${ppr} PPR`,
    superflex: lineup.includes('SUPER_FLEX'),
    tight_end_premium:
      Number(scoring.bonus_rec_te ?? 0) > 0 || Number(scoring.rec_te ?? scoring.rec ?? 0) > ppr,
    passing_touchdown_points: Number(scoring.pass_td ?? 0),
    starters: lineup.filter((slot) => slot !== 'BN').length,
    bench_slots: lineup.filter((slot) => slot === 'BN').length
  };
}

function userView(user) {
  if (!user) return null;
  return {
    user_id: String(user.user_id),
    username: user.username ?? null,
    display_name: user.display_name ?? null,
    team_name: user.metadata?.team_name ?? null,
    is_commissioner: Boolean(user.is_owner)
  };
}

function rosterLabel(roster, usersById) {
  const user = usersById.get(String(roster.owner_id));
  return (
    user?.metadata?.team_name ||
    user?.display_name ||
    user?.username ||
    `Roster ${roster.roster_id}`
  );
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function pointsWithDecimal(base, decimal) {
  return Number(base ?? 0) + Number(decimal ?? 0) / 100;
}

export function resolvePlayer(playerId, playersMap) {
  const id = String(playerId);
  const player = playersMap?.[id];
  if (!player) {
    const looksLikeDefense = /^[A-Z]{2,3}$/.test(id);
    return {
      player_id: id,
      name: looksLikeDefense ? `${id} D/ST` : `Unknown player (${id})`,
      position: looksLikeDefense ? 'DEF' : null,
      fantasy_positions: looksLikeDefense ? ['DEF'] : [],
      team: looksLikeDefense ? id : null,
      status: null,
      injury_status: null,
      age: null,
      years_exp: null
    };
  }

  const name =
    player.full_name ||
    [player.first_name, player.last_name].filter(Boolean).join(' ') ||
    (/^[A-Z]{2,3}$/.test(id) ? `${id} D/ST` : `Player ${id}`);

  return {
    player_id: id,
    name,
    position: player.position ?? player.fantasy_positions?.[0] ?? null,
    fantasy_positions: player.fantasy_positions ?? [],
    team: player.team ?? null,
    number: player.number ?? null,
    status: player.status ?? null,
    active: player.active ?? null,
    injury_status: player.injury_status ?? null,
    practice_participation: player.practice_participation ?? null,
    depth_chart_order: player.depth_chart_order ?? null,
    age: player.age ?? null,
    years_exp: player.years_exp ?? null,
    rookie_year: player.years_exp === 0 ? true : undefined
  };
}

function resolveIds(ids, playersMap) {
  return (ids ?? []).filter(Boolean).map((id) => resolvePlayer(id, playersMap));
}

export function buildRosterView(roster, usersById, playersMap, league) {
  const allIds = asStringArray(roster.players);
  const starterIds = asStringArray(roster.starters);
  const reserveIds = asStringArray(roster.reserve);
  const taxiIds = asStringArray(roster.taxi);
  const keeperIds = asStringArray(roster.keepers);
  const excludedFromBench = new Set([...starterIds, ...reserveIds, ...taxiIds]);
  const benchIds = allIds.filter((id) => !excludedFromBench.has(id));
  const owner = usersById.get(String(roster.owner_id));
  const coOwners = asStringArray(roster.co_owners)
    .map((id) => usersById.get(id))
    .filter(Boolean)
    .map(userView);
  const budget = Number(league?.settings?.waiver_budget ?? 0);
  const used = Number(roster.settings?.waiver_budget_used ?? 0);

  return {
    roster_id: Number(roster.roster_id),
    label: rosterLabel(roster, usersById),
    owner: userView(owner),
    co_owners: coOwners,
    record: {
      wins: Number(roster.settings?.wins ?? 0),
      losses: Number(roster.settings?.losses ?? 0),
      ties: Number(roster.settings?.ties ?? 0),
      points_for: pointsWithDecimal(roster.settings?.fpts, roster.settings?.fpts_decimal),
      points_against: pointsWithDecimal(
        roster.settings?.fpts_against,
        roster.settings?.fpts_against_decimal
      ),
      waiver_position: roster.settings?.waiver_position ?? null,
      faab_used: used,
      faab_remaining: budget > 0 ? Math.max(0, budget - used) : null
    },
    lineup: {
      starters: resolveIds(starterIds, playersMap),
      bench: resolveIds(benchIds, playersMap),
      reserve: resolveIds(reserveIds, playersMap),
      taxi: resolveIds(taxiIds, playersMap),
      keepers: resolveIds(keeperIds, playersMap)
    }
  };
}

export async function getLeagueBundle(leagueId, { includePlayers = false } = {}) {
  const id = assertNumericId('league_id', leagueId);
  const [league, rosters, users, tradedPicks, drafts] = await Promise.all([
    getLeague(id),
    getLeagueRosters(id),
    getLeagueUsers(id),
    getLeagueTradedPicks(id),
    getLeagueDrafts(id)
  ]);
  const playersMap = includePlayers ? await getPlayersMap() : null;
  const usersById = new Map((users ?? []).map((user) => [String(user.user_id), user]));
  const rostersById = new Map((rosters ?? []).map((roster) => [Number(roster.roster_id), roster]));

  return {
    league,
    rosters: rosters ?? [],
    users: users ?? [],
    tradedPicks: tradedPicks ?? [],
    drafts: drafts ?? [],
    playersMap,
    usersById,
    rostersById
  };
}

function leagueView(league) {
  return {
    league_id: String(league.league_id),
    name: league.name,
    season: league.season,
    status: league.status,
    league_type: leagueType(league),
    total_rosters: league.total_rosters,
    roster_positions: league.roster_positions ?? [],
    scoring_settings: league.scoring_settings ?? {},
    settings: league.settings ?? {},
    previous_league_id: league.previous_league_id ?? null,
    draft_id: league.draft_id ?? null
  };
}

function draftView(draft) {
  return {
    draft_id: String(draft.draft_id),
    season: draft.season,
    status: draft.status,
    type: draft.type,
    start_time: draft.start_time ?? null,
    settings: draft.settings ?? {}
  };
}

function teamDirectory(rosters, usersById) {
  return rosters.map((roster) => ({
    roster_id: Number(roster.roster_id),
    label: rosterLabel(roster, usersById),
    owner: userView(usersById.get(String(roster.owner_id)))
  }));
}

function latestDraftForSeason(drafts, season) {
  return drafts.find((draft) => String(draft.season) === String(season)) ?? drafts[0] ?? null;
}

function draftRoundCount(league, drafts) {
  const currentDraft = latestDraftForSeason(drafts, league.season);
  const raw = Number(
    currentDraft?.settings?.rounds ?? drafts[0]?.settings?.rounds ?? league.settings?.draft_rounds ?? 4
  );
  return Math.max(1, Math.min(Number.isFinite(raw) ? raw : 4, 20));
}

export function buildPickInventory({ league, rosters, usersById, tradedPicks, drafts, years = 3 }) {
  const type = leagueType(league);
  const yearsToShow = Math.max(0, Math.min(Number(years ?? 3), 5));
  if (yearsToShow === 0) return [];

  const currentSeason = Number(league.season);
  const currentDraft = latestDraftForSeason(drafts, currentSeason);
  const firstSeason = currentDraft?.status === 'complete' ? currentSeason + 1 : currentSeason;
  const seasons = Array.from({ length: type === 'dynasty' ? yearsToShow : 1 }, (_, i) =>
    String(firstSeason + i)
  );
  const rounds = draftRoundCount(league, drafts);
  const currentOwnerByKey = new Map();

  for (const pick of tradedPicks ?? []) {
    const key = `${pick.season}:${pick.round}:${pick.roster_id}`;
    currentOwnerByKey.set(key, Number(pick.owner_id));
  }

  const grouped = new Map(
    rosters.map((roster) => [
      Number(roster.roster_id),
      {
        roster_id: Number(roster.roster_id),
        label: rosterLabel(roster, usersById),
        picks: []
      }
    ])
  );

  for (const season of seasons) {
    for (let round = 1; round <= rounds; round += 1) {
      for (const originalRoster of rosters) {
        const originalId = Number(originalRoster.roster_id);
        const key = `${season}:${round}:${originalId}`;
        const ownerId = currentOwnerByKey.get(key) ?? originalId;
        if (!grouped.has(ownerId)) continue;
        grouped.get(ownerId).picks.push({
          season,
          round,
          original_roster_id: originalId,
          original_team: rosterLabel(originalRoster, usersById),
          acquired: ownerId !== originalId
        });
      }
    }
  }

  return [...grouped.values()];
}

function enrichedTradedPicks(tradedPicks, rostersById, usersById) {
  return (tradedPicks ?? []).map((pick) => {
    const original = rostersById.get(Number(pick.roster_id));
    const previous = rostersById.get(Number(pick.previous_owner_id));
    const current = rostersById.get(Number(pick.owner_id));
    return {
      season: String(pick.season),
      round: Number(pick.round),
      original_roster_id: Number(pick.roster_id),
      original_team: original ? rosterLabel(original, usersById) : null,
      previous_owner_roster_id: Number(pick.previous_owner_id),
      previous_owner_team: previous ? rosterLabel(previous, usersById) : null,
      current_owner_roster_id: Number(pick.owner_id),
      current_owner_team: current ? rosterLabel(current, usersById) : null
    };
  });
}

export async function getLeagueOverview({ leagueId, username, pickYears = 3 }) {
  const [account, state, bundle] = await Promise.all([
    getAccount(username),
    getNflState(),
    getLeagueBundle(leagueId)
  ]);
  const mine = bundle.rosters.find(
    (roster) =>
      String(roster.owner_id) === String(account.user_id) ||
      asStringArray(roster.co_owners).includes(String(account.user_id))
  );

  return {
    account: compactAccount(account),
    nfl_state: state,
    league: leagueView(bundle.league),
    my_roster_id: mine?.roster_id ?? null,
    teams: bundle.rosters.map((roster) => ({
      roster_id: Number(roster.roster_id),
      label: rosterLabel(roster, bundle.usersById),
      owner: userView(bundle.usersById.get(String(roster.owner_id))),
      record: {
        wins: Number(roster.settings?.wins ?? 0),
        losses: Number(roster.settings?.losses ?? 0),
        ties: Number(roster.settings?.ties ?? 0),
        points_for: pointsWithDecimal(roster.settings?.fpts, roster.settings?.fpts_decimal),
        points_against: pointsWithDecimal(
          roster.settings?.fpts_against,
          roster.settings?.fpts_against_decimal
        )
      }
    })),
    drafts: bundle.drafts.map(draftView),
    traded_picks: enrichedTradedPicks(
      bundle.tradedPicks,
      bundle.rostersById,
      bundle.usersById
    ),
    pick_inventory: buildPickInventory({
      league: bundle.league,
      rosters: bundle.rosters,
      usersById: bundle.usersById,
      tradedPicks: bundle.tradedPicks,
      drafts: bundle.drafts,
      years: pickYears
    })
  };
}

export async function getAllRosters({ leagueId }) {
  const bundle = await getLeagueBundle(leagueId, { includePlayers: true });
  return {
    league: {
      league_id: String(bundle.league.league_id),
      name: bundle.league.name,
      season: bundle.league.season,
      league_type: leagueType(bundle.league),
      roster_positions: bundle.league.roster_positions ?? [],
      scoring_settings: bundle.league.scoring_settings ?? {}
    },
    teams: bundle.rosters.map((roster) =>
      buildRosterView(roster, bundle.usersById, bundle.playersMap, bundle.league)
    )
  };
}

export async function getMyRoster({ leagueId, username }) {
  const [account, bundle] = await Promise.all([
    getAccount(username),
    getLeagueBundle(leagueId, { includePlayers: true })
  ]);
  const roster = bundle.rosters.find(
    (candidate) =>
      String(candidate.owner_id) === String(account.user_id) ||
      asStringArray(candidate.co_owners).includes(String(account.user_id))
  );

  if (!roster) {
    throw new Error(
      `Sleeper user ${account.username ?? account.user_id} does not own or co-own a roster in this league.`
    );
  }

  const inventory = buildPickInventory({
    league: bundle.league,
    rosters: bundle.rosters,
    usersById: bundle.usersById,
    tradedPicks: bundle.tradedPicks,
    drafts: bundle.drafts,
    years: 4
  }).find((entry) => entry.roster_id === Number(roster.roster_id));

  return {
    account: compactAccount(account),
    league: {
      league_id: String(bundle.league.league_id),
      name: bundle.league.name,
      season: bundle.league.season,
      league_type: leagueType(bundle.league),
      roster_positions: bundle.league.roster_positions ?? [],
      scoring_settings: bundle.league.scoring_settings ?? {},
      settings: bundle.league.settings ?? {}
    },
    roster: buildRosterView(roster, bundle.usersById, bundle.playersMap, bundle.league),
    draft_picks: inventory?.picks ?? []
  };
}

function normalizeSearch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function rosterSearchText(roster, usersById) {
  const user = usersById.get(String(roster.owner_id));
  return normalizeSearch(
    [
      roster.roster_id,
      user?.username,
      user?.display_name,
      user?.metadata?.team_name,
      roster.metadata?.team_name
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function selectRosters(teamQueries, rosters, usersById) {
  if (!teamQueries?.length) return { rosters: [], unmatched: [] };
  const selected = new Map();
  const unmatched = [];

  for (const rawQuery of teamQueries) {
    const query = normalizeSearch(rawQuery);
    if (!query) continue;
    const exactId = /^\d+$/.test(query) ? Number(query) : null;
    const matches = rosters.filter((roster) => {
      if (exactId !== null) return Number(roster.roster_id) === exactId;
      return rosterSearchText(roster, usersById).includes(query);
    });

    if (matches.length === 0) unmatched.push(String(rawQuery));
    for (const roster of matches) selected.set(Number(roster.roster_id), roster);
  }

  return { rosters: [...selected.values()], unmatched };
}

export async function getTradeContext({ leagueId, teamQueries = [], username, pickYears = 4 }) {
  const [account, bundle] = await Promise.all([
    getAccount(username),
    getLeagueBundle(leagueId, { includePlayers: true })
  ]);
  const selectedResult = selectRosters(teamQueries, bundle.rosters, bundle.usersById);
  let selected = selectedResult.rosters;

  if (selected.length === 0 && teamQueries.length === 0) {
    selected = bundle.rosters.filter(
      (roster) =>
        String(roster.owner_id) === String(account.user_id) ||
        asStringArray(roster.co_owners).includes(String(account.user_id))
    );
  }

  if (selected.length === 0) {
    throw new Error(
      `No teams matched: ${teamQueries.join(', ')}. Call sleeper_league_overview to see roster IDs and team labels.`
    );
  }

  const selectedIds = new Set(selected.map((roster) => Number(roster.roster_id)));
  const inventories = buildPickInventory({
    league: bundle.league,
    rosters: bundle.rosters,
    usersById: bundle.usersById,
    tradedPicks: bundle.tradedPicks,
    drafts: bundle.drafts,
    years: pickYears
  }).filter((entry) => selectedIds.has(entry.roster_id));

  return {
    league: leagueView(bundle.league),
    team_directory: teamDirectory(bundle.rosters, bundle.usersById),
    selected_teams: selected.map((roster) =>
      buildRosterView(roster, bundle.usersById, bundle.playersMap, bundle.league)
    ),
    selected_pick_inventories: inventories,
    unmatched_team_queries: selectedResult.unmatched,
    note:
      'The official Sleeper API does not expose a private inbox of unaccepted trade proposals. Paste or describe the offer; this context supplies the live rosters, rules, records, and pick ownership.'
  };
}

function rosterIdLabel(id, rostersById, usersById) {
  const roster = rostersById.get(Number(id));
  return roster ? rosterLabel(roster, usersById) : `Roster ${id}`;
}

function enrichTransaction(transaction, playersMap, rostersById, usersById) {
  const rosterIds = (transaction.roster_ids ?? []).map(Number);
  const byRoster = new Map(
    rosterIds.map((rosterId) => [
      rosterId,
      {
        roster_id: rosterId,
        team: rosterIdLabel(rosterId, rostersById, usersById),
        received_players: [],
        sent_players: [],
        received_picks: [],
        sent_picks: [],
        faab_received: 0,
        faab_sent: 0
      }
    ])
  );

  for (const [playerId, rosterIdRaw] of Object.entries(transaction.adds ?? {})) {
    const rosterId = Number(rosterIdRaw);
    if (!byRoster.has(rosterId)) {
      byRoster.set(rosterId, {
        roster_id: rosterId,
        team: rosterIdLabel(rosterId, rostersById, usersById),
        received_players: [],
        sent_players: [],
        received_picks: [],
        sent_picks: [],
        faab_received: 0,
        faab_sent: 0
      });
    }
    byRoster.get(rosterId).received_players.push(resolvePlayer(playerId, playersMap));
  }

  for (const [playerId, rosterIdRaw] of Object.entries(transaction.drops ?? {})) {
    const rosterId = Number(rosterIdRaw);
    if (!byRoster.has(rosterId)) {
      byRoster.set(rosterId, {
        roster_id: rosterId,
        team: rosterIdLabel(rosterId, rostersById, usersById),
        received_players: [],
        sent_players: [],
        received_picks: [],
        sent_picks: [],
        faab_received: 0,
        faab_sent: 0
      });
    }
    byRoster.get(rosterId).sent_players.push(resolvePlayer(playerId, playersMap));
  }

  for (const pick of transaction.draft_picks ?? []) {
    const compactPick = {
      season: String(pick.season),
      round: Number(pick.round),
      original_roster_id: Number(pick.roster_id),
      original_team: rosterIdLabel(pick.roster_id, rostersById, usersById)
    };
    const receiver = Number(pick.owner_id);
    const sender = Number(pick.previous_owner_id);
    if (byRoster.has(receiver)) byRoster.get(receiver).received_picks.push(compactPick);
    if (byRoster.has(sender)) byRoster.get(sender).sent_picks.push(compactPick);
  }

  for (const budget of transaction.waiver_budget ?? []) {
    const sender = Number(budget.sender);
    const receiver = Number(budget.receiver);
    const amount = Number(budget.amount ?? 0);
    if (byRoster.has(sender)) byRoster.get(sender).faab_sent += amount;
    if (byRoster.has(receiver)) byRoster.get(receiver).faab_received += amount;
  }

  return {
    transaction_id: String(transaction.transaction_id),
    type: transaction.type,
    status: transaction.status,
    week: transaction.leg ?? null,
    created_at: transaction.created ? new Date(transaction.created).toISOString() : null,
    status_updated_at: transaction.status_updated
      ? new Date(transaction.status_updated).toISOString()
      : null,
    creator_user_id: transaction.creator ? String(transaction.creator) : null,
    waiver_bid: transaction.settings?.waiver_bid ?? null,
    teams: [...byRoster.values()]
  };
}

export async function getTransactions({
  leagueId,
  startWeek,
  endWeek,
  types,
  status
}) {
  const id = assertNumericId('league_id', leagueId);
  const [state, bundle] = await Promise.all([
    getNflState(),
    getLeagueBundle(id, { includePlayers: true })
  ]);
  const defaultEnd = Number(state.leg ?? state.display_week ?? state.week ?? 1);
  const from = Number.isInteger(startWeek) ? startWeek : Math.max(0, defaultEnd - 3);
  const to = Number.isInteger(endWeek) ? endWeek : defaultEnd;

  if (from < 0 || to > 18 || from > to || to - from > 18) {
    throw new Error('Transaction week range must be between 0 and 18, with start_week <= end_week.');
  }

  const weeks = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const responses = await Promise.all(
    weeks.map(async (week) => ({
      week,
      transactions: await fetchJson(`/league/${id}/transactions/${week}`)
    }))
  );
  const allowedTypes = types?.length ? new Set(types) : null;
  const seen = new Set();
  const transactions = [];

  for (const response of responses) {
    for (const transaction of response.transactions ?? []) {
      if (seen.has(String(transaction.transaction_id))) continue;
      seen.add(String(transaction.transaction_id));
      if (allowedTypes && !allowedTypes.has(transaction.type)) continue;
      if (status && transaction.status !== status) continue;
      transactions.push(
        enrichTransaction(
          transaction,
          bundle.playersMap,
          bundle.rostersById,
          bundle.usersById
        )
      );
    }
  }

  transactions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return {
    league: {
      league_id: String(bundle.league.league_id),
      name: bundle.league.name,
      season: bundle.league.season
    },
    requested_weeks: weeks,
    transactions
  };
}

function startingSlots(league) {
  return (league.roster_positions ?? []).filter((slot) => slot !== 'BN');
}

function matchupTeamView(matchup, bundle) {
  const roster = bundle.rostersById.get(Number(matchup.roster_id));
  const slots = startingSlots(bundle.league);
  const matchupStarters = asStringArray(matchup.starters);
  const matchupPlayers = asStringArray(matchup.players);
  const starters = matchupStarters.map((playerId, index) => ({
    slot: slots[index] ?? `STARTER_${index + 1}`,
    player: resolvePlayer(playerId, bundle.playersMap),
    points: matchup.starters_points?.[playerId] ?? null
  }));
  const starterSet = new Set(matchupStarters);
  const bench = matchupPlayers
    .filter((id) => !starterSet.has(id))
    .map((id) => resolvePlayer(id, bundle.playersMap));

  return {
    roster_id: Number(matchup.roster_id),
    team: roster ? rosterLabel(roster, bundle.usersById) : `Roster ${matchup.roster_id}`,
    matchup_id: matchup.matchup_id ?? null,
    points: matchup.points ?? null,
    custom_points: matchup.custom_points ?? null,
    starters,
    bench
  };
}

export async function getMatchups({ leagueId, week }) {
  const id = assertNumericId('league_id', leagueId);
  const [state, bundle] = await Promise.all([
    getNflState(),
    getLeagueBundle(id, { includePlayers: true })
  ]);
  const selectedWeek = Number.isInteger(week)
    ? week
    : Number(state.display_week ?? state.week ?? state.leg ?? 1);
  if (selectedWeek < 0 || selectedWeek > 18) {
    throw new Error('week must be between 0 and 18.');
  }

  const raw = await fetchJson(`/league/${id}/matchups/${selectedWeek}`);
  const teams = (raw ?? []).map((matchup) => matchupTeamView(matchup, bundle));
  const grouped = new Map();
  for (const team of teams) {
    const key = team.matchup_id === null ? `none-${team.roster_id}` : String(team.matchup_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(team);
  }

  return {
    league: {
      league_id: String(bundle.league.league_id),
      name: bundle.league.name,
      season: bundle.league.season
    },
    week: selectedWeek,
    matchups: [...grouped.values()]
  };
}

export async function getDraftBoard({ leagueId, draftId, draftSeason }) {
  let draft;
  let bundle = null;

  if (leagueId) {
    bundle = await getLeagueBundle(leagueId, { includePlayers: true });
  }

  if (draftId) {
    const id = assertNumericId('draft_id', draftId);
    draft = await fetchJson(`/draft/${id}`);
  } else if (bundle) {
    const selectedSeason = draftSeason ? assertSeason(draftSeason) : null;
    draft = selectedSeason
      ? bundle.drafts.find((candidate) => String(candidate.season) === selectedSeason)
      : bundle.drafts[0];
  } else {
    throw new Error('Provide league_id or draft_id.');
  }

  if (!draft) {
    throw new Error(`No draft was found${draftSeason ? ` for season ${draftSeason}` : ''}.`);
  }

  const id = assertNumericId('draft_id', draft.draft_id);
  const [picks, tradedPicks] = await Promise.all([
    fetchJson(`/draft/${id}/picks`),
    fetchJson(`/draft/${id}/traded_picks`)
  ]);
  const playersMap = bundle?.playersMap ?? (await getPlayersMap());
  let usersById = bundle?.usersById ?? new Map();
  let rostersById = bundle?.rostersById ?? new Map();

  if (!bundle && draft.league_id) {
    try {
      const leagueBundle = await getLeagueBundle(draft.league_id);
      usersById = leagueBundle.usersById;
      rostersById = leagueBundle.rostersById;
    } catch {
      // Draft metadata still provides enough information to return the board.
    }
  }

  const resolvedPicks = (picks ?? [])
    .map((pick) => ({
      pick_no: Number(pick.pick_no),
      round: Number(pick.round),
      draft_slot: Number(pick.draft_slot),
      roster_id: pick.roster_id !== undefined ? Number(pick.roster_id) : null,
      team:
        pick.roster_id !== undefined
          ? rosterIdLabel(pick.roster_id, rostersById, usersById)
          : null,
      picked_by_user_id: pick.picked_by ? String(pick.picked_by) : null,
      player:
        pick.player_id || pick.metadata?.player_id
          ? resolvePlayer(pick.player_id ?? pick.metadata.player_id, playersMap)
          : null,
      is_keeper: pick.is_keeper ?? null
    }))
    .sort((a, b) => a.pick_no - b.pick_no);

  return {
    draft: draftView(draft),
    draft_order: draft.draft_order ?? null,
    slot_to_roster_id: draft.slot_to_roster_id ?? null,
    picks: resolvedPicks,
    traded_picks: (tradedPicks ?? []).map((pick) => ({
      season: String(pick.season),
      round: Number(pick.round),
      original_roster_id: Number(pick.roster_id),
      original_team: rosterIdLabel(pick.roster_id, rostersById, usersById),
      current_owner_roster_id: Number(pick.owner_id),
      current_owner_team: rosterIdLabel(pick.owner_id, rostersById, usersById)
    }))
  };
}

function playerSearchScore(player, query) {
  const name = normalizeSearch(
    player.full_name || [player.first_name, player.last_name].filter(Boolean).join(' ')
  );
  if (!name) return 100;
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(' ').some((part) => part.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  return 100;
}

export async function searchPlayers({ query, position, activeOnly = true, limit = 20 }) {
  const normalized = normalizeSearch(query);
  if (!normalized) throw new Error('query cannot be empty.');
  const playersMap = await getPlayersMap();
  const matches = [];

  for (const [playerId, player] of Object.entries(playersMap)) {
    const score = playerSearchScore(player, normalized);
    if (score >= 100) continue;
    const positions = player.fantasy_positions ?? (player.position ? [player.position] : []);
    if (position && !positions.includes(position)) continue;
    if (activeOnly && player.active === false) continue;
    matches.push({
      score,
      search_rank: Number(player.search_rank ?? 99_999),
      player: resolvePlayer(playerId, playersMap)
    });
  }

  matches.sort((a, b) => a.score - b.score || a.search_rank - b.search_rank);
  return {
    query,
    results: matches.slice(0, Math.max(1, Math.min(limit, 50))).map((match) => match.player)
  };
}

export async function getTrendingPlayers({ type = 'add', lookbackHours = 24, limit = 25 }) {
  const selectedType = type === 'drop' ? 'drop' : 'add';
  const hours = Math.max(1, Math.min(Number(lookbackHours), 168));
  const selectedLimit = Math.max(1, Math.min(Number(limit), 100));
  const [trending, playersMap] = await Promise.all([
    fetchJson(
      `/players/nfl/trending/${selectedType}?lookback_hours=${hours}&limit=${selectedLimit}`
    ),
    getPlayersMap()
  ]);

  return {
    type: selectedType,
    lookback_hours: hours,
    players: (trending ?? []).map((item) => ({
      ...resolvePlayer(item.player_id, playersMap),
      activity_count: Number(item.count ?? 0)
    }))
  };
}
