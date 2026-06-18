// =====================================================================
// sync-espn.mjs
// Busca os placares da Copa 2026 na API-Football e grava no Supabase.
//
// Variáveis de ambiente necessárias (Secrets no GitHub):
//   SUPABASE_URL       -> https://atrobbmjmtzulvqcwqch.supabase.co
//   SUPABASE_KEY       -> chave anon/publishable do Supabase
//   API_FOOTBALL_KEY   -> chave da API-Football (dashboard.api-football.com)
//
// Roda com: node scripts/sync-espn.mjs
// =====================================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !API_FOOTBALL_KEY) {
  console.error('❌ Faltam variáveis de ambiente: SUPABASE_URL, SUPABASE_KEY e/ou API_FOOTBALL_KEY.');
  process.exit(1);
}

// Liga da Copa do Mundo 2026 na API-Football
const WC_LEAGUE  = 1;
const WC_SEASON  = 2026;

// Lê o fixtures.json (lista dos 72 jogos da fase de grupos)
const FIXTURES = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures.json'), 'utf8'));

// Mapeamento dos nomes em português → nomes usados pela API-Football
const TEAM_ALIASES = {
  'México':          ['Mexico'],
  'África do Sul':   ['South Africa'],
  'Coreia do Sul':   ['South Korea', 'Korea Republic', 'Korea South'],
  'Chéquia':         ['Czech Republic', 'Czechia'],
  'Canadá':          ['Canada'],
  'Bósnia':          ['Bosnia', 'Bosnia and Herzegovina', 'Bosnia-Herzegovina'],
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

// ---- Busca todos os jogos da Copa 2026 na API-Football ----
async function fetchFixtures() {
  const url = `https://v3.football.api-sports.io/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}`;
  const res = await fetch(url, {
    headers: {
      'x-apisports-key': API_FOOTBALL_KEY,
    },
  });
  if (!res.ok) throw new Error(`API-Football respondeu ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`Erro da API-Football: ${JSON.stringify(data.errors)}`);
  }
  console.log(`📡 API-Football: ${data.results} jogos retornados.`);
  return data.response || [];
}

// ---- Lê resultados atuais do Supabase ----
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

// ---- Salva resultados atualizados no Supabase ----
async function saveMatches(matches) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bolao_results?id=eq.1`, {
    method:  'PATCH',
    headers: {
      apikey:          SUPABASE_KEY,
      Authorization:   `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      Prefer:          'return=minimal',
    },
    body: JSON.stringify({
      matches,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Falha ao salvar no Supabase: ${res.status} ${await res.text()}`);
}

// ---- Encontra o jogo da API-Football correspondente a um fixture ----
function findApiFixture(fix, apiFixtures) {
  return apiFixtures.find(f => {
    const home = f?.teams?.home?.name || '';
    const away = f?.teams?.away?.name || '';
    return (
      (teamMatches(fix.home, home) && teamMatches(fix.away, away)) ||
      (teamMatches(fix.home, away) && teamMatches(fix.away, home))
    );
  });
}

// ---- Main ----
async function main() {
  console.log('🔄 Iniciando sync API-Football → Supabase...');

  const apiFixtures = await fetchFixtures();
  const current     = await getCurrentResults();
  const matches     = { ...(current?.matches || {}) };

  let updated   = 0;
  let finished  = 0;
  const unmatched = [];

  for (const fix of FIXTURES) {
    const apiFix = findApiFixture(fix, apiFixtures);
    if (!apiFix) {
      unmatched.push(fix.id);
      continue;
    }

    const status    = apiFix.fixture?.status?.short || '';
    const isFinal   = status === 'FT' || status === 'AET' || status === 'PEN';
    const isLive    = ['1H','HT','2H','ET','BT','P','SUSP','INT','LIVE'].includes(status);
    const hasScore  = isFinal || isLive;

    if (!hasScore) continue; // jogo ainda não começou

    // Garante a ordem home/away correta (pode vir invertido na API)
    let homeScore, awayScore;
    const apiHome = apiFix.teams?.home?.name || '';
    if (teamMatches(fix.home, apiHome)) {
      homeScore = String(apiFix.goals?.home ?? '');
      awayScore = String(apiFix.goals?.away ?? '');
    } else {
      homeScore = String(apiFix.goals?.away ?? '');
      awayScore = String(apiFix.goals?.home ?? '');
    }

    if (homeScore === '' || awayScore === '') continue;

    const cur = matches[fix.id] || {};
    if (cur.home !== homeScore || cur.away !== awayScore) {
      matches[fix.id] = { home: homeScore, away: awayScore };
      updated++;
      if (isFinal) finished++;
      console.log(`  ${fix.id}: ${fix.home} ${homeScore}×${awayScore} ${fix.away}${isFinal ? ' ✅ FINAL' : ' 🔴 ao vivo'}`);
    }
  }

  if (updated > 0) {
    await saveMatches(matches);
    console.log(`✅ ${updated} jogo(s) atualizado(s) no Supabase (${finished} finalizado(s)).`);
  } else {
    console.log('✔️  Nenhuma mudança de placar. Supabase já está atualizado.');
  }

  if (unmatched.length) {
    console.log(`⚠️  ${unmatched.length} jogo(s) sem correspondência na API: ${unmatched.join(', ')}`);
  }
}

main().catch(err => {
  console.error('❌ Erro no sync:', err.message);
  process.exit(1);
});
