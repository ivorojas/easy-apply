// Easy Apply — ajustes: perfil (datos duros + blob), IA, LinkedIn y caché.
// Autoguardado con debounce; todo vive en chrome.storage.local.

const $ = (s) => document.querySelector(s);

const PROFILE_FIELDS = [
  'firstName', 'lastName', 'email', 'phone', 'location', 'yearsExp',
  'linkedin', 'portfolio', 'github', 'currentCompany', 'workAuth',
  'needsVisa', 'salary', 'availability', 'blob'
];

let saveTimer = null;

function flashSaved() {
  const el = $('#save-state');
  el.textContent = '✓ Guardado';
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.textContent = ''), 1800);
}

async function load() {
  const { profile = {}, settings = {} } = await chrome.storage.local.get(['profile', 'settings']);
  for (const f of PROFILE_FIELDS) {
    const el = $('#' + f);
    if (el) el.value = profile[f] || '';
  }
  $('#apiKey').value = settings.apiKey || '';
  $('#model').value = settings.model || 'gemini-2.5-flash-lite';
  const mode = settings.linkedinMode || 'assistant';
  const radio = document.querySelector(`input[name="linkedinMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  // Links del enriquecimiento espejan los datos duros github/portfolio.
  $('#linkGithub').value = profile.github || '';
  $('#linkPortfolio').value = profile.portfolio || '';
  renderCvStatus(profile);
  renderEnrichment('github', profile.enrichment?.github);
  renderEnrichment('portfolio', profile.enrichment?.portfolio);
  await renderCache();
}

async function save() {
  // Partimos del perfil existente para NO pisar cvText/cvName/enrichment.
  const { profile = {} } = await chrome.storage.local.get('profile');
  for (const f of PROFILE_FIELDS) {
    const el = $('#' + f);
    if (el) profile[f] = el.value.trim();
  }
  const { settings = {} } = await chrome.storage.local.get('settings');
  settings.apiKey = $('#apiKey').value.trim();
  settings.model = $('#model').value.trim() || 'gemini-2.5-flash-lite';
  settings.linkedinMode = document.querySelector('input[name="linkedinMode"]:checked')?.value || 'assistant';
  await chrome.storage.local.set({ profile, settings });
  flashSaved();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}

document.addEventListener('input', scheduleSave);
document.addEventListener('change', scheduleSave);

$('#toggle-key').addEventListener('click', () => {
  const k = $('#apiKey');
  k.type = k.type === 'password' ? 'text' : 'password';
});

// --- Probar conexión con Gemini ----------------------------------------------

$('#test-api').addEventListener('click', async () => {
  const out = $('#test-result');
  out.textContent = '⏳ probando…';
  await save();
  const res = await chrome.runtime.sendMessage({
    type: 'GENERATE_ANSWER',
    question: 'Test de conexión: respondé {"answer": "ok"}.',
    jobContext: null,
    maxLength: 20
  });
  if (res?.error === 'NO_API_KEY') out.textContent = '⚠️ Pegá tu API key primero.';
  else if (res?.error) out.textContent = '❌ ' + res.error;
  else out.textContent = '✅ Conexión OK, la IA respondió.';
});

// --- Caché --------------------------------------------------------------------

async function renderCache() {
  const { answerCache = [] } = await chrome.storage.local.get('answerCache');
  $('#cache-count').textContent = String(answerCache.length);
  const list = $('#cache-list');
  list.innerHTML = '';
  if (!answerCache.length) {
    list.innerHTML = '<p class="note">Todavía no aprobaste ninguna respuesta.</p>';
    return;
  }
  answerCache.forEach((entry, i) => {
    const item = document.createElement('div');
    item.className = 'cache-item';
    const texts = document.createElement('div');
    texts.className = 'texts';
    const q = document.createElement('div');
    q.className = 'cache-q';
    q.textContent = entry.q;
    const a = document.createElement('div');
    a.className = 'cache-a';
    a.textContent = entry.a;
    texts.append(q, a);
    const del = document.createElement('button');
    del.className = 'cache-del';
    del.textContent = '🗑';
    del.title = 'Borrar esta respuesta';
    del.addEventListener('click', async () => {
      const { answerCache = [] } = await chrome.storage.local.get('answerCache');
      answerCache.splice(i, 1);
      await chrome.storage.local.set({ answerCache });
      renderCache();
    });
    item.append(texts, del);
    list.appendChild(item);
  });
}

$('#clear-cache').addEventListener('click', async () => {
  if (!confirm('¿Vaciar toda la caché de respuestas aprobadas?')) return;
  await chrome.storage.local.set({ answerCache: [] });
  renderCache();
});

// --- Exportar / importar --------------------------------------------------------

$('#export').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['profile', 'settings', 'answerCache']);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'easy-apply-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import').addEventListener('click', () => $('#import-file').click());

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const toSet = {};
    for (const k of ['profile', 'settings', 'answerCache']) if (data[k]) toSet[k] = data[k];
    await chrome.storage.local.set(toSet);
    await load();
    flashSaved();
  } catch {
    alert('El archivo no es un backup válido de Easy Apply.');
  }
  e.target.value = '';
});

// --- CV: leer una vez al subir --------------------------------------------------

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf/pdf.worker.min.js');
}

async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map((it) => it.str).join(' ') + '\n';
  }
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function renderCvStatus(profile) {
  const status = $('#cv-status');
  const clear = $('#cv-clear');
  const wrap = $('#cv-preview-wrap');
  if (profile.cvText) {
    status.innerHTML = `✅ <b>${profile.cvName || 'CV'}</b> — ${profile.cvText.length.toLocaleString('es')} caracteres leídos y guardados.`;
    clear.hidden = false;
    wrap.hidden = false;
    $('#cv-preview').textContent = profile.cvText.slice(0, 4000);
  } else {
    status.textContent = 'Todavía no subiste ningún CV.';
    clear.hidden = true;
    wrap.hidden = true;
  }
}

$('#cv-pick').addEventListener('click', () => $('#cv-file').click());

$('#cv-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('#cv-status');
  status.textContent = '⏳ Leyendo el CV…';
  try {
    let text = '';
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      if (!window.pdfjsLib) throw new Error('No cargó el lector de PDF');
      text = await extractPdfText(file);
    } else {
      text = await file.text();
    }
    text = text.trim();
    if (!text) {
      status.textContent = '⚠️ No pude sacar texto de ese archivo. ¿Es un PDF escaneado (imagen)? Probá con un PDF de texto o pegá el contenido en la super memoria.';
      e.target.value = '';
      return;
    }
    const { profile = {} } = await chrome.storage.local.get('profile');
    profile.cvText = text.slice(0, 20000);
    profile.cvName = file.name;
    await chrome.storage.local.set({ profile });
    renderCvStatus(profile);
    flashSaved();
  } catch (err) {
    status.textContent = '❌ Error leyendo el CV: ' + err.message;
  }
  e.target.value = '';
});

$('#cv-clear').addEventListener('click', async () => {
  const { profile = {} } = await chrome.storage.local.get('profile');
  delete profile.cvText;
  delete profile.cvName;
  await chrome.storage.local.set({ profile });
  renderCvStatus(profile);
});

// --- Enriquecimiento desde links ------------------------------------------------

// Espejar los inputs de links con los datos duros github/portfolio.
$('#linkGithub').addEventListener('input', () => {
  $('#github').value = $('#linkGithub').value;
  scheduleSave();
});
$('#linkPortfolio').addEventListener('input', () => {
  $('#portfolio').value = $('#linkPortfolio').value;
  scheduleSave();
});

function renderEnrichment(key, data) {
  const box = $('#enr-' + key);
  if (!box) return;
  box.innerHTML = '';
  if (!data) return;
  const card = document.createElement('div');
  card.className = 'enrich-card ' + (data.ok ? 'ok' : 'fail');
  if (data.ok) {
    const head = document.createElement('div');
    head.className = 'enrich-head';
    head.textContent = '✅ ' + (data.summary || 'Info traída');
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = 'Ver qué obtuve';
    const pre = document.createElement('pre');
    pre.className = 'preview';
    pre.textContent = data.text || '';
    det.append(sum, pre);
    card.append(head, det);
  } else {
    card.textContent = (data.linkedin ? 'ℹ️ ' : '⚠️ ') + (data.error || 'No se pudo');
  }
  box.appendChild(card);
}

async function ensurePermission(url) {
  try {
    const origin = new URL(url).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

document.querySelectorAll('.enrich').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const kind = btn.dataset.kind;
    const key = kind === 'github' ? 'github' : 'portfolio';
    const url = $('#' + btn.dataset.input).value.trim();
    const box = $('#enr-' + key);
    if (!url) {
      box.innerHTML = '<div class="enrich-card fail">Pegá el link primero.</div>';
      return;
    }
    await save();
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '⏳…';
    // El portfolio necesita permiso al dominio (GitHub API ya está permitida).
    if (kind !== 'github') {
      const okPerm = await ensurePermission(url);
      if (!okPerm) {
        box.innerHTML = '<div class="enrich-card fail">Necesito permiso para acceder a esa web. Volvé a tocar y aceptá el cartel de Chrome.</div>';
        btn.disabled = false;
        btn.textContent = orig;
        return;
      }
    }
    const res = await chrome.runtime.sendMessage({ type: 'ENRICH_LINK', kind, url });
    btn.disabled = false;
    btn.textContent = orig;
    renderEnrichment(key, res);
    if (res?.ok) {
      const { profile = {} } = await chrome.storage.local.get('profile');
      profile.enrichment = profile.enrichment || {};
      profile.enrichment[key] = res;
      await chrome.storage.local.set({ profile });
      flashSaved();
    }
  })
);

// --- Completar datos duros desde CV / memoria -----------------------------------

$('#extract-hard').addEventListener('click', async () => {
  const out = $('#extract-result');
  out.textContent = '⏳ Leyendo tu CV y memoria…';
  await save();
  const res = await chrome.runtime.sendMessage({ type: 'EXTRACT_HARD_FIELDS' });
  if (res?.error) {
    out.textContent = '⚠️ ' + res.error;
    return;
  }
  const fields = res?.fields || {};
  const keys = Object.keys(fields);
  if (!keys.length) {
    out.textContent = 'No encontré datos claros para completar (no invento). Cargalos a mano.';
    return;
  }
  // Solo completa los vacíos, para no pisar lo que ya escribiste; vos revisás.
  let n = 0;
  for (const k of keys) {
    const el = $('#' + k);
    if (el && !el.value.trim()) {
      el.value = fields[k];
      n++;
    }
  }
  if ($('#github').value) $('#linkGithub').value = $('#github').value;
  if ($('#portfolio').value) $('#linkPortfolio').value = $('#portfolio').value;
  await save();
  out.textContent = `✅ Completé ${n} campo(s) vacío(s). Revisalos: la IA puede equivocarse.`;
});

load();
