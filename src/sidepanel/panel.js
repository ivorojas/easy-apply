// Easy Apply — lógica del panel lateral (modo seguro).
// El panel solo muestra y copia: nunca escribe en la página.

const $ = (s) => document.querySelector(s);

// --- Modo LinkedIn ----------------------------------------------------------

async function loadMode() {
  const { settings } = await chrome.storage.local.get('settings');
  const mode = settings?.linkedinMode || 'assistant';
  document.querySelector(`input[name="limode"][value="${mode}"]`).checked = true;
}

document.querySelectorAll('input[name="limode"]').forEach((r) =>
  r.addEventListener('change', async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: Object.assign({}, settings, { linkedinMode: r.value }) });
  })
);

// --- Helpers ----------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function status(container, msg, ok = false) {
  container.querySelector('.status')?.remove();
  container.appendChild(el('div', 'status' + (ok ? ' ok' : ''), msg));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function generate(question, jobContext, maxLength, resultBox) {
  const res = await chrome.runtime.sendMessage({ type: 'GENERATE_ANSWER', question, jobContext, maxLength });
  resultBox.innerHTML = '';
  if (!res) return status(resultBox, 'Sin respuesta del fondo.');
  if (res.error === 'NO_API_KEY') return status(resultBox, 'Falta tu API key de Gemini — cargala en Ajustes.');
  if (res.error) return status(resultBox, res.error);
  if (res.noInfo) return status(resultBox, 'No tengo con qué responder esto según tu perfil — respondela a mano.');

  const ans = el('div', 'answer', res.answer);
  const actions = el('div', 'answer-actions');
  const copy = el('button', 'btn primary small', '📋 Copiar');
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(res.answer);
    copy.textContent = '✓ Copiada';
    setTimeout(() => (copy.textContent = '📋 Copiar'), 1600);
  });
  const approve = el('button', 'btn ghost small', '💾 Aprobar y guardar');
  approve.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'SAVE_APPROVED', question, answer: res.answer });
    approve.textContent = '✓ Guardada';
  });
  actions.append(copy, approve);
  resultBox.append(ans, actions);
  if (res.source === 'cache') status(resultBox, '♻️ Reusada de tu caché de respuestas aprobadas.', true);
}

async function chooseForPanel(question, options, jobContext, resultBox) {
  const res = await chrome.runtime.sendMessage({ type: 'CHOOSE_OPTION', question, options, multi: false, jobContext });
  resultBox.innerHTML = '';
  if (!res) return status(resultBox, 'Sin respuesta del fondo.');
  if (res.error === 'NO_API_KEY') return status(resultBox, 'Falta tu API key de Gemini — cargala en Ajustes.');
  if (res.error) return status(resultBox, res.error);
  if (res.noInfo) return status(resultBox, 'No puedo decidir con tus datos — elegila a mano.');
  status(resultBox, `✅ Elegí a mano esta opción: “${options[res.index]}”`, true);
}

// --- Leer pantalla (LinkedIn, modo asistente) --------------------------------

function renderQuestions(res, box, safeNote) {
  for (const q of res.questions) {
    const item = el('div', 'q-item');
    item.appendChild(el('div', 'q-label', q.label));
    const meta = 'Tipo: ' + q.kind + (q.maxLength ? ` · máx ${q.maxLength} caracteres` : '');
    item.appendChild(el('div', 'q-kind', meta));
    if (q.options?.length) item.appendChild(el('div', 'q-options', 'Opciones: ' + q.options.join(' · ')));
    const hasOptions = q.options?.length;
    const isData = q.kind === 'dato';
    const gen = el('button', 'btn primary small', hasOptions ? '✨ Qué elegir' : '✨ Generar respuesta');
    const result = el('div');
    gen.addEventListener('click', async () => {
      gen.disabled = true;
      if (hasOptions) await chooseForPanel(q.label, q.options, res.jobContext, result);
      else await generate(q.label, res.jobContext, q.maxLength, result);
      gen.disabled = false;
    });
    item.append(gen, result);
    box.appendChild(item);
  }
  status(box, `Leí ${res.questions.length} campo(s) de tu pantalla. ${safeNote}`, true);
}

$('#scan').addEventListener('click', async () => {
  const btn = $('#scan');
  const box = $('#scan-result');
  box.innerHTML = '';
  btn.disabled = true;
  btn.textContent = '⏳ leyendo…';
  try {
    const tab = await activeTab();
    const url = tab?.url || '';
    if (!tab?.id || !/^https?:/.test(url)) {
      status(box, 'Abrí una página web con un formulario (Greenhouse, Lever, la que sea) y volvé a tocar.');
      return;
    }
    const isLinkedIn = /linkedin\.com/.test(url);
    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: isLinkedIn ? 'LI_SCAN' : 'EA_READ' });
    } catch {
      status(box, '🔄 Recargá esta pestaña una vez (la extensión se actualizó) y volvé a tocar “Leer pantalla”.');
      return;
    }
    if (res?.off) {
      status(box, 'Estás en modo apagado total para LinkedIn: no leo nada. Usá la pregunta manual de abajo.');
      return;
    }
    if (res?.error) return status(box, res.error);
    if (!res?.questions?.length) {
      status(box, 'No encontré campos visibles en esta página. Si el formulario está en un paso siguiente, abrilo y reintentá.');
      return;
    }
    renderQuestions(
      res,
      box,
      isLinkedIn ? 'Copiá y pegá vos — en LinkedIn no toco nada.' : 'También intenté rellenarla sola en la página; acá tenés las respuestas para copiar por si preferís.'
    );
  } finally {
    btn.disabled = false;
    btn.textContent = '👀 Leer pantalla';
  }
});

// --- Pregunta manual ----------------------------------------------------------

$('#manual-gen').addEventListener('click', async () => {
  const q = $('#manual-q').value.trim();
  const ctx = $('#manual-ctx').value.trim();
  const box = $('#manual-result');
  if (!q) {
    box.innerHTML = '';
    return status(box, 'Pegá una pregunta primero.');
  }
  const btn = $('#manual-gen');
  btn.disabled = true;
  btn.textContent = '⏳ pensando…';
  await generate(q, ctx ? { description: ctx } : null, null, box);
  btn.disabled = false;
  btn.textContent = '✨ Generar respuesta';
});

$('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

loadMode();
