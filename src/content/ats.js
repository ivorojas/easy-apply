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
    // Fallback SOLO si la página parece un aviso de verdad (no la página del
    // formulario). Así no guardamos ni usamos "basura" como contexto.
    if (!description) {
      const body = (document.querySelector('main') || document.body).innerText || '';
      if (looksLikePosting(body)) description = body;
    }

    jobContext = {
      title: title || document.title,
      company,
      description: description.replace(/\s+\n/g, '\n').slice(0, 8000),
      url: location.href
    };
    return jobContext;
  }

  const POSTING_SIGNALS = /(responsib|requirement|qualificat|what you.?ll do|what you will do|about the (role|job|position)|nice to have|we are looking|who you are|responsabilidad|requisito|qu[eé] har[aá]s|sobre el (rol|puesto|cargo)|buscamos|perfil buscado|beneficios|benefits|apply now|postul)/i;

  function looksLikePosting(text) {
    const d = (text || '').trim();
    if (d.length < 500) return false;
    if (POSTING_SIGNALS.test(d)) return true;
    return /greenhouse\.io|lever\.co|ashby|workable|smartrecruiters|bamboohr|myworkday|jobs|careers|empleo|trabaj/i.test(location.hostname + location.pathname);
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
      if (key === 'phone') {
        fillPhone(el, String(value));
      } else {
        setNativeValue(el, String(value));
        el.classList.add(FILLED_CLASS);
      }
      filled++;
    }
    return filled;
  }

  // --- Teléfono: contempla campos con "country picker" (banderita) -----------

  // Códigos de país frecuentes (sin +). Se prueba el prefijo más largo primero.
  const DIAL_CODES = {
    '1': { iso: 'us', name: 'Estados Unidos / Canadá' },
    '34': { iso: 'es', name: 'España' },
    '44': { iso: 'gb', name: 'Reino Unido' },
    '33': { iso: 'fr', name: 'Francia' },
    '39': { iso: 'it', name: 'Italia' },
    '49': { iso: 'de', name: 'Alemania' },
    '351': { iso: 'pt', name: 'Portugal' },
    '52': { iso: 'mx', name: 'México' },
    '54': { iso: 'ar', name: 'Argentina' },
    '55': { iso: 'br', name: 'Brasil' },
    '56': { iso: 'cl', name: 'Chile' },
    '57': { iso: 'co', name: 'Colombia' },
    '58': { iso: 've', name: 'Venezuela' },
    '51': { iso: 'pe', name: 'Perú' },
    '591': { iso: 'bo', name: 'Bolivia' },
    '593': { iso: 'ec', name: 'Ecuador' },
    '595': { iso: 'py', name: 'Paraguay' },
    '598': { iso: 'uy', name: 'Uruguay' },
    '502': { iso: 'gt', name: 'Guatemala' },
    '503': { iso: 'sv', name: 'El Salvador' },
    '504': { iso: 'hn', name: 'Honduras' },
    '505': { iso: 'ni', name: 'Nicaragua' },
    '506': { iso: 'cr', name: 'Costa Rica' },
    '507': { iso: 'pa', name: 'Panamá' },
    '509': { iso: 'ht', name: 'Haití' },
    '61': { iso: 'au', name: 'Australia' },
    '91': { iso: 'in', name: 'India' },
    '86': { iso: 'cn', name: 'China' },
    '81': { iso: 'jp', name: 'Japón' },
    '82': { iso: 'kr', name: 'Corea del Sur' },
    '27': { iso: 'za', name: 'Sudáfrica' },
    '971': { iso: 'ae', name: 'Emiratos Árabes' },
    '972': { iso: 'il', name: 'Israel' },
    '31': { iso: 'nl', name: 'Países Bajos' },
    '46': { iso: 'se', name: 'Suecia' },
    '48': { iso: 'pl', name: 'Polonia' },
    '353': { iso: 'ie', name: 'Irlanda' }
  };

  function parsePhone(raw) {
    const trimmed = raw.trim();
    const hasPlus = trimmed.startsWith('+');
    const digits = trimmed.replace(/[^\d]/g, '');
    if (hasPlus) {
      for (const len of [3, 2, 1]) {
        const code = digits.slice(0, len);
        if (DIAL_CODES[code]) {
          return { dial: code, ...DIAL_CODES[code], national: digits.slice(len), full: trimmed };
        }
      }
    }
    return { dial: '', iso: '', name: '', national: digits, full: trimmed };
  }

  // Detecta el widget intl-tel-input (el más común) alrededor del input.
  function findItiContainer(el) {
    return el.closest('.iti, .intl-tel-input, .react-tel-input, [class*="phone-input"]');
  }

  function selectItiCountry(container, iso, dial) {
    // intl-tel-input: <li class="iti__country" data-country-code="ar">
    let li =
      container.querySelector(`li.iti__country[data-country-code="${iso}"]`) ||
      container.querySelector(`li[data-country-code="${iso}"]`) ||
      [...container.querySelectorAll('li.iti__country, li[data-dial-code]')].find(
        (l) => (l.getAttribute('data-dial-code') || l.querySelector('.iti__dial-code')?.textContent || '').replace(/\D/g, '') === dial
      );
    if (!li) return false;
    // Abrir el selector y elegir (clickear está permitido en ATS; nunca "enviar").
    const opener = container.querySelector('.iti__selected-flag, .iti__selected-country, .selected-flag');
    if (opener) opener.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    li.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  }

  // Un <select> hermano de países/códigos (elige, no escribe).
  function findCountrySelect(el) {
    const scope = el.closest('.field, .application-question, [class*="phone"], div') || el.parentElement;
    if (!scope) return null;
    for (const sel of scope.querySelectorAll('select')) {
      const txt = sel.textContent;
      if (/\+\d|argentin|country|pa[ií]s|c[oó]digo/i.test(txt)) return sel;
    }
    return null;
  }

  function selectCountryInSelect(sel, info) {
    const opts = [...sel.querySelectorAll('option')];
    const want = opts.find((o) => {
      const t = (o.textContent + ' ' + o.value).toLowerCase();
      return (info.dial && t.replace(/\D/g, '').includes(info.dial)) || (info.name && t.includes(info.name.toLowerCase().split(' ')[0])) || (info.iso && o.value.toLowerCase() === info.iso);
    });
    if (!want) return false;
    setNativeValue(sel, want.value);
    return true;
  }

  function fillPhone(el, value) {
    const info = parsePhone(value);
    const iti = findItiContainer(el);
    const countrySelect = !iti ? findCountrySelect(el) : null;

    if (iti && info.iso) {
      const ok = selectItiCountry(iti, info.iso, info.dial);
      setNativeValue(el, ok ? info.national : info.full);
      el.classList.add(FILLED_CLASS);
      if (!ok) phoneBadge(el, info); // no pudimos elegir la bandera: avisamos
      return;
    }
    if (countrySelect && info.iso) {
      const ok = selectCountryInSelect(countrySelect, info);
      if (ok) countrySelect.classList.add(FILLED_CLASS);
      setNativeValue(el, ok ? info.national : info.full);
      el.classList.add(FILLED_CLASS);
      if (!ok) phoneBadge(el, info);
      return;
    }
    // Campo simple: número completo tal cual lo guardaste.
    setNativeValue(el, info.full);
    el.classList.add(FILLED_CLASS);
    // Si detectamos una banderita que no supimos operar, avisamos.
    if ((iti || /flag|country|bandera/i.test((el.parentElement?.className || '') + (el.closest('div')?.className || ''))) && info.name) {
      phoneBadge(el, info);
    }
  }

  function phoneBadge(el, info) {
    el.parentElement?.querySelector('.ea-phone-badge')?.remove();
    const badge = document.createElement('div');
    badge.className = 'ea-file-badge ea-phone-badge';
    badge.textContent = `📞 Elegí el país en la banderita a mano: ${info.name || 'tu país'}${info.dial ? ` (+${info.dial})` : ''}. Dejé el número sin el código.`;
    el.insertAdjacentElement('afterend', badge);
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
  // Lectura de campos para el panel (dar respuestas para copiar en cualquier sitio)
  // -------------------------------------------------------------------------

  function collectFields() {
    const questions = [];
    const seen = new Set();
    const add = (label, kind, options, maxLength, value) => {
      const clean = (label || '').replace(/\s+/g, ' ').trim();
      if (!clean || clean.length < 2) return;
      const dedup = clean + '|' + kind;
      if (seen.has(dedup)) return;
      seen.add(dedup);
      questions.push({ label: clean, kind, options: options || null, maxLength: maxLength || null, value: value || '' });
    };

    for (const el of document.querySelectorAll('textarea, input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type])')) {
      if (!isVisible(el)) continue;
      const label = getLabelText(el);
      const hard = el.tagName !== 'TEXTAREA' && matchHardField(el, label);
      const kind = el.tagName === 'TEXTAREA' ? 'texto largo' : hard ? 'dato' : 'texto';
      add(label, kind, null, el.maxLength > 0 ? el.maxLength : null, el.value);
    }
    for (const sel of document.querySelectorAll('select')) {
      if (!isVisible(sel)) continue;
      const options = [...sel.querySelectorAll('option')].map((o) => o.textContent.trim()).filter(Boolean);
      if (options.length) add(getLabelText(sel), 'selección', options, null, sel.value);
    }
    const byName = new Map();
    for (const input of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      if (!isVisible(input)) continue;
      const name = input.getAttribute('name') || '__anon__' + (input.closest('fieldset, div')?.className || '');
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(input);
    }
    for (const [, inputs] of byName) {
      if (inputs.length < 1) continue;
      add(groupLabel(inputs), inputs[0].type === 'checkbox' ? 'casillas' : 'opciones', inputs.map((i) => optionLabel(i)), null, '');
    }
    return { questions, jobContext: extractJobContext() };
  }

  // -------------------------------------------------------------------------
  // Botón flotante (para que siempre haya un control visible)
  // -------------------------------------------------------------------------

  function hasForms() {
    return !!document.querySelector('input, textarea, select');
  }

  let fab = null;
  function ensureFab() {
    if (window.top !== window) return; // solo en la ventana principal
    if (fab || !hasForms()) return;
    fab = document.createElement('div');
    fab.className = 'ea-fab';
    fab.innerHTML = '<button class="ea-fab-btn" title="Easy Apply: rellenar esta página">✨ Rellenar</button>';
    fab.querySelector('button').addEventListener('click', async () => {
      profile = null;
      jobContext = null;
      const n = await scan(true);
      if (!n) toast('no encontré datos tuyos para poner — cargá tu perfil en Ajustes (clic derecho en el ícono → Opciones)');
    });
    document.documentElement.appendChild(fab);
  }

  // -------------------------------------------------------------------------
  // Orquestación
  // -------------------------------------------------------------------------

  // Guarda el aviso si esta página tiene una descripción jugosa, para tenerlo
  // disponible cuando el formulario esté en otra página/paso/pop-up.
  let jobSaved = false;
  function saveJobIfStrong() {
    if (jobSaved || window.top !== window) return;
    const ctx = extractJobContext();
    if ((ctx.description || '').trim().length >= 250) {
      jobSaved = true;
      chrome.runtime.sendMessage({ type: 'SAVE_JOB', jobContext: ctx }).catch(() => {});
    }
  }

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
    ensureFab();
    saveJobIfStrong();
    const topFrame = window.top === window;
    if (filled > 0) toast(`completé ${filled} campo${filled > 1 ? 's' : ''} con tus datos — revisalos`);
    else if (announce && topFrame && !Object.keys(profile).length) {
      toast('cargá tu perfil en Ajustes (clic derecho en el ícono ✨ → Opciones) para que pueda rellenar');
    } else if (announce && topFrame && filled === 0 && hasForms()) {
      toast('no encontré datos tuyos para estos campos — usá el botón ✨ IA de cada pregunta o el panel para respuestas');
    }
    return filled;
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
      scan(true).then((n) => sendResponse({ ok: true, filled: n }));
      return true;
    }
    if (msg?.type === 'EA_READ') {
      try {
        const data = collectFields();
        if (!data.questions.length) return; // que responda otro frame con campos
        sendResponse(data);
      } catch (e) {
        sendResponse({ error: e.message });
      }
      return true;
    }
    if (msg?.type === 'EA_STATUS') {
      sendResponse({ site: 'ats', host: location.hostname });
    }
  });

  scan(true);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
