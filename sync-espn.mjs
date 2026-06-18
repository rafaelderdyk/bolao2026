// =====================================================================
// sync-espn.mjs
// Busca os placares da Copa 2026 no openfootball (gratuito, sem chave)
// e grava direto na tabela `bolao_results` do Supabase via REST.
//
// Variáveis de ambiente necessárias (Secrets no GitHub):
//   SUPABASE_URL  -> ex: https://atrobbmjmtzulvqcwqch.supabase.co
//   SUPABASE_KEY  -> chave anon/publishable do Supabase
//
// Roda com: node scripts/sync-espn.mjs
// =====================================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Faltam variáveis de ambiente: SUPABASE_URL e/ou SUPABASE_KEY.');
  process.exit(1);
}

const SOURCE_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

// Lê o fixtures.json da raiz do repositório
const FIXTURES = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures.json'), 'utf8'));

// Mapeamento nomes em português → nomes usados pelo openfootball
const TEAM_ALIASES = {
  'México':          ['Mexico'],
  'África do Sul':   ['South Africa'],
  'Coreia do Sul':   ['South Korea', 'Korea Republic'],
  'Chéquia':         ['Czech Republic', 'Czechia'],
  'Canadá':          ['Canada'],
  'Bósnia':          ['Bosnia & Herzegovina', 'Bosnia and Herzegovina', 'Bosnia-Herzegovina'],
  'Catar':           ['Qatar'],
  'Suíça':           ['Switzerland'],
  'Brasil':          ['Brazil'],
  'Marrocos':        ['Morocco'],
  'Haiti':           ['Haiti'],
  'Escócia':         ['Scotland'],
  'EUA':             ['United States', 'USA'],
  'Paraguai':        ['Paraguay'],
  'Austrália':       ['Australia'],
  'Turquia':         ['Turkey', 'Türkiye', 'Turkiye'],
  'Alemanha':        ['Germany'],
  'Curaçao':         ['Curacao'],
  'Costa do Marfim': ['Ivory Coast', "Cote d'Ivoire", "Côte d'Ivoire"],
  'Equador':         ['Ecuador'],
  'Holanda':         ['Netherlands'],
  'Japão':           ['Japan'],
  'Suécia':          ['Sweden'],
  'Tunísia':         ['Tunisia'],
  'Bélgica':         ['Belgium'],
  'Egito':           ['Egypt'],
  'Irã':             ['Iran', 'IR Iran'],
  'Nova Zelândia':   ['New Zealand'],
  'Espanha':         ['Spain'],
  'Cabo Verde':      ['Cape Verde'],
  'Arábia Saudita':  ['Saudi Arabia'],
  'Uruguai':         ['Uruguay'],
  'França':          ['France'],
  'Senegal':         ['Senegal'],
  'Iraque':          ['Iraq'],
  'Noruega':         ['Norway'],
  'Argentina':       ['Argentina'],
  'Argélia':         ['Algeria'],
  'Áustria':         ['Austria'],
  'Jordânia':        ['Jordan'],
  'Portugal':        ['Portugal'],
  'RD Congo':        ['DR Congo', 'Congo DR'],
  'Uzbequistão':     ['Uzbekistan'],
  'Colômbia':        ['Colombia'],
  'Inglaterra':      ['England'],
  'Croácia':         ['Croatia'],
  'Gana':            ['Ghana'],
  'Panamá':          ['Panama'],
};

const norm = (s = '') =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');

function teamMatches(fixtureName, apiName) {
  const target  = norm(apiName);
  const aliases = (TEAM_ALIASES[fixtureName] || [fixtureName]).map(norm);
  return aliases.includes(target) || norm(fixtureName) === target;
}

function findApiMatch(fix, apiMatches) {
  return apiMatches.find(m => {
    const t1 = m.team1 || '';
    const t2 = m.team2 || '';
    return (
      (teamMatches(fix.home, t1) && teamMatches(fix.away, t2)) ||
      (teamMatches(fix.home, t2) && teamMatches(fix.away, t1))
    );
  });
}

async function fetchMatches() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`openfootball respondeu ${res.status}`);
  const data = await res.json();
  return data.matches || [];
}

async function getCurrentResults() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bolao_results?id=eq.1&select=*`, {
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Falha ao ler Supabase: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function saveMatches(matches) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bolao_results?id=eq.1`, {
    method:  'PATCH',
    headers: {
      apikey:         SUPABASE_KEY,
      Authorization:  `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify({
      matches,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Falha ao salvar no Supabase: ${res.status} ${await res.text()}`);
}

async function main() {
  console.log('🔄 Iniciando sync openfootball → Supabase...');

  const apiMatches = await fetchMatches();
  console.log(`📡 openfootball: ${apiMatches.length} jogos encontrados.`);

  const current = await getCurrentResults();
  const matches = { ...(current?.matches || {}) };

  let updated   = 0;
  const unmatched = [];

  for (const fix of FIXTURES) {
    const apiMatch = findApiMatch(fix, apiMatches);
    if (!apiMatch) { unmatched.push(fix.id); continue; }

    // Só processa se tiver placar final (ft = full time)
    const ft = apiMatch.score?.ft;
    if (!ft || ft.length < 2) continue;

    // Garante a ordem correta home/away
    let homeScore, awayScore;
    if (teamMatches(fix.home, apiMatch.team1)) {
      homeScore = String(ft[0]);
      awayScore = String(ft[1]);
    } else {
      homeScore = String(ft[1]);
      awayScore = String(ft[0]);
    }

    const cur = matches[fix.id] || {};
    if (cur.home !== homeScore || cur.away !== awayScore) {
      matches[fix.id] = { home: homeScore, away: awayScore };
      updated++;
      console.log(`  ${fix.id}: ${fix.home} ${homeScore}×${awayScore} ${fix.away} ✅`);
    }
  }

  if (updated > 0) {
    await saveMatches(matches);
    console.log(`✅ ${updated} jogo(s) atualizado(s) no Supabase.`);
  } else {
    console.log('✔️  Nenhuma mudança. Supabase já está atualizado.');
  }

  if (unmatched.length) {
    console.log(`⚠️  ${unmatched.length} jogo(s) sem correspondência: ${unmatched.join(', ')}`);
  }
}

main().catch(err => {
  console.error('❌ Erro no sync:', err.message);
  process.exit(1);
});
