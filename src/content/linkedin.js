// Easy Apply — content script de LinkedIn. MODO SEGURO, SIEMPRE.
//
// REGLAS INQUEBRANTABLES EN ESTE ARCHIVO:
//   - NUNCA escribe en ningún campo.
//   - NUNCA clickea ningún botón ni link.
//   - NUNCA hace fetch/XHR a servidores de LinkedIn.
//   - NUNCA modifica el DOM de la página.
// Lo ÚNICO que puede hacer, y solo en modo "asistente", es LEER texto que ya
// está visible en tu pantalla cuando el panel se lo pide. En modo "apagado"
// ni siquiera eso: responde vacío sin tocar el DOM.

(() => {
  async function getMode() {
    const { settings } = await chrome.storage.local.get('settings');
    return settings?.linkedinMode || 'assistant';
  }

  function readVisibleQuestions() {
    // Solo LECTURA de lo que ya está en pantalla (modal de Easy Apply u otro formulario visible).
    const scope =
      document.querySelector('.jobs-easy-apply-modal, [data-test-modal], [role="dialog"]') || document;
    const questions = [];
    const seen = new Set();

    const push = (label, kind, options, maxLength) => {
      const clean = (label || '').replace(/\s+/g, ' ').trim();
      if (!clean || clean.length < 3 || seen.has(clean)) return;
      seen.add(clean);
      questions.push({ label: clean, kind, options, maxLength });
    };

    for (const el of scope.querySelectorAll('textarea, input[type="text"], input:not([type])')) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      let label = '';
      const id = el.getAttribute('id');
      if (id) label = scope.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || '';
      if (!label) label = el.closest('label')?.textContent || el.getAttribute('aria-label') || '';
      if (!label) {
        const grp = el.closest('.fb-dash-form-element, .jobs-easy-apply-form-element, div');
        label = grp?.querySelector('label, legend, span[aria-hidden="true"]')?.textContent || '';
      }
      push(label, el.tagName === 'TEXTAREA' ? 'texto largo' : 'texto', null, el.maxLength > 0 ? el.maxLength : null);
    }

    for (const sel of scope.querySelectorAll('select')) {
      const r = sel.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const grp = sel.closest('.fb-dash-form-element, .jobs-easy-apply-form-element, div');
      const label = grp?.querySelector('label, legend')?.textContent || '';
      const options = [...sel.querySelectorAll('option')].map((o) => o.textContent.trim()).filter(Boolean);
      push(label, 'selección', options, null);
    }

    for (const fs of scope.querySelectorAll('fieldset')) {
      const legend = fs.querySelector('legend')?.textContent || '';
      const options = [...fs.querySelectorAll('label')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (options.length) push(legend, 'opciones', options, null);
    }

    // Contexto del aviso: también solo lectura de texto visible.
    const title =
      document.querySelector('.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1')
        ?.textContent.trim() || document.title;
    const company =
      document.querySelector('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name')
        ?.textContent.trim() || '';
    const description =
      document.querySelector('.jobs-description__content, #job-details')?.innerText.slice(0, 8000) || '';

    return { questions, jobContext: { title, company, description, url: location.href } };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'EA_STATUS') {
      getMode().then((mode) => sendResponse({ site: 'linkedin', mode }));
      return true;
    }
    if (msg?.type === 'LI_SCAN') {
      getMode().then((mode) => {
        if (mode !== 'assistant') {
          // Modo apagado total: no se lee NADA de la página.
          sendResponse({ off: true });
          return;
        }
        try {
          sendResponse(readVisibleQuestions());
        } catch (e) {
          sendResponse({ error: e.message });
        }
      });
      return true;
    }
  });
})();
