const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

function apiRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(55000, () => { req.destroy(); reject(new Error('Timeout API')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getBzzMatches() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const res = await apiRequest({
      hostname: 'sports.bzzoiro.com',
      path: `/api/events/?date_from=${today}&date_to=${today}`,
      method: 'GET',
      headers: {
        'Authorization': process.env.BZZOIRO_TOKEN || '7a23ce5699426d2a0d1f99a56fbd254f33c4184f',
        'Content-Type': 'application/json'
      }
    });
    if (res.status === 200 && typeof res.data === 'object') {
      const r = res.data?.results || res.data?.data || res.data || [];
      return Array.isArray(r) ? r.slice(0, 12) : [];
    }
    return [];
  } catch(e) {
    console.log('Bzzoiro error:', e.message);
    return [];
  }
}

async function analyzeWithDeepSeek(matches) {
  const today = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Mexico_City'
  });

  const matchList = matches.length > 0
    ? matches.map((m, i) =>
        `${i+1}. ${m.home_team||m.home||'Local'} vs ${m.away_team||m.away||'Visitante'} | ${m.league_name||m.competition||'Liga'} | ${m.event_date||m.date||today}`
      ).join('\n')
    : `Genera 8 partidos reales de hoy ${today} de: Premier League, La Liga, Serie A, Bundesliga, Liga MX, Ligue 1, Champions League`;

  const prompt = `Hoy es ${today}. Analiza estos partidos para detectar value bets con modelo Poisson:

${matchList}

Para CADA partido:
1. Calcula avgGolesH, avgGolesA, avgConcH, avgConcA de su historial reciente
2. lambdaHome = (avgGolesH/1.35)*(avgConcA/1.35)*1.35*1.15
3. lambdaAway = (avgGolesA/1.35)*(avgConcH/1.35)*1.35
4. Prob 1X2 con Poisson k=0..8, normalizar
5. probOver25 = suma i+j>=3
6. probBTTS = (1-e^-lH)*(1-e^-lA)
7. cuotas reales de mercado con margen 5-7%
8. value = prob*cuota-1 (incluir si >0.05)
9. kelly = max(0,(p*(q-1)-(1-p))/(q-1))*0.25
10. confidence: ALTA>0.15, MEDIA>0.08, BAJA>0.05

Responde SOLO con JSON array válido. Sin markdown. Sin explicaciones. Empieza con [ y termina con ]:
[{"id":"1","home":"Nombre Real","away":"Nombre Real","league":"Liga Real","time":"HH:MM","status":"upcoming","score":"","venue":"Estadio Real, Ciudad","lambdaHome":1.5,"lambdaAway":1.1,"probHome":0.45,"probDraw":0.27,"probAway":0.28,"probOver25":0.62,"probBTTS":0.65,"avgGolesH":1.6,"avgGolesA":1.4,"avgConcH":1.1,"avgConcA":1.2,"formHome":["W","W","D","L","W"],"formAway":["W","L","W","W","D"],"h2h":{"homeWins":3,"draws":2,"awayWins":4},"valueBets":[{"market":"Over/Under","selection":"Over 2.5","odds":1.72,"impliedProb":0.58,"estProb":0.62,"value":0.066,"kelly":0.016,"confidence":"MEDIA"}],"topPick":{"selection":"Over 2.5","confidence":72,"odds":1.72},"corners":{"avg":10.5,"over95":1.65},"cards":{"avg":3.8,"over35":1.55},"bttsOdds":1.65,"ou25Odds":{"over":1.72,"under":2.10},"odds1x2":{"home":2.30,"draw":3.70,"away":2.85},"hasValue":true}]`;

  const body = JSON.stringify({
    model: 'deepseek-chat',
    max_tokens: 4000,
    temperature: 0.1,
    messages: [
      { role: 'system', content: 'Eres experto en estadísticas de fútbol y value bets. Responde SOLO con JSON array válido sin markdown.' },
      { role: 'user', content: prompt }
    ]
  });

  const res = await apiRequest({
    hostname: 'api.deepseek.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY || 'sk-b6dfe3530a064e86b412c2d553b7e11c'}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  if (res.status !== 200) {
    throw new Error(`DeepSeek error ${res.status}: ${JSON.stringify(res.data).substring(0, 300)}`);
  }

  const raw = typeof res.data === 'object'
    ? (res.data?.choices?.[0]?.message?.content || '')
    : String(res.data);

  if (!raw.trim()) throw new Error('DeepSeek devolvió respuesta vacía');

  let content = raw.replace(/```json|```/gi, '').trim();
  const s = content.indexOf('[');
  const e = content.lastIndexOf(']');
  if (s === -1 || e === -1) throw new Error(`JSON no encontrado. Respuesta: ${content.substring(0, 200)}`);

  return JSON.parse(content.substring(s, e + 1));
}

// Cache simple en memoria (5 minutos)
let cache = { data: null, ts: 0 };

app.get('/api/matches', async (req, res) => {
  try {
    const now = Date.now();
    // Devolver cache si tiene menos de 5 minutos
    if (cache.data && (now - cache.ts) < 5 * 60 * 1000) {
      return res.json({ ...cache.data, cached: true });
    }

    console.log('Fetching matches from Bzzoiro...');
    const bzzMatches = await getBzzMatches();
    console.log(`Got ${bzzMatches.length} matches from Bzzoiro`);

    console.log('Analyzing with DeepSeek...');
    const matches = await analyzeWithDeepSeek(bzzMatches);
    console.log(`Got ${matches.length} analyzed matches`);

    const result = {
      ok: true,
      updated: new Date().toISOString(),
      total: matches.length,
      matches
    };

    cache = { data: result, ts: now };
    res.json(result);

  } catch(err) {
    console.error('Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`BSD Value Bet corriendo en puerto ${PORT}`);
});
