// Easy Apply — popup: estado del sitio, accesos y actualización con un botón.

const $ = (s) => document.querySelector(s);

$('#version').textContent = 'v' + chrome.runtime.getManifest().version;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function detectSite() {
  const box = $('#site-status');
  const tab = await activeTab();
  const url = tab?.url || '';
  if (/linkedin\.com/.test(url)) {
    const { settings } = await chrome.storage.local.get('settings');
    const mode = settings?.linkedinMode || 'assistant';
    box.className = 'site-status safe';
    box.innerHTML =
      mode === 'assistant'
        ? '🛡️ <b>LinkedIn — modo seguro (asistente)</b>: no toco la página, solo leo lo visible cuando me lo pedís desde el panel.'
        : '🛡️ <b>LinkedIn — apagado total</b>: no leo ni toco nada. Usá la pregunta manual del panel.';
  } else if (/^https?:/.test(url)) {
    const known = /greenhouse\.io|lever\.co/.test(url);
    box.className = 'site-status full';
    box.innerHTML = known
      ? '🟢 <b>ATS conocido detectado</b> — relleno básicos y sugiero respuestas. El envío final es tuyo.'
      : '🟢 <b>Modo activo</b> — puedo rellenar los campos de esta página y sugerir respuestas. El envío final es tuyo.';
    $('#refill').hidden = false;
  } else {
    box.className = 'site-status';
    box.innerHTML = 'Esta pestaña no es una página web (no puedo actuar acá). Abrí un formulario de postulación.';
  }
}

async function checkApiKey() {
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  $('#apikey-warning').hidden = Boolean(settings?.apiKey);
}

$('#go-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('#open-panel').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
  window.close();
});

$('#refill').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'EA_REFILL' });
    window.close();
  } catch {
    // La página se abrió antes de instalar/actualizar: no tiene el content script.
    $('#site-status').innerHTML = '🔄 Recargá esta pestaña una vez y volvé a intentar (la extensión se actualizó).';
  }
});

// --- Actualización -----------------------------------------------------------

async function checkUpdate(auto) {
  const st = $('#update-status');
  if (!auto) st.textContent = 'Consultando GitHub…';
  const res = await chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' });
  if (res?.error) {
    st.textContent = auto ? 'Versión instalada.' : res.error;
    return;
  }
  if (res?.updateAvailable) {
    st.textContent = `Nueva versión ${res.latest} disponible (tenés ${res.current}).`;
    $('#do-update').hidden = false;
  } else {
    st.textContent = `Estás al día (v${res.current}).`;
  }
}

$('#check-update').addEventListener('click', () => checkUpdate(false));

$('#do-update').addEventListener('click', async () => {
  const btn = $('#do-update');
  btn.disabled = true;
  btn.textContent = '⏳ Actualizando…';
  const res = await chrome.runtime.sendMessage({ type: 'UPDATE_NOW' });
  if (res?.ok) {
    btn.textContent = '✓ Listo, recargando…';
    // El service worker se recarga solo; este popup se cierra con él.
  } else {
    btn.disabled = false;
    btn.textContent = '⬇️ Actualizar ahora';
    $('#update-status').textContent = res?.hostMissing
      ? 'El actualizador nativo no está instalado.'
      : 'Falló la actualización: ' + (res?.error || res?.output || 'error desconocido');
    $('#update-help').hidden = false;
    $('#reload-ext').hidden = false;
  }
});

$('#reload-ext').addEventListener('click', () => chrome.runtime.reload());

detectSite();
checkApiKey();
checkUpdate(true);
