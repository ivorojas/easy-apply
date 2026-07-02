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
  await renderCache();
}

async function save() {
  const profile = {};
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

load();
