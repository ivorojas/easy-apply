# ✨ Easy Apply — Autofill de Postulaciones con IA

Extensión de navegador (Chrome / Edge / Chromium, Manifest V3) que hace el trabajo pesado de postularse:

- **Rellena los datos duros en automático, sin IA** (nombre, mail, celu, ubicación, LinkedIn, portfolio, años de experiencia) apenas abrís el formulario.
- **Responde preguntas únicas con IA** (Gemini), usando tu perfil + el aviso del puesto como contexto, con un botón `✨ IA` al lado de cada campo.
- **Elige la opción correcta** en menús, radios y checkboxes (no escribe donde solo se puede seleccionar).
- **"Super memoria" editable**: una caja gigante con toda tu info, de donde la IA saca material.
- **Aprende con el uso**: guarda las respuestas que aprobás y las reutiliza cuando aparece una pregunta parecida.
- **LinkedIn en modo seguro**: panel de copiar/pegar, sin tocar la página, para cero riesgo de baneo.

### Reglas duras (en todos los sitios)

- 🚫 **Nunca aprieta "enviar" / "siguiente" / "aplicar"**. El envío final es tuyo, siempre.
- 🚫 **Nunca inventa.** Si no tiene info tuya para una pregunta, te avisa "no tengo con qué responder esto".
- 🚫 **No automatiza nada en LinkedIn.** No rellena, no clickea, no manda pedidos a sus servidores.
- 🚫 **No sube el CV por vos** (el navegador lo prohíbe); te marca el campo para que lo arrastres a mano.

## Instalación

1. Cloná el repo (o descargalo):
   ```
   git clone https://github.com/ivorojas/easy-apply.git
   ```
2. Abrí `chrome://extensions`, activá **Modo de desarrollador** (arriba a la derecha).
3. Tocá **Cargar extensión sin empaquetar** y elegí la carpeta del repo.
4. Abrí el ícono de la extensión → **Ajustes y memoria**:
   - Pegá tu **API key de Gemini** (gratis en [aistudio.google.com/apikey](https://aistudio.google.com/apikey)). Queda guardada **solo en tu navegador**; no viaja a ningún servidor de terceros salvo Google al generar.
   - Cargá tus **datos duros** y tu **super memoria**.
5. (Recomendado) Doble click a `updater\instalar.bat` **una sola vez** para habilitar la actualización con un botón.

## Actualización (sin reinstalar nunca)

- **Con el actualizador instalado**: popup → **Actualizar ahora**. Hace `git pull` y recarga la extensión sola. Un botón, listo.
- **Plan B manual**: doble click a `actualizar.bat` y después **Recargar extensión** en el popup.
- La extensión chequea GitHub cada 12 h y te marca con un badge rojo cuando hay versión nueva.

## Sitios soportados (v1)

| Sitio | Modo |
|---|---|
| Greenhouse (`boards.greenhouse.io`, `job-boards.greenhouse.io`) | A full: autofill + IA por pregunta |
| Lever (`jobs.lever.co`) | A full: autofill + IA por pregunta |
| LinkedIn | Modo seguro: panel de copiar/pegar (asistente o apagado total) |
| Cualquier otro | Panel con generador manual de respuestas |

Próximos: Ashby, Workable, SmartRecruiters, BambooHR, Workday.

## Privacidad

- Tu perfil, tu memoria, tu caché y tu API key viven en `chrome.storage.local`: **tu navegador, tu máquina**.
- La única red que toca la extensión: Gemini (para generar respuestas) y GitHub (para chequear actualizaciones).
- En LinkedIn: cero escritura, cero clicks, cero pedidos a sus servidores. Solo lectura de texto visible, y podés apagar incluso eso.

## Roadmap

- [ ] Más ATS (Ashby, Workable, SmartRecruiters, BambooHR, Workday).
- [ ] Secciones opcionales de memoria (experiencia, proyectos).
- [ ] Cuenta + login + sincronización en la nube (ver [docs/BACKEND.md](docs/BACKEND.md)).
- [ ] Publicación *unlisted* en Chrome Web Store para auto-update de código.

## Licencia

MIT
