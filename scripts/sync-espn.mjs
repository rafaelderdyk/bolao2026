// =====================================================================
// sync-espn.mjs
// Busca os placares da fase de grupos na ESPN (API pública, gratuita)
// e grava direto na tabela `bolao_results` do Supabase via REST.
//
// Variáveis de ambiente necessárias (configuradas como Secrets no GitHub):
//   SUPABASE_URL          -> ex: https://atrobbmjmtzulvqcwqch.supabase.co
//   SUPABASE_SERVICE_KEY  -> a SERVICE ROLE KEY (NUNCA a publishable/anon)
//
// Roda com: node scripts/sync-espn.mjs
// =====================================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltam as variáveis de ambiente SUPABASE_URL e/ou SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const FIXTURES = JSON.parse(readFileSync(join(__dirname, 'fixtures.json'), 'utf8'));

// Mesmo mapeamento usado no app (index.html)
const ESPN_TEAM_ALIASES = {
  'México': ['Mexico'],
  'África do Sul': ['South Africa'],
  'Coreia do Sul': ['South Korea', 'Korea Republic'],
  'Chéquia': ['Czech Republic', 'Czechia'],
  'Canadá': ['Canada'],
  'Bósnia': ['Bosnia and Herzegovina', 'Bosnia-Herzegovina', 'Bosnia & Herzegovina'],
  'Catar': ['Qatar'],
  'Suíça': ['Switzerland'],
  'Brasil': ['Brazil'],
  'Marrocos': ['Morocco'],
  'Haiti': ['Haiti'],
  'Escócia': ['Scotland'],
  'EUA': ['United States', 'USA'],
  'Paraguai': ['Paraguay'],
  'Austrália': ['Australia'],
  'Turquia': ['Turkey', 'Türkiye', 'Turkiye'],
  'Alemanha': ['Germany'],
  'Curaçao': ['Curacao', 'Curaçao'],
  'Costa do Marfim': ['Ivory Coast', "Cote d'Ivoire", 'Côte d’Ivoire', "Côte d'Ivoire"],
  'Equador': ['Ecuador'],
  'Holanda': ['Netherlands'],
  'Japão': ['Japan'],
  'Suécia': ['Sweden'],
  'Tunísia': ['Tunisia'],
  'Bélgica': ['Belgium'],
  'Egito': ['Egypt'],
  'Irã': ['Iran', 'IR Iran'],
  'Nova Zelândia': ['New Zealand'],
  'Espanha': ['Spain'],
  'Cabo Verde': ['Cape Verde', 'Cabo Verde'],
  'Arábia Saudita': ['Saudi Arabia'],
  'Uruguai': ['Uruguay'],
  'França': ['France'],
  'Senegal': ['Senegal'],
  'Iraque': ['Iraq'],
  'Noruega': ['Norway'],
  'Argentina': ['Argentina'],
  'Argélia': ['Algeria'],
  'Áustria': ['Austria'],
  'Jordânia': ['Jordan'],
  'Portugal': ['Portugal'],
  'RD Congo': ['DR Congo', 'Congo DR', 'DR Congo (Zaire)'],
  'Uzbequistão': ['Uzbekistan'],
  'Colômbia': ['Colombia'],
  'Inglaterra': ['England'],
  'Croácia': ['Croatia'],
  'Gana': ['Ghana'],
  'Panamá': ['Panama'],
};

const espnNorm = (s = '') =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');

const espnTeamMatches = (fixtureTeamName, espnTeamName) => {
  const target = espnNorm(espnTeamName);
  const aliases = (ESPN_TEAM_ALIASES[fixtureTeamName] || [fixtureTeamName]).map(espnNorm);
  return aliases.includes(target);
};

function findEspnEvent(fix, events) {
  return events.find(ev => {
    const competitors = ev?.competitions?.[0]?.competitors || [];
    if (competitors.length < 2) return false;
    const names = competitors.map(c => c?.team?.displayName || c?.team?.name || '');
    return (
      (espnTeamMatches(fix.home, names[0]) && espnTeamMatches(fix.away, names[1])) ||
      (espnTeamMatches(fix.home, names[1]) && espnTeamMatches(fix.away, names[0]))
    );
  });
}

async function fetchEspnScoreboard() {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN respondeu ${res.status}`);
  const data = await res.json();
  return data?.events || [];
}

async function getCurrentResults() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bolao_results?id=eq.1&select=*`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Falha ao ler bolao_results: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function saveMatches(matches) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bolao_results?id=eq.1`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      matches,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Falha ao salvar bolao_results: ${res.status} ${await res.text()}`);
}

async function main() {
  console.log('Buscando scoreboard da ESPN...');
  const events = await fetchEspnScoreboard();
  console.log(`${events.length} eventos retornados pela ESPN.`);

  const current = await getCurrentResults();
  const matches = { ...(current?.matches || {}) };

  let updated = 0;
  let finished = 0;
  const unmatched = [];

  for (const fix of FIXTURES) {
    const ev = findEspnEvent(fix, events);
    if (!ev) { unmatched.push(fix.id); continue; }

    const comp = ev.competitions?.[0];
    const statusName = comp?.status?.type?.name || '';
    const isFinal = statusName === 'STATUS_FINAL' || !!comp?.status?.type?.completed;
    if (statusName === 'STATUS_SCHEDULED' || statusName === '') continue; // ainda não começou

    const competitors = comp?.competitors || [];
    const homeC = competitors.find(c => espnTeamMatches(fix.home, c?.team?.displayName || c?.team?.name || ''));
    const awayC = competitors.find(c => espnTeamMatches(fix.away, c?.team?.displayName || c?.team?.name || ''));
    if (!homeC || !awayC) continue;
    if (homeC.score == null || awayC.score == null) continue;

    const hs = String(homeC.score);
    const as = String(awayC.score);
    const cur = matches[fix.id] || {};
    if (cur.home !== hs || cur.away !== as) {
      matches[fix.id] = { home: hs, away: as };
      updated++;
      if (isFinal) finished++;
      console.log(`  ${fix.id}: ${fix.home} ${hs} x ${as} ${fix.away}${isFinal ? ' (FINAL)' : ' (em andamento)'}`);
    }
  }

  if (updated > 0) {
    await saveMatches(matches);
    console.log(`✅ ${updated} jogo(s) atualizado(s) no Supabase (${finished} finalizado(s)).`);
  } else {
    console.log('Nenhuma mudança de placar encontrada.');
  }

  if (unmatched.length) {
    console.log(`⚠️  ${unmatched.length} jogo(s) sem correspondência na ESPN: ${unmatched.join(', ')}`);
  }
}

main().catch(err => {
  console.error('Erro no sync:', err);
  process.exit(1);
});
