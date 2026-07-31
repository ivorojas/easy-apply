// Easy Apply — popup: estado del sitio, accesos y actualización con un botón.

const $ = (s) => document.querySelector(s);

$('#version').textContent = 'v' + chrome.runtime.getManifest().version;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// --- Encendido / apagado global -------------------------------------------------

let enabled = false;

function paintPower() {
  const t = $('#power-toggle');
  t.setAttribute('aria-checked', String(enabled));
  $('#power-label').textContent = enabled ? 'Encendida' : 'Apagada';
  document.querySelector('.power').classList.toggle('on', enabled);
  $('#site-status').classList.toggle('dim', !enabled);
  $('#refill').disabled = !enabled;
}

async function loadPower() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_ENABLED' });
  enabled = !!r?.enabled;
  paintPower();
}

$('#power-toggle').addEventListener('click', async () => {
  enabled = !enabled;
  paintPower();
  await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled });
  detectSite();
});

async function detectSite() {
  const box = $('#site-status');
  const tab = await activeTab();
  const url = tab?.url || '';
  if (!enabled) {
    box.className = 'site-status dim';
    box.innerHTML = '⏻ <b>Está apagada.</b> Prendé el toggle de arriba para que actúe en esta página. Se apaga sola cuando cerrás el navegador.';
    $('#refill').hidden = true;
    return;
  }
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
    return;
  }
  checkTabFresh(tab);
}

// ¿La pestaña está corriendo el código de esta versión? Si quedó vieja tras una
// actualización, se avisa y se ofrece arreglarlo con un click (sin F5 a mano).
async function checkTabFresh(tab) {
  if (!tab?.id) return;
  const mine = chrome.runtime.getManifest().version;
  let st = null;
  try {
    st = await chrome.tabs.sendMessage(tab.id, { type: 'EA_STATUS' });
  } catch {}
  const stale = !st || (st.version && st.version !== mine);
  if (!stale) return;
  const box = document.querySelector('#site-status');
  const warn = document.createElement('div');
  warn.style.cssText = 'margin-top:8px;font-size:12px;color:#f0c674';
  warn.textContent = st?.version
    ? `⚠️ Esta pestaña corre la v${st.version} y la extensión es v${mine}.`
    : '⚠️ Esta pestaña todavía no tiene el código de la extensión.';
  const fix = document.createElement('button');
  fix.className = 'btn small ghost';
  fix.style.cssText = 'margin-top:6px;width:100%';
  fix.textContent = '🔄 Actualizar esta pestaña';
  fix.addEventListener('click', async () => {
    fix.disabled = true;
    fix.textContent = '⏳…';
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['src/content/ats.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id, allFrames: true },
        files: ['src/content/ats.css']
      });
      fix.textContent = '✓ Lista';
      warn.textContent = '✅ Pestaña actualizada a la v' + mine + '.';
    } catch {
      chrome.tabs.reload(tab.id);
      window.close();
    }
  });
  box.appendChild(warn);
  box.appendChild(fix);
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
  if (!auto) st.textContent = 'Buscando…';
  const res = await chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' });
  if (!res) return;

  // Caso 1: ya hay código nuevo en disco esperando — un toque y listo.
  if (res.pendingReload) {
    st.innerHTML = `Código nuevo listo: <b>v${res.onDisk}</b> (corriendo v${res.current}).`;
    $('#do-update').hidden = false;
    $('#do-update').textContent = '⚡ Aplicar actualización';
    return;
  }
  if (res.error) {
    st.textContent = auto ? `Estás al día (v${res.current}).` : res.error;
    return;
  }
  // Caso 2: hay versión nueva en GitHub para bajar.
  if (res.updateAvailable) {
    st.innerHTML = `Nueva versión <b>${res.latest}</b> en GitHub (tenés v${res.current}).`;
    $('#do-update').hidden = false;
    $('#do-update').textContent = '⬇️ Actualizar ahora';
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
    btn.textContent = res.mode === 'reload' ? `✓ Aplicando v${res.to}…` : '✓ Listo, recargando…';
    return; // la extensión se recarga sola y el popup se cierra con ella
  }
  // No se pudo traer de GitHub (falta el actualizador nativo). Igual ofrecemos
  // recargar, que resuelve el caso de archivos ya actualizados en disco.
  btn.disabled = false;
  btn.textContent = '⬇️ Actualizar ahora';
  $('#update-status').innerHTML = res?.hostMissing
    ? 'No puedo bajar de GitHub solo: falta registrar el actualizador (una vez).'
    : 'Falló: ' + (res?.error || res?.output || 'error desconocido');
  $('#update-help').hidden = false;
  $('#reload-ext').hidden = false;
});

$('#reload-ext').addEventListener('click', async () => {
  $('#reload-ext').textContent = '⏳ Recargando…';
  await chrome.runtime.sendMessage({ type: 'RELOAD_EXT' });
});

loadPower().then(detectSite);
checkApiKey();
checkUpdate(true);
