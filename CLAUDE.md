# CLAUDE.md — Easy Apply

Contexto para Claude Code al trabajar en este repo. Extensión de navegador
(Manifest V3) que rellena postulaciones de trabajo: datos duros en automático y
preguntas únicas con IA (Gemini). **Nunca envía nada solo; nunca inventa.**

## Reglas de producto INQUEBRANTABLES (del brief)

Antes de tocar cualquier cosa, estas reglas mandan sobre cualquier "mejora":

1. **Nunca auto-envía.** Ni un click a enviar / siguiente / aplicar. La extensión
   rellena y sugiere; el submit final es del usuario, siempre.
2. **Nunca inventa.** Si el perfil no tiene con qué responder, devuelve
   `{"no_info": true}` y el campo queda vacío. Un campo vacío es mejor que una
   respuesta inventada.
3. **LinkedIn = modo pasivo, sin excepción.** En `src/content/linkedin.js` está
   PROHIBIDO: escribir en campos, clickear, hacer fetch/XHR a LinkedIn, o
   modificar el DOM. Solo puede LEER texto visible, y solo en modo "assistant".
   Cualquier cambio que rompa esto es un bug crítico (riesgo de baneo del usuario).
4. **Menús/radios/checkboxes se ELIGEN, no se escriben.** Nunca texto libre donde
   solo se puede seleccionar.
5. **El CV no se sube por código** (barrera del navegador). Se marca "subilo a mano".
6. **Respetar el límite de caracteres** de cada campo (`maxLength`).

## Arquitectura

```
manifest.json          MV3. Campo `key` fija el ID: abgfpmgoacojapfgchfgmbhilckahgcl
src/background.js       Service worker (module). TODA llamada a Gemini vive acá.
                        Caché, similitud de preguntas (Jaccard), chequeo de update.
src/content/ats.js      Content script en TODOS los sitios salvo LinkedIn (match
                        http/https + exclude linkedin). Autofill duro, botón IA por
                        pregunta, chooser de opciones, badge de CV, FAB flotante
                        "✨ Rellenar", lectura de campos para el panel (EA_READ). ea-.
src/content/ats.css     Estilos inyectados (all:initial en botones para no heredar).
src/content/linkedin.js SOLO LECTURA. Modo seguro. Ver regla #3.
src/sidepanel/          Panel lateral: modo seguro LinkedIn + generador manual.
src/popup/              Estado del sitio + botón "Actualizar ahora".
src/options/            Ajustes: datos duros + super memoria (blob) + caché + IA.
updater/                Native messaging host (host.py) = git pull + reload.
docs/BACKEND.md         Diseño futuro de cuentas/sync (Supabase). NO implementado.
```

### Flujo de datos

- **Todo es local**: `chrome.storage.local` con claves `profile`, `settings`,
  `answerCache`, `lastJob`. No hay backend. La API key del usuario vive acá, nunca en el repo.
- **Encendido/apagado global**: flag `enabled` en `chrome.storage.session` (se borra al
  cerrar el navegador → arranca APAGADA cada sesión). Toggle en el popup. Apagada, los
  content scripts quedan dormidos (nada de escanear/rellenar/FAB) y el panel avisa que
  está off. Handlers `GET_ENABLED`/`SET_ENABLED`; background hace broadcast `EA_SET_ENABLED`
  a las pestañas; `ats.js` tiene `activate()/deactivate()`. Badge muestra "ON" en verde.
- **Perfil** = datos duros estructurados (`firstName`, `email`, …) + `blob` (la
  "super memoria") + `cvText`/`cvName` (texto del CV, parseado UNA vez al subir con
  pdf.js vendrado en `vendor/pdf/`) + `docs` (biblioteca ilimitada de PDF/TXT/MD:
  `[{id,name,text,addedAt}]`, cada uno parseado una vez) + `enrichment` (`{github,
  portfolio}` traído de los links). Todo eso entra al contexto de IA vía `profileBlock()`
  (los docs con presupuesto de ~16k chars). `unlimitedStorage` permite guardar sin tope.
  Los datos duros son OPCIONALES (desplegable en options): si el usuario pone todo
  en el blob, la IA responde igual; los campos duros solo alimentan el autofill
  determinístico. `EXTRACT_HARD_FIELDS` los propone desde CV/blob para que el user revise.
- **Mensajería**: content scripts y UI hablan al service worker por
  `chrome.runtime.sendMessage` con `{type: ...}`. Tipos: `GENERATE_ANSWER`,
  `CHOOSE_OPTION`, `SAVE_APPROVED`, `ENRICH_LINK`, `EXTRACT_HARD_FIELDS`,
  `CHECK_UPDATE`, `UPDATE_NOW`, `GET_SETTINGS`.
- **Enriquecimiento de links**: `ENRICH_LINK` en background. GitHub → `api.github.com`
  (bio+repos, host permission fija). Portfolio/web → fetch HTML + `htmlToText()` (pide
  `optional_host_permissions` al dominio en runtime, desde options). **LinkedIn se
  RECHAZA a propósito** (regla #3 + devuelve muro de login): nunca fetchear LinkedIn.
- **Teléfono con country picker** (`fillPhone` en ats.js): parsea `+54…` a dial+ISO,
  detecta intl-tel-input / select de países y ELIGE el país (no escribe); si no puede,
  deja el número sin código y muestra badge de qué bandera tocar. Nunca en LinkedIn.
- **Caché con aprendizaje**: al aprobar, se guarda `{q, a}`. En `GENERATE_ANSWER`,
  similitud ≥0.85 reusa directo; ≥0.35 se pasan como ejemplos de estilo a Gemini.

## IA

- Gemini vía REST (`generativelanguage.googleapis.com`). Modelo default
  `gemini-2.5-flash-lite` (barato y rápido — preferencia del usuario, no cambiar
  sin pedir). Se fuerza `responseMimeType: application/json`.
- Prompts en español, en `background.js`. Siempre incluyen la regla NEVER_INVENT.
- **Idioma de la respuesta**: `detectLang()` decide es/en desde pregunta + descripción
  del aviso y se lo impone al modelo (una postulación en inglés se responde en inglés).
- **Contexto del aviso cross-página**: el aviso y el formulario suelen estar en
  páginas/pasos distintos. `ats.js` guarda el aviso (`lastJob` en storage) cuando ve
  una página que `looksLikePosting()`; `resolveJobContext()` en background usa el
  guardado (si es reciente, <3h) cuando el contexto de la página del formulario es
  flojo. El panel permite capturar/ver/borrar el aviso a mano (`SAVE_JOB/GET_JOB/CLEAR_JOB`).

## Actualización (requisito no-negociable del brief)

- **Código**: `updater/host.py` (native messaging) hace `git pull --ff-only` +
  `chrome.runtime.reload()`. El usuario corre `updater/instalar.bat` UNA vez
  (registra en HKCU, sin admin). Plan B: `actualizar.bat` + botón "Recargar".
- **Chrome prohíbe código remoto y self-hosting**: por eso el update es git pull
  local, no descarga de código ejecutable en runtime. No romper esto.
- Al subir una versión: incrementar `version` en `manifest.json`. El popup compara
  contra el `manifest.json` de `raw.githubusercontent.com/.../main/`.

## Convenciones

- Sin build step, sin dependencias npm. JS vanilla, ES modules en el worker.
- Verificar sintaxis antes de commitear: `node --check <archivo>` en cada JS.
- Todo el texto de UI en español rioplatense (voseo).
- Al agregar un ATS nuevo: sumar `host_permissions`/`content_scripts` matches en
  el manifest y extender `extractJobContext()` en `ats.js`. Selectores de labels
  ya son bastante genéricos; probar contra el ATS real e iterar.
- Repo público: NUNCA commitear API keys ni `.pem`. Ver `.gitignore`.

## Estado (2026-07-02)

v0.3.0 en https://github.com/ivorojas/easy-apply. MVP: Greenhouse + Lever +
LinkedIn seguro. v0.2 sumó: teléfono con country picker, CV parseado (pdf.js),
enriquecimiento de links (GitHub/portfolio), datos duros opcionales/desplegables.
v0.3 sumó: biblioteca ilimitada de documentos extra (`profile.docs`) + `unlimitedStorage`.
v0.4 (fix importante): ats.js ahora corre en TODOS los sitios salvo LinkedIn (antes
solo Greenhouse/Lever — por eso "no funcionaba" en otras páginas). FAB flotante, panel
lee cualquier página vía EA_READ, popup ofrece Rellenar en todo sitio http(s).
Pendiente futuro: más ATS (Ashby, Workable, SmartRecruiters, BambooHR, Workday),
secciones opcionales de memoria, backend Supabase, publicación unlisted.
