// Easy Apply — service worker
// Responsabilidades: llamadas a Gemini, caché de respuestas aprobadas,
// chequeo de actualizaciones y actualización con un botón (native messaging).

const UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/ivorojas/easy-apply/main/manifest.json';
const NATIVE_HOST = 'com.easyapply.updater';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getStore(keys) {
  return chrome.storage.local.get(keys);
}

async function getSettings() {
  const { settings } = await getStore('settings');
  return Object.assign({ apiKey: '', model: DEFAULT_MODEL, linkedinMode: 'assistant' }, settings);
}

async function getProfile() {
  const { profile } = await getStore('profile');
  return profile || {};
}

async function getCache() {
  const { answerCache } = await getStore('answerCache');
  return answerCache || [];
}

// ---------------------------------------------------------------------------
// Similitud de preguntas (para reusar respuestas aprobadas)
// ---------------------------------------------------------------------------

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  ('de la el los las un una que en y a o del al por para con su tus tu vos usted nos como cual ' +
    'the a an of in on at to for with your you our and or is are do does what why how tell us please').split(' ')
);

function tokens(text) {
  return new Set(normalize(text).split(' ').filter((t) => t && !STOPWORDS.has(t)));
}

function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter); // Jaccard
}

function findSimilar(cache, question) {
  return cache
    .map((entry) => ({ entry, score: similarity(entry.q, question) }))
    .filter((x) => x.score >= 0.35)
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function callGemini(prompt) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { error: 'NO_API_KEY' };
  }
  const model = settings.model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json'
        }
      })
    });
  } catch (e) {
    return { error: 'Fallo de red: ' + e.message };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 400 && body.includes('API key')) return { error: 'API key inválida' };
    if (res.status === 429) return { error: 'Límite de uso de Gemini alcanzado, esperá un momento' };
    return { error: `Gemini respondió ${res.status}` };
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  try {
    return { json: JSON.parse(text) };
  } catch {
    // A veces el modelo envuelve el JSON en ```json ... ```
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return { json: JSON.parse(m[0]) };
      } catch {}
    }
    return { error: 'Respuesta de IA no parseable' };
  }
}

function profileBlock(profile) {
  const hard = [
    ['Nombre', [profile.firstName, profile.lastName].filter(Boolean).join(' ')],
    ['Email', profile.email],
    ['Teléfono', profile.phone],
    ['Ubicación', profile.location],
    ['LinkedIn', profile.linkedin],
    ['Portfolio / Web', profile.portfolio],
    ['GitHub', profile.github],
    ['Años de experiencia', profile.yearsExp],
    ['Autorizado a trabajar', profile.workAuth],
    ['Necesita visa/sponsorship', profile.needsVisa],
    ['Expectativa salarial', profile.salary],
    ['Disponibilidad', profile.availability]
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  return `DATOS DUROS:\n${hard || '(sin datos)'}\n\nMEMORIA COMPLETA DEL CANDIDATO (experiencia, proyectos, anécdotas):\n${profile.blob || '(vacía)'}`;
}

function jobBlock(jobContext) {
  if (!jobContext) return '(sin contexto del aviso)';
  const parts = [];
  if (jobContext.title) parts.push(`Puesto: ${jobContext.title}`);
  if (jobContext.company) parts.push(`Empresa: ${jobContext.company}`);
  if (jobContext.description) parts.push(`Descripción del aviso:\n${jobContext.description.slice(0, 6000)}`);
  return parts.join('\n') || '(sin contexto del aviso)';
}

const NEVER_INVENT = `REGLA CRÍTICA E INQUEBRANTABLE: NUNCA inventes datos, experiencias, proyectos, números ni hechos que no estén en el perfil del candidato. Un campo sin responder es MEJOR que una respuesta inventada. Si el perfil no tiene información suficiente para responder, devolvé exactamente {"no_info": true}.`;

async function generateAnswer({ question, jobContext, maxLength }) {
  const cache = await getCache();
  const similar = findSimilar(cache, question);

  // Reuso directo si la pregunta es casi idéntica a una ya aprobada.
  if (similar.length && similar[0].score >= 0.85) {
    const entry = similar[0].entry;
    let answer = entry.a;
    if (maxLength && answer.length > maxLength) answer = answer.slice(0, maxLength);
    return { answer, source: 'cache', cachedQuestion: entry.q };
  }

  const profile = await getProfile();
  const examples = similar
    .slice(0, 3)
    .map((s) => `PREGUNTA: ${s.entry.q}\nRESPUESTA APROBADA: ${s.entry.a}`)
    .join('\n---\n');

  const prompt = `Sos un asistente que ayuda a un candidato a responder preguntas de formularios de postulación de trabajo. Escribís EN NOMBRE del candidato, en primera persona.

${NEVER_INVENT}

PERFIL DEL CANDIDATO (única fuente de verdad sobre él):
${profileBlock(profile)}

CONTEXTO DEL PUESTO AL QUE SE POSTULA:
${jobBlock(jobContext)}
${examples ? `\nRESPUESTAS QUE EL CANDIDATO YA APROBÓ PARA PREGUNTAS PARECIDAS (imitá su estilo y contenido si aplican):\n${examples}\n` : ''}
PREGUNTA DEL FORMULARIO:
"${question}"

INSTRUCCIONES:
- Respondé en el MISMO IDIOMA en que está escrita la pregunta.
- ${maxLength ? `La respuesta debe tener MENOS de ${maxLength} caracteres (límite duro del campo).` : 'Sé breve: 2 a 4 oraciones salvo que la pregunta pida más.'}
- Tono natural y concreto, primera persona, sin frases de relleno ni clichés.
- Usá el contexto del puesto para que la respuesta sea a medida.
- Devolvé SOLO un JSON válido: {"answer": "..."} o {"no_info": true}.`;

  const result = await callGemini(prompt);
  if (result.error) return { error: result.error };
  const json = result.json;
  if (json.no_info || !json.answer) return { noInfo: true };
  let answer = String(json.answer).trim();
  if (maxLength && answer.length > maxLength) answer = answer.slice(0, maxLength).trim();
  return { answer, source: 'ai' };
}

async function chooseOption({ question, options, multi, jobContext }) {
  const profile = await getProfile();
  const list = options.map((o, i) => `${i}: ${o}`).join('\n');
  const prompt = `Sos un asistente que ayuda a un candidato a completar formularios de postulación. Este campo NO es de texto libre: solo se puede ELEGIR entre opciones.

${NEVER_INVENT} Elegí una opción SOLO si los datos del perfil la respaldan claramente.

PERFIL DEL CANDIDATO:
${profileBlock(profile)}

CONTEXTO DEL PUESTO:
${jobBlock(jobContext)}

PREGUNTA DEL FORMULARIO:
"${question}"

OPCIONES DISPONIBLES (índice: texto):
${list}

INSTRUCCIONES:
- ${multi ? 'Se pueden elegir varias. Devolvé {"indexes": [n, ...]}' : 'Se elige UNA sola. Devolvé {"index": n}'} donde n es el índice de la opción correcta según el perfil.
- Si el perfil no permite decidir con certeza, devolvé {"no_info": true}.
- Devolvé SOLO JSON válido.`;

  const result = await callGemini(prompt);
  if (result.error) return { error: result.error };
  const json = result.json;
  if (json.no_info) return { noInfo: true };
  if (multi && Array.isArray(json.indexes)) {
    const idx = json.indexes.map(Number).filter((n) => n >= 0 && n < options.length);
    return idx.length ? { indexes: idx } : { noInfo: true };
  }
  const n = Number(json.index);
  if (Number.isInteger(n) && n >= 0 && n < options.length) return { index: n };
  return { noInfo: true };
}

async function saveApproved({ question, answer }) {
  const cache = await getCache();
  const norm = normalize(question);
  const existing = cache.find((e) => normalize(e.q) === norm);
  if (existing) {
    existing.a = answer;
    existing.ts = new Date().toISOString();
    existing.uses = (existing.uses || 0) + 1;
  } else {
    cache.unshift({ q: question, a: answer, ts: new Date().toISOString(), uses: 0 });
  }
  await chrome.storage.local.set({ answerCache: cache.slice(0, 500) });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Actualización
// ---------------------------------------------------------------------------

function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function checkUpdate() {
  const current = chrome.runtime.getManifest().version;
  try {
    const res = await fetch(UPDATE_MANIFEST_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return { current, error: 'No se pudo consultar GitHub (' + res.status + ')' };
    const remote = await res.json();
    const updateAvailable = cmpVersions(remote.version, current) > 0;
    await chrome.action.setBadgeText({ text: updateAvailable ? '1' : '' });
    if (updateAvailable) await chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
    return { current, latest: remote.version, updateAvailable };
  } catch (e) {
    return { current, error: 'Sin conexión con GitHub: ' + e.message };
  }
}

function runNativeUpdate() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'update' }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, hostMissing: true, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: 'Sin respuesta del actualizador' });
        }
      });
    } catch (e) {
      resolve({ ok: false, hostMissing: true, error: e.message });
    }
  });
}

async function updateNow() {
  const result = await runNativeUpdate();
  if (result.ok) {
    // Los archivos ya se actualizaron en disco: recargar la extensión los toma.
    setTimeout(() => chrome.runtime.reload(), 800);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mensajería
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    GENERATE_ANSWER: () => generateAnswer(msg),
    CHOOSE_OPTION: () => chooseOption(msg),
    SAVE_APPROVED: () => saveApproved(msg),
    CHECK_UPDATE: () => checkUpdate(),
    UPDATE_NOW: () => updateNow(),
    GET_SETTINGS: () => getSettings()
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e.message }));
  return true; // respuesta asíncrona
});

// ---------------------------------------------------------------------------
// Alarms: chequeo diario de actualización
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('update-check', { periodInMinutes: 60 * 12 });
  checkUpdate();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'update-check') checkUpdate();
});
