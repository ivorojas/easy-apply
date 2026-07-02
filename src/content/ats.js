// Easy Apply — content script para ATS externos (Greenhouse y Lever).
// Rellena datos duros sin IA, agrega un botón de IA por pregunta,
// elige opciones en selects/radios/checkboxes y marca el CV como manual.
// REGLAS DURAS: nunca clickea enviar/siguiente/aplicar, nunca sube archivos.

(() => {
  if (/linkedin\.com$/i.test(location.hostname)) return; // por las dudas: acá jamás

  const FILLED_CLASS = 'ea-filled';
  let profile = null;
  let jobContext = null;
  const processed = new WeakSet();

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function getLabelText(el) {
    let txt = '';
    const id = el.getAttribute('id');
    if (id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) txt = lbl.textContent;
      } catch {}
    }
    if (!txt) {
      const labelled = el.getAttribute('aria-labelledby');
      if (labelled) {
        txt = labelled
          .split(/\s+/)
          .map((i) => document.getElementById(i)?.textContent || '')
          .join(' ');
      }
    }
    if (!txt) {
      const wrap = el.closest('label');
      if (wrap) txt = wrap.textContent;
    }
    if (!txt) {
      // Contenedores típicos de Greenhouse / Lever
      const container = el.closest(
        '.field, .application-question, .application-field, [class*="input-wrapper"], [class*="question"], li, fieldset, div'
      );
      if (container) {
        const lbl = container.querySelector('label, legend, .application-label, [class*="label"]');
        if (lbl && !lbl.contains(el)) txt = lbl.textContent;
      }
    }
    if (!txt) txt = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    return txt.replace(/\s+/g, ' ').replace(/[*✱]|\(required\)|\(optional\)/gi, '').trim();
  }

  function toast(msg, ms = 4000) {
    let t = document.querySelector('.ea-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'ea-toast';
      document.documentElement.appendChild(t);
    }
    t.textContent = '✨ Easy Apply — ' + msg;
    t.classList.add('ea-show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('ea-show'), ms);
  }

  // -------------------------------------------------------------------------
  // Contexto del aviso (título, empresa, descripción)
  // -------------------------------------------------------------------------

  function extractJobContext() {
    if (jobContext) return jobContext;
    const host = location.hostname;
    let title = '';
    let company = '';
    let description = '';

    const h1 = document.querySelector('h1');
    if (h1) title = h1.textContent.trim();

    if (host.includes('greenhouse.io')) {
      company =
        document.querySelector('[class*="company-name"], .company-name')?.textContent.trim() ||
        (location.pathname.split('/').filter(Boolean)[0] || '');
      const desc = document.querySelector(
        '#content, [class*="job__description"], .job-post, [class*="description"]'
      );
      if (desc) description = desc.innerText;
    } else if (host.includes('lever.co')) {
      company = location.pathname.split('/').filter(Boolean)[0] || '';
      title =
        document.querySelector('.posting-headline h2, .posting-header h2')?.textContent.trim() || title;
      const desc = document.querySelector('.posting-page [data-qa="job-description"], .section-wrapper, .content');
      if (desc) description = desc.innerText;
    }
    if (!description) description = (document.querySelector('main') || document.body).innerText.slice(0, 8000);

    jobContext = {
      title: title || document.title,
      company,
      description: description.replace(/\s+\n/g, '\n').slice(0, 8000),
      url: location.href
    };
    return jobContext;
  }

  // -------------------------------------------------------------------------
  // Datos duros → relleno determinístico, sin IA
  // -------------------------------------------------------------------------

  const HARD_RULES = [
    { key: 'firstName', re: /first[\s_-]*name|nombre(?!.*(apellido|completo))|given[\s_-]*name/i, auto: 'given-name' },
    { key: 'lastName', re: /last[\s_-]*name|surname|apellido|family[\s_-]*name/i, auto: 'family-name' },
    { key: 'fullName', re: /full[\s_-]*name|nombre\s*(completo|y\s*apellido)|^name$|your\s*name/i, auto: 'name' },
    { key: 'email', re: /e-?mail|correo/i, auto: 'email' },
    { key: 'phone', re: /phone|tel[eé]fono|celular|mobile|m[oó]vil|whatsapp/i, auto: 'tel' },
    { key: 'linkedin', re: /linked[\s_-]*in/i },
    { key: 'github', re: /git[\s_-]*hub/i },
    { key: 'portfolio', re: /portfolio|website|web\s*site|sitio|personal\s*(web|site|url)|url/i, auto: 'url' },
    { key: 'location', re: /location|ubicaci[oó]n|ciudad|city|d[oó]nde\s*viv|current\s*(city|location)|residence/i },
    { key: 'yearsExp', re: /years?\s*(of)?\s*experience|a[nñ]os\s*de\s*experiencia/i },
    { key: 'salary', re: /salary|salario|remuneraci[oó]n|pretensi[oó]n|compensation\s*expectation/i },
    { key: 'company', re: /current\s*(company|employer)|empresa\s*actual|^company$|organization|^org$/i, profileKey: 'currentCompany' }
  ];

  function hardValue(key) {
    if (!profile) return '';
    if (key === 'fullName') return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    if (key === 'company') return profile.currentCompany || '';
    return profile[key] || '';
  }

  function matchHardField(el, label) {
    const hay = [
      label,
      el.getAttribute('name') || '',
      el.getAttribute('id') || '',
      el.getAttribute('autocomplete') || '',
      el.getAttribute('placeholder') || ''
    ].join(' | ');
    // El orden importa: linkedin/github antes que "url" genérica, etc.
    const order = ['linkedin', 'github', 'email', 'phone', 'firstName', 'lastName', 'fullName', 'yearsExp', 'salary', 'location', 'company', 'portfolio'];
    for (const key of order) {
      const rule = HARD_RULES.find((r) => r.key === key);
      if (rule.re.test(hay)) return key;
      if (rule.auto && (el.getAttribute('autocomplete') || '') === rule.auto) return key;
    }
    return null;
  }

  function fillHardFields(root) {
    let filled = 0;
    const inputs = root.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type])'
    );
    for (const el of inputs) {
      if (processed.has(el) || !isVisible(el) || el.value) continue;
      const label = getLabelText(el);
      const key = matchHardField(el, label);
      if (!key) continue;
      const value = hardValue(key);
      if (!value) continue;
      processed.add(el);
      setNativeValue(el, String(value));
      el.classList.add(FILLED_CLASS);
      filled++;
    }
    return filled;
  }

  // -------------------------------------------------------------------------
  // Preguntas de texto → botón de IA
  // -------------------------------------------------------------------------

  const QUESTION_HINT = /por\s*qu[eé]|why|describ|cont[aá]|cuent|tell\s*us|explain|what|c[oó]mo|how|experienc|motiv|interes/i;

  function isQuestionField(el, label) {
    if (el.tagName === 'TEXTAREA') return true;
    if (!label) return false;
    return label.length >= 25 || label.includes('?') || QUESTION_HINT.test(label);
  }

  function makeButton(text, cls = '') {
    const b = document.createElement('button');
    b.type = 'button'; // jamás submit
    b.className = 'ea-btn ' + cls;
    b.textContent = text;
    return b;
  }

  function reviewBar(el, question, answer, source) {
    el.parentElement?.querySelector('.ea-review')?.remove();
    const bar = document.createElement('div');
    bar.className = 'ea-review';
    const info = document.createElement('span');
    info.className = 'ea-review-info';
    info.textContent =
      source === 'cache' ? '♻️ Reusada de tu caché — revisala' : '✨ Borrador de IA — revisalo antes de enviar';
    const approve = makeButton('✓ Aprobar y guardar', 'ea-approve');
    const discard = makeButton('✕', 'ea-discard');
    approve.addEventListener('click', async () => {
      const current = el.value; // guarda lo que quedó tras tus ediciones
      await chrome.runtime.sendMessage({ type: 'SAVE_APPROVED', question, answer: current });
      bar.remove();
      toast('respuesta guardada en tu caché');
    });
    discard.addEventListener('click', () => {
      setNativeValue(el, '');
      bar.remove();
    });
    bar.append(info, approve, discard);
    el.insertAdjacentElement('afterend', bar);
  }

  function attachAIButton(el, label) {
    const btn = makeButton('✨ IA', 'ea-ai');
    btn.title = 'Generar respuesta con IA usando tu perfil y el aviso';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '⏳ pensando…';
      const maxLength = el.maxLength && el.maxLength > 0 ? el.maxLength : null;
      const res = await chrome.runtime.sendMessage({
        type: 'GENERATE_ANSWER',
        question: label,
        jobContext: extractJobContext(),
        maxLength
      });
      btn.disabled = false;
      btn.textContent = '✨ IA';
      if (!res) return toast('sin respuesta del fondo, recargá la página');
      if (res.error === 'NO_API_KEY') return toast('falta tu API key de Gemini — abrila en Ajustes');
      if (res.error) return toast(res.error);
      if (res.noInfo) return toast('no tengo con qué responder esto — completalo a mano');
      setNativeValue(el, res.answer);
      el.classList.add(FILLED_CLASS);
      reviewBar(el, label, res.answer, res.source);
    });
    const wrap = document.createElement('span');
    wrap.className = 'ea-btn-wrap';
    wrap.appendChild(btn);
    el.insertAdjacentElement('afterend', wrap);
  }

  function processQuestions(root) {
    const fields = root.querySelectorAll('textarea, input[type="text"], input:not([type])');
    for (const el of fields) {
      if (processed.has(el) || !isVisible(el)) continue;
      const label = getLabelText(el);
      if (el.tagName !== 'TEXTAREA') {
        const key = matchHardField(el, label);
        if (key) continue; // ya lo maneja el relleno duro
      }
      if (!isQuestionField(el, label)) continue;
      processed.add(el);
      attachAIButton(el, label || '(pregunta sin título)');
    }
  }

  // -------------------------------------------------------------------------
  // Selects / radios / checkboxes → elegir, no escribir
  // -------------------------------------------------------------------------

  function applySelect(el, index) {
    const opt = el.querySelectorAll('option')[index];
    if (!opt) return;
    setNativeValue(el, opt.value);
    el.classList.add(FILLED_CLASS);
  }

  function attachChooser(container, label, getOptions, apply, multi = false) {
    const btn = makeButton('✨ elegir', 'ea-ai ea-choose');
    btn.title = 'Elegir la opción correcta según tus datos';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '⏳';
      const options = getOptions();
      const res = await chrome.runtime.sendMessage({
        type: 'CHOOSE_OPTION',
        question: label,
        options,
        multi,
        jobContext: extractJobContext()
      });
      btn.disabled = false;
      btn.textContent = '✨ elegir';
      if (!res) return;
      if (res.error === 'NO_API_KEY') return toast('falta tu API key de Gemini — abrila en Ajustes');
      if (res.error) return toast(res.error);
      if (res.noInfo) return toast('no puedo decidir esta con tus datos — elegila a mano');
      apply(res);
      toast('opción seleccionada — verificala');
    });
    const wrap = document.createElement('span');
    wrap.className = 'ea-btn-wrap';
    wrap.appendChild(btn);
    container.appendChild(wrap);
  }

  function processSelects(root) {
    for (const sel of root.querySelectorAll('select')) {
      if (processed.has(sel) || !isVisible(sel)) continue;
      const options = [...sel.querySelectorAll('option')].map((o) => o.textContent.trim());
      const real = options.filter((o) => o && !/^(select|elegir|seleccionar|--|please)/i.test(o));
      if (real.length < 2) continue;
      processed.add(sel);
      const label = getLabelText(sel);
      const wrap = document.createElement('span');
      sel.insertAdjacentElement('afterend', wrap);
      attachChooser(
        wrap,
        label || '(select sin título)',
        () => [...sel.querySelectorAll('option')].map((o) => o.textContent.trim()),
        (res) => applySelect(sel, res.index)
      );
    }
  }

  function groupLabel(inputs) {
    const first = inputs[0];
    const fs = first.closest('fieldset');
    if (fs) {
      const legend = fs.querySelector('legend');
      if (legend) return legend.textContent.replace(/\s+/g, ' ').trim();
    }
    const container = first.closest('.field, .application-question, [class*="question"], [role="group"], [role="radiogroup"], div');
    if (container) {
      const lbl = container.querySelector('label, legend, [class*="label"]');
      if (lbl && !inputs.some((i) => lbl.contains(i))) return lbl.textContent.replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  function optionLabel(input) {
    const wrap = input.closest('label');
    if (wrap) return wrap.textContent.replace(/\s+/g, ' ').trim();
    const id = input.getAttribute('id');
    if (id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) return lbl.textContent.replace(/\s+/g, ' ').trim();
      } catch {}
    }
    return input.value || '';
  }

  function processRadioAndCheckboxGroups(root) {
    const byName = new Map();
    for (const input of root.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      if (processed.has(input) || !isVisible(input)) continue;
      const name = input.getAttribute('name') || '__anon__' + (input.closest('fieldset, div')?.className || '');
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(input);
    }
    for (const [, inputs] of byName) {
      if (!inputs.length) continue;
      inputs.forEach((i) => processed.add(i));
      const isCheckbox = inputs[0].type === 'checkbox';
      const label = groupLabel(inputs);
      // Checkbox suelto de consentimiento/legal: jamás lo tocamos.
      if (isCheckbox && inputs.length === 1 && /acept|acuerdo|consent|privacy|pol[ií]tica|terms|t[eé]rminos|gdpr/i.test(label + optionLabel(inputs[0]))) {
        continue;
      }
      if (inputs.length < 2 && !isCheckbox) continue;
      const anchor = inputs[inputs.length - 1].closest('label') || inputs[inputs.length - 1];
      const holder = document.createElement('div');
      holder.className = 'ea-group-holder';
      anchor.insertAdjacentElement('afterend', holder);
      attachChooser(
        holder,
        label || '(opciones)',
        () => inputs.map((i) => optionLabel(i)),
        (res) => {
          const idxs = isCheckbox ? res.indexes || [res.index] : [res.index];
          for (const i of idxs) {
            const input = inputs[i];
            if (!input) continue;
            if (!input.checked) {
              input.checked = true;
              input.dispatchEvent(new Event('click', { bubbles: true }));
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            (input.closest('label') || input).classList.add(FILLED_CLASS);
          }
        },
        isCheckbox
      );
    }
  }

  // -------------------------------------------------------------------------
  // CV → siempre manual
  // -------------------------------------------------------------------------

  function markFileInputs(root) {
    for (const input of root.querySelectorAll('input[type="file"]')) {
      if (processed.has(input)) continue;
      processed.add(input);
      const badge = document.createElement('div');
      badge.className = 'ea-file-badge';
      badge.textContent = '📎 Subí este archivo a mano (el navegador no permite que lo haga por vos)';
      const anchor = isVisible(input) ? input : input.closest('div') || input;
      anchor.insertAdjacentElement('afterend', badge);
    }
  }

  // -------------------------------------------------------------------------
  // Orquestación
  // -------------------------------------------------------------------------

  let scanTimer = null;
  async function scan(announce) {
    if (!profile) {
      const store = await chrome.storage.local.get('profile');
      profile = store.profile || {};
    }
    const root = document;
    const filled = fillHardFields(root);
    processQuestions(root);
    processSelects(root);
    processRadioAndCheckboxGroups(root);
    markFileInputs(root);
    if (filled > 0) toast(`completé ${filled} campo${filled > 1 ? 's' : ''} con tus datos — revisalos`);
    else if (announce && !Object.keys(profile).length) toast('configurá tu perfil en Ajustes para que pueda rellenar');
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(false), 600);
  }

  const observer = new MutationObserver((muts) => {
    if (muts.some((m) => m.addedNodes.length)) scheduleScan();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'EA_REFILL') {
      profile = null; // recargar perfil por si cambió
      jobContext = null;
      scan(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg?.type === 'EA_STATUS') {
      sendResponse({ site: 'ats', host: location.hostname });
    }
  });

  scan(true);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
