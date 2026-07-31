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
  return Object.assign(
    { apiKey: '', model: DEFAULT_MODEL, linkedinMode: 'assistant', answerLang: 'auto' },
    settings
  );
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
// Datos duros: si la pregunta pide un dato (email, tel, nombre…), se devuelve
// el valor PELADO, sin IA y sin redactar oraciones. "Son datos, se copian."
// ---------------------------------------------------------------------------

const HARD_QUESTION_RULES = [
  { re: /correo|e-?mail/i, get: (p) => p.email },
  { re: /tel[eé]fono|celular|phone|m[oó]vil|whatsapp/i, get: (p) => p.phone },
  { re: /linked ?in/i, get: (p) => p.linkedin },
  { re: /git ?hub/i, get: (p) => p.github },
  { re: /empresa|company|employer|compa[nñ][ií]a/i, get: (p) => p.currentCompany },
  { re: /portfolio|sitio web|website|web personal|p[aá]gina web|\burl\b/i, get: (p) => p.portfolio },
  { re: /ubicaci[oó]n|ciudad|location|\bcity\b|residenc|d[oó]nde viv[ií]s|address|direcci[oó]n/i, get: (p) => p.location },
  { re: /a[nñ]os de experiencia|years of experience|experience/i, get: (p) => p.yearsExp },
  { re: /expectativa salarial|pretensi[oó]n|salary|remuneraci[oó]n|compensation/i, get: (p) => p.salary },
  { re: /autoriza|authoriz|work permit|permiso.*trabaj|elegib|eligib/i, get: (p) => p.workAuth },
  { re: /visa|sponsorship|patrocinio/i, get: (p) => p.needsVisa },
  { re: /disponibilidad|availability|start date|cu[aá]ndo pod[eé]s empezar|fecha de inicio/i, get: (p) => p.availability },
  { re: /nombre completo|nombre y apellidos?|full name/i, get: (p) => [p.firstName, p.lastName].filter(Boolean).join(' ') },
  { re: /apellidos?|last name|surname|family name/i, get: (p) => p.lastName },
  { re: /\bnombre\b|first name|given name|primer nombre/i, get: (p) => p.firstName }
];

// Devuelve {isHard, value} si es un dato duro; null si es pregunta abierta.
function matchHardQuestion(question, profile) {
  const q = normalize(question);
  const words = q.split(' ').filter(Boolean);
  // Preguntas largas o que piden redactar → no son un dato: van a la IA.
  if (words.length > 8) return null;
  if (/(por que|porque|describ|contar|cont[aá]|explic|motiv|redact|why|describe|tell us)/.test(q)) return null;
  if (/(usuario|user name|username|contrase|password)/.test(q)) return null;
  for (const rule of HARD_QUESTION_RULES) {
    if (rule.re.test(question)) {
      return { isHard: true, value: String(rule.get(profile) || '').trim() };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

// Intenta sacar un objeto JSON de un texto (quita ```json, busca llaves…).
function salvageJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

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
          maxOutputTokens: 4096,
          responseMimeType: 'application/json'
        }
      })
    });
  } catch (e) {
    return { error: 'Fallo de red: ' + e.message };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 400 && /API key|API_KEY/.test(body)) return { error: 'API key inválida' };
    if (res.status === 429) return { error: 'Límite de uso de Gemini alcanzado, esperá un momento' };
    if (res.status === 404) return { error: `El modelo "${model}" no existe o no está disponible con tu key` };
    return { error: `Gemini respondió ${res.status}` };
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const finishReason = cand?.finishReason || '';
  const text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) {
    if (finishReason === 'SAFETY') return { error: 'Gemini bloqueó la respuesta por filtros de seguridad' };
    if (finishReason === 'MAX_TOKENS') return { error: 'La respuesta se cortó por longitud, probá de nuevo' };
    return { error: 'Gemini devolvió una respuesta vacía' };
  }
  return { json: salvageJson(text), text, finishReason };
}

// Rescata la respuesta de texto aunque el JSON venga roto/cortado.
function salvageAnswer(text) {
  if (!text) return null;
  const obj = salvageJson(text);
  if (obj) {
    if (obj.no_info) return { noInfo: true };
    if (typeof obj.answer === 'string' && obj.answer.trim()) return { answer: obj.answer.trim() };
  }
  // JSON cortado: extraer el valor de "answer" aunque no cierre la comilla.
  const m = String(text).match(/"answer"\s*:\s*"([\s\S]*?)(?:"\s*[},]|$)/);
  if (m && m[1]) {
    const val = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
    if (val) return { answer: val };
  }
  // Texto plano (el modelo ignoró el formato JSON): usarlo tal cual.
  const plain = String(text).replace(/```(json)?/gi, '').trim();
  if (plain && !plain.startsWith('{')) return { answer: plain };
  return null;
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

  const sections = [
    `DATOS DUROS:\n${hard || '(sin datos)'}`,
    `MEMORIA COMPLETA DEL CANDIDATO (experiencia, proyectos, anécdotas):\n${profile.blob || '(vacía)'}`
  ];

  if (profile.cvText) {
    sections.push(`CURRÍCULUM (texto extraído del CV que subió el candidato):\n${String(profile.cvText).slice(0, 8000)}`);
  }

  // Biblioteca de documentos extra (portfolio, experiencia, casos…). Se
  // incluyen todos hasta un presupuesto de caracteres para no reventar el prompt.
  if (Array.isArray(profile.docs) && profile.docs.length) {
    let budget = 16000;
    const chunks = [];
    for (const d of profile.docs) {
      if (budget <= 0) break;
      const slice = String(d.text || '').slice(0, Math.min(6000, budget));
      if (!slice) continue;
      chunks.push(`— ${d.name || 'documento'} —\n${slice}`);
      budget -= slice.length;
    }
    if (chunks.length) {
      sections.push(`DOCUMENTOS DEL CANDIDATO (PDF/textos que subió con su experiencia y trabajos):\n${chunks.join('\n\n')}`);
    }
  }

  const enr = profile.enrichment || {};
  const enrParts = [];
  for (const key of ['github', 'portfolio']) {
    if (enr[key]?.ok && enr[key]?.text) {
      enrParts.push(`De su ${key} (${enr[key].url}):\n${String(enr[key].text).slice(0, 4000)}`);
    }
  }
  if (enrParts.length) {
    sections.push(`INFORMACIÓN TRAÍDA DE SUS LINKS:\n${enrParts.join('\n\n')}`);
  }

  return sections.join('\n\n');
}

function jobBlock(jobContext) {
  if (!jobContext) return '(sin contexto del aviso)';
  const parts = [];
  if (jobContext.title) parts.push(`Puesto: ${jobContext.title}`);
  if (jobContext.company) parts.push(`Empresa: ${jobContext.company}`);
  if (jobContext.description) parts.push(`Descripción del aviso:\n${jobContext.description.slice(0, 6000)}`);
  return parts.join('\n') || '(sin contexto del aviso)';
}

// ---------------------------------------------------------------------------
// Idioma. REGLA DE ORO: el idioma lo decide EL TEXTO DE LA PREGUNTA, nunca el
// resto de la página. Un formulario en inglés puede vivir en un sitio con la
// interfaz en español (ej. adzuna.com.mx) — mirar la página entera contamina.
// ---------------------------------------------------------------------------

const EN_WORDS = /\b(the|and|or|your|you|with|for|why|how|what|which|who|when|where|describe|tell|please|share|provide|explain|about|experience|role|company|we|our|are|is|was|were|will|would|should|could|can|have|has|had|this|that|these|those|from|as|at|by|an|of|to|in|on|work|worked|want|team|skills|us|hiring|cover|letter|application|apply|job|position|do|does|did|been|being|there|their|it|its|any|all|more|most|years|level|systems|business|project|led|during)\b/g;
const ES_WORDS = /\b(el|la|los|las|un|una|unos|unas|por|para|que|qu[eé]|con|de|del|en|y|o|su|sus|somos|nuestro|nuestra|experiencia|puesto|empresa|trabajo|trabaj[oóá]|equipo|sobre|c[oó]mo|cu[aá]l|cu[aá]ntos|porque|tus|tu|sos|ten[eé]s|ten[ge]|gracias|favor|m[aá]s|este|esta|estos|estas|sin|como|cont[aá]|describ[ií]|h[aá]blanos|cu[eé]ntanos|motivaci[oó]n|carta|rol|a[nñ]os|hab[eé]is|eres|est[aá]s|fuiste|has|han|desde|hasta|muy|tambi[eé]n|pero|si|no|se|le|lo)\b/g;

// Puntaje de "españolidad" de un texto: -1 (inglés claro) a +1 (español claro).
function langScore(text) {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return 0;
  const en = (t.match(EN_WORDS) || []).length;
  let es = (t.match(ES_WORDS) || []).length;
  // Caracteres exclusivos del español: señal fuerte, pero PONDERADA, no un
  // cortocircuito (un solo "año" del menú no puede decidir por la pregunta).
  const spanishChars = (t.match(/[ñ¿¡]/g) || []).length;
  const accents = (t.match(/[áéíóúü]/g) || []).length;
  es += spanishChars * 2 + accents;
  const total = en + es;
  if (!total) return 0;
  return (es - en) / total;
}

// Idioma destino: SOLO desde la pregunta (+ el aviso como desempate si la
// pregunta es demasiado corta para decidir).
function detectLang(question, jobDescription) {
  const q = (question || '').trim();
  const qScore = langScore(q);
  const qWords = q.split(/\s+/).filter(Boolean).length;
  // Con una pregunta de largo razonable, la pregunta manda y punto.
  if (qWords >= 4 && Math.abs(qScore) > 0.05) return qScore > 0 ? 'es' : 'en';
  // Pregunta corta/ambigua: desempatar con la descripción del aviso.
  const dScore = langScore((jobDescription || '').slice(0, 2000));
  const combined = qScore * 2 + dScore; // la pregunta pesa el doble
  if (Math.abs(combined) > 0.02) return combined > 0 ? 'es' : 'en';
  return 'es'; // sin señal alguna: español (idioma del usuario)
}

// Idioma de un texto ya generado (para verificar la respuesta del modelo).
function textLang(text) {
  const s = langScore(text);
  if (Math.abs(s) < 0.03) return null; // indeterminado
  return s > 0 ? 'es' : 'en';
}

// Contexto del aviso: si el de la página actual es flojo (formulario sin
// descripción, típico cuando el aviso está en otra página/paso), usa el
// "último aviso jugoso" que se guardó al verlo.
const JOB_MAX_AGE_MS = 3 * 60 * 60 * 1000; // 3 horas

function jobStrength(ctx) {
  return (ctx?.description || '').trim().length;
}

async function resolveJobContext(incoming) {
  if (jobStrength(incoming) >= 250) return incoming;
  const { lastJob } = await chrome.storage.local.get('lastJob');
  if (lastJob && jobStrength(lastJob) >= 120) {
    const age = Date.now() - new Date(lastJob.savedAt || 0).getTime();
    if (age <= JOB_MAX_AGE_MS) {
      // Combina: título/empresa de la página actual si existen, descripción guardada.
      return {
        title: incoming?.title || lastJob.title,
        company: incoming?.company || lastJob.company,
        description: lastJob.description,
        url: lastJob.url,
        fromSaved: true
      };
    }
  }
  return incoming;
}

async function saveJob(ctx) {
  if (jobStrength(ctx) < 120) return { ok: false, reason: 'weak' };
  const lastJob = {
    title: ctx.title || '',
    company: ctx.company || '',
    description: String(ctx.description || '').slice(0, 12000),
    url: ctx.url || '',
    savedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ lastJob });
  return { ok: true, lastJob };
}

const NEVER_INVENT = `REGLA CRÍTICA E INQUEBRANTABLE: NUNCA inventes datos, experiencias, proyectos, números ni hechos que no estén en el perfil del candidato. Un campo sin responder es MEJOR que una respuesta inventada. Si el perfil no tiene información suficiente para responder, devolvé exactamente {"no_info": true}.`;

const NEVER_INVENT_EN = `CRITICAL, UNBREAKABLE RULE: NEVER invent data, experiences, projects, numbers or facts that are not in the candidate's profile. Leaving a field empty is BETTER than an invented answer. If the profile lacks enough information to answer, return exactly {"no_info": true}.`;

// El prompt se escribe ÍNTEGRAMENTE en el idioma destino. Una sola línea
// pidiendo "respondé en inglés" dentro de un prompt en español no alcanza:
// el modelo sigue el idioma dominante del contexto.
function buildAnswerPrompt({ lang, profile, job, examples, question, maxLength }) {
  if (lang === 'en') {
    return `You are helping a job candidate answer a question on a job application form. You write ON BEHALF of the candidate, in the first person.

${NEVER_INVENT_EN}

CANDIDATE PROFILE (the only source of truth about them — it is written in Spanish, but your answer MUST be in English):
${profileBlock(profile)}

JOB THEY ARE APPLYING TO:
${jobBlock(job)}
${examples ? `\nANSWERS THE CANDIDATE ALREADY APPROVED FOR SIMILAR QUESTIONS (match their style and content when relevant):\n${examples}\n` : ''}
FORM QUESTION:
"${question}"

INSTRUCTIONS:
- LANGUAGE: the form question is in English, so your answer MUST be written entirely in ENGLISH. The candidate's profile is in Spanish — translate the relevant facts into natural English. Do NOT answer in Spanish under any circumstance.
- ${maxLength ? `The answer must be UNDER ${maxLength} characters (hard field limit).` : 'Be concise: 2 to 4 sentences unless the question asks for more.'}
- Natural, concrete tone, first person, no filler or clichés.
- Get straight to the content: no preambles like "Sure" or "My answer is", and do not repeat the question.
- Use the job context so the answer is tailored.
- Return ONLY valid JSON: {"answer": "..."} or {"no_info": true}.`;
  }
  return `Sos un asistente que ayuda a un candidato a responder preguntas de formularios de postulación de trabajo. Escribís EN NOMBRE del candidato, en primera persona.

${NEVER_INVENT}

PERFIL DEL CANDIDATO (única fuente de verdad sobre él):
${profileBlock(profile)}

CONTEXTO DEL PUESTO AL QUE SE POSTULA:
${jobBlock(job)}
${examples ? `\nRESPUESTAS QUE EL CANDIDATO YA APROBÓ PARA PREGUNTAS PARECIDAS (imitá su estilo y contenido si aplican):\n${examples}\n` : ''}
PREGUNTA DEL FORMULARIO:
"${question}"

INSTRUCCIONES:
- IDIOMA: la pregunta está en español, así que respondé ÍNTEGRAMENTE EN ESPAÑOL.
- ${maxLength ? `La respuesta debe tener MENOS de ${maxLength} caracteres (límite duro del campo).` : 'Sé breve: 2 a 4 oraciones salvo que la pregunta pida más.'}
- Tono natural y concreto, primera persona, sin frases de relleno ni clichés.
- Andá directo al contenido: nada de preámbulos tipo "Claro", "Mi respuesta es" ni repetir la pregunta.
- Usá el contexto del puesto para que la respuesta sea a medida.
- Devolvé SOLO un JSON válido: {"answer": "..."} o {"no_info": true}.`;
}

// Red de seguridad: si la respuesta salió en el idioma equivocado, se traduce.
async function enforceLanguage(answer, lang, maxLength) {
  const actual = textLang(answer);
  if (!actual || actual === lang) return { answer, translated: false };
  const prompt =
    lang === 'en'
      ? `Translate the following job-application answer into natural, fluent English. Keep the first person, keep every fact exactly as-is (do not add or remove information), keep a professional but natural tone.${maxLength ? ` The result must be UNDER ${maxLength} characters.` : ''}\n\nTEXT:\n"""${answer}"""\n\nReturn ONLY valid JSON: {"answer": "the English translation"}`
      : `Traducí la siguiente respuesta de postulación laboral a un español natural y fluido. Mantené la primera persona, los hechos exactamente igual (no agregues ni quites información) y un tono profesional pero natural.${maxLength ? ` El resultado debe tener MENOS de ${maxLength} caracteres.` : ''}\n\nTEXTO:\n"""${answer}"""\n\nDevolvé SOLO JSON válido: {"answer": "la traducción al español"}`;
  const res = await callGemini(prompt);
  if (res.error) return { answer, translated: false };
  const salv = salvageAnswer(res.text);
  if (salv && salv.answer) return { answer: salv.answer.trim(), translated: true };
  return { answer, translated: false };
}

async function generateAnswer({ question, jobContext, maxLength, forceLang }) {
  const profile = await getProfile();
  const settings = await getSettings();

  // 1) ¿Es un dato duro? (email, teléfono, nombre, LinkedIn…) → valor pelado, sin IA.
  const hard = matchHardQuestion(question, profile);
  if (hard) {
    if (!hard.value) return { noInfo: true }; // no lo tengo → no invento
    let value = hard.value;
    if (maxLength && value.length > maxLength) value = value.slice(0, maxLength);
    return { answer: value, source: 'perfil' };
  }

  const job = await resolveJobContext(jobContext);

  // 2) Idioma destino: override manual > la PREGUNTA (nunca el resto de la página).
  const preference = forceLang || settings.answerLang || 'auto';
  const lang = preference === 'auto' ? detectLang(question, job?.description) : preference;

  // 3) Caché: solo se reusa si está en el MISMO idioma que hay que responder.
  const cache = await getCache();
  const similar = findSimilar(cache, question).filter((s) => {
    const l = textLang(s.entry.a);
    return !l || l === lang;
  });

  if (similar.length && similar[0].score >= 0.85) {
    const entry = similar[0].entry;
    let answer = entry.a;
    if (maxLength && answer.length > maxLength) answer = answer.slice(0, maxLength);
    return { answer, source: 'cache', cachedQuestion: entry.q, lang };
  }

  const examples = similar
    .slice(0, 3)
    .map((s) => `PREGUNTA: ${s.entry.q}\nRESPUESTA APROBADA: ${s.entry.a}`)
    .join('\n---\n');

  const prompt = buildAnswerPrompt({ lang, profile, job, examples, question, maxLength });

  const result = await callGemini(prompt);
  if (result.error) return { error: result.error };
  const salv = salvageAnswer(result.text) || (result.json && (result.json.no_info ? { noInfo: true } : result.json.answer ? { answer: String(result.json.answer) } : null));
  if (!salv || salv.noInfo || !salv.answer) return { noInfo: true };

  // 4) Verificación posterior: si salió en el idioma equivocado, se traduce.
  const enforced = await enforceLanguage(salv.answer.trim(), lang, maxLength);
  let answer = enforced.answer;
  if (maxLength && answer.length > maxLength) answer = answer.slice(0, maxLength).trim();
  return {
    answer,
    source: 'ai',
    lang,
    translated: enforced.translated,
    usedSavedJob: !!job?.fromSaved
  };
}

async function chooseOption({ question, options, multi, jobContext }) {
  const profile = await getProfile();
  const job = await resolveJobContext(jobContext);
  const list = options.map((o, i) => `${i}: ${o}`).join('\n');
  const prompt = `Sos un asistente que ayuda a un candidato a completar formularios de postulación. Este campo NO es de texto libre: solo se puede ELEGIR entre opciones.

${NEVER_INVENT} Elegí una opción SOLO si los datos del perfil la respaldan claramente.

PERFIL DEL CANDIDATO:
${profileBlock(profile)}

CONTEXTO DEL PUESTO:
${jobBlock(job)}

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
  const json = result.json || salvageJson(result.text);
  if (!json || json.no_info) return { noInfo: true };
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
// Enriquecimiento desde links (GitHub API + web personal). LinkedIn NUNCA.
// ---------------------------------------------------------------------------

function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
  return s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

async function enrichGithub(url) {
  const m = url.match(/github\.com\/([^/?#]+)/i);
  if (!m) return { ok: false, error: 'No parece un link de GitHub válido' };
  const user = m[1];
  try {
    const uRes = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}`, {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (uRes.status === 404) return { ok: false, error: `El usuario "${user}" no existe en GitHub` };
    if (uRes.status === 403) return { ok: false, error: 'GitHub limitó las consultas por ahora (probá en un rato)' };
    if (!uRes.ok) return { ok: false, error: 'GitHub respondió ' + uRes.status };
    const u = await uRes.json();
    const rRes = await fetch(
      `https://api.github.com/users/${encodeURIComponent(user)}/repos?sort=pushed&per_page=100`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    const repos = rRes.ok ? await rRes.json() : [];
    const top = repos
      .filter((r) => !r.fork)
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .slice(0, 12)
      .map((r) => `- ${r.name}${r.language ? ` (${r.language})` : ''}${r.stargazers_count ? ` ⭐${r.stargazers_count}` : ''}: ${r.description || 'sin descripción'}`);
    const langs = [...new Set(repos.map((r) => r.language).filter(Boolean))];
    const parts = [
      u.name && `Nombre: ${u.name}`,
      u.bio && `Bio: ${u.bio}`,
      u.company && `Empresa: ${u.company}`,
      u.location && `Ubicación: ${u.location}`,
      u.blog && `Web: ${u.blog}`,
      `Repos públicos: ${u.public_repos} · Seguidores: ${u.followers}`,
      langs.length && `Lenguajes: ${langs.join(', ')}`,
      top.length && `Proyectos destacados:\n${top.join('\n')}`
    ].filter(Boolean);
    const summary = `@${user} · ${u.public_repos} repos · ${langs.slice(0, 5).join(', ') || 'varios lenguajes'}`;
    return { ok: true, url, summary, text: parts.join('\n'), fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: 'Fallo de red con GitHub: ' + e.message };
  }
}

async function enrichWebsite(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, error: 'La página respondió ' + res.status };
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const text = htmlToText(html).slice(0, 6000);
    if (!text) return { ok: false, error: 'No pude extraer texto de esa página' };
    const summary = (titleMatch ? titleMatch[1].trim() : new URL(url).hostname) + ` · ${text.length} caracteres`;
    return { ok: true, url, summary, text, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: 'No pude acceder a esa URL (¿existe? ¿diste el permiso?): ' + e.message };
  }
}

async function enrichLink({ kind, url }) {
  if (!url) return { ok: false, error: 'Falta la URL' };
  if (/linkedin\.com/i.test(url)) {
    return {
      ok: false,
      linkedin: true,
      error:
        'No traigo datos de LinkedIn a propósito: la extensión nunca toca sus servidores (regla anti-baneo) y además LinkedIn devuelve un muro de login, no tu perfil. Copiá lo que quieras de tu LinkedIn y pegalo en la super memoria.'
    };
  }
  if (kind === 'github' || /github\.com/i.test(url)) return enrichGithub(url);
  return enrichWebsite(url);
}

async function extractHardFields() {
  const profile = await getProfile();
  const docsText = Array.isArray(profile.docs) ? profile.docs.map((d) => d.text).join('\n\n') : '';
  const source = [profile.blob, profile.cvText, docsText].filter(Boolean).join('\n\n');
  if (!source.trim()) return { error: 'No hay CV, documentos ni super memoria de dónde extraer' };
  const prompt = `Extraé datos de contacto del siguiente texto de un candidato. ${NEVER_INVENT}
Devolvé SOLO un JSON con las claves que encuentres (omití las que no estén, NO inventes):
{"firstName","lastName","email","phone","location","yearsExp","linkedin","portfolio","github","currentCompany"}

TEXTO:
${source.slice(0, 12000)}`;
  const result = await callGemini(prompt);
  if (result.error) return { error: result.error };
  const j = result.json || salvageJson(result.text) || {};
  const clean = {};
  for (const k of ['firstName', 'lastName', 'email', 'phone', 'location', 'yearsExp', 'linkedin', 'portfolio', 'github', 'currentCompany']) {
    if (j[k] && typeof j[k] === 'string') clean[k] = j[k].trim();
  }
  return { fields: clean };
}

// ---------------------------------------------------------------------------
// Encendido/apagado global. Vive en storage.session: se borra SOLO cuando se
// cierra el navegador. Por defecto arranca APAGADO en cada sesión de Chrome.
// ---------------------------------------------------------------------------

async function getEnabled() {
  const { enabled } = await chrome.storage.session.get('enabled');
  return !!enabled;
}

async function reflectBadge(enabled) {
  try {
    await chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#1fa860' : '#888888' });
  } catch {}
}

async function broadcastEnabled(enabled) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({}); // sin filtro de url → no requiere permiso "tabs"
  } catch {}
  for (const t of tabs) {
    if (t.id) chrome.tabs.sendMessage(t.id, { type: 'EA_SET_ENABLED', enabled }).catch(() => {});
  }
}

async function setEnabled(enabled) {
  await chrome.storage.session.set({ enabled: !!enabled });
  await reflectBadge(!!enabled);
  await broadcastEnabled(!!enabled);
  return { ok: true, enabled: !!enabled };
}

// Al arrancar el service worker, reflejar el estado actual (persistido en la
// sesión del navegador) en el badge. Con catch: si el SW se apaga en el medio
// Chrome tira "No SW" y no queremos una promesa sin manejar.
getEnabled()
  .then(reflectBadge)
  .catch(() => {});

// Al abrir el navegador: forzar apagado.
chrome.runtime.onStartup.addListener(async () => {
  try {
    await chrome.storage.session.set({ enabled: false });
    await reflectBadge(false);
  } catch {}
});

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
    // El badge lo usa el estado ON/OFF; la actualización se avisa en el popup.
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
    SAVE_JOB: () => saveJob(msg.jobContext),
    GET_JOB: async () => (await chrome.storage.local.get('lastJob')).lastJob || null,
    CLEAR_JOB: async () => {
      await chrome.storage.local.remove('lastJob');
      return { ok: true };
    },
    ENRICH_LINK: () => enrichLink(msg),
    EXTRACT_HARD_FIELDS: () => extractHardFields(),
    CHECK_UPDATE: () => checkUpdate(),
    UPDATE_NOW: () => updateNow(),
    GET_SETTINGS: () => getSettings(),
    GET_ENABLED: async () => ({ enabled: await getEnabled() }),
    SET_ENABLED: () => setEnabled(msg.enabled)
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

// Al instalar o ACTUALIZAR: reinyectar los content scripts en las pestañas ya
// abiertas. Sin esto, esas pestañas siguen con el código viejo (huérfano) hasta
// que el usuario aprieta F5 — el paso invisible que hacía parecer que "no se
// actualiza". Con esto, actualizar y listo.
async function reinjectContentScripts() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return 0;
  }
  let done = 0;
  for (const tab of tabs) {
    const url = tab.url || '';
    if (!/^https?:/.test(url)) continue;
    const isLinkedIn = /:\/\/([^/]*\.)?linkedin\.com/.test(url);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: !isLinkedIn },
        files: [isLinkedIn ? 'src/content/linkedin.js' : 'src/content/ats.js']
      });
      if (!isLinkedIn) {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id, allFrames: true },
          files: ['src/content/ats.css']
        });
      }
      done++;
    } catch {
      // Pestañas protegidas (Web Store, chrome://, PDFs) — se ignoran.
    }
  }
  return done;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    chrome.alarms.create('update-check', { periodInMinutes: 60 * 12 });
    await chrome.storage.session.set({ enabled: false }); // arranca apagada
    await reflectBadge(false);
    if (details?.reason === 'update' || details?.reason === 'install') {
      const n = await reinjectContentScripts();
      console.log(`[Easy Apply] v${chrome.runtime.getManifest().version} — reinyectado en ${n} pestaña(s)`);
    }
    await checkUpdate();
  } catch {}
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'update-check') checkUpdate();
});
