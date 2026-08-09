import test from 'node:test';
import assert from 'node:assert/strict';

import { leagueType, resolvePlayer, scoringSummary } from '../src/sleeper-client.js';

test('leagueType maps Sleeper type settings', () => {
  assert.equal(leagueType({ settings: { type: 0 } }), 'redraft');
  assert.equal(leagueType({ settings: { type: 1 } }), 'keeper');
  assert.equal(leagueType({ settings: { type: 2 } }), 'dynasty');
});

test('scoringSummary identifies common fantasy formats', () => {
  const result = scoringSummary({
    roster_positions: ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'BN', 'BN'],
    scoring_settings: {
      rec: 0.5,
      pass_td: 6,
      bonus_rec_te: 0.5
    }
  });

  assert.deepEqual(result, {
    reception_scoring: 'half-PPR',
    superflex: true,
    tight_end_premium: true,
    passing_touchdown_points: 6,
    starters: 6,
    bench_slots: 2
  });
});

test('resolvePlayer returns a compact player view', () => {
  const result = resolvePlayer('123', {
    123: {
      full_name: 'Example Player',
      position: 'WR',
      fantasy_positions: ['WR'],
      team: 'NYJ',
      active: true,
      age: 24,
      years_exp: 2
    }
  });

  assert.equal(result.player_id, '123');
  assert.equal(result.name, 'Example Player');
  assert.equal(result.position, 'WR');
  assert.equal(result.team, 'NYJ');
  assert.equal(result.active, true);
});

test('resolvePlayer recognizes defense IDs without directory data', () => {
  const result = resolvePlayer('NYJ', {});
  assert.equal(result.name, 'NYJ D/ST');
  assert.equal(result.position, 'DEF');
  assert.deepEqual(result.fantasy_positions, ['DEF']);
});
