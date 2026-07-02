# Backend futuro — cuentas, login y sincronización

Hoy la extensión es **100% local**: perfil, memoria, caché y API key viven en
`chrome.storage.local`. No hace falta backend para usarla. Este documento deja
las bases para cuando se quiera sumar cuenta + sincronización.

## Diseño previsto (Supabase)

- **Auth**: Supabase Auth con **magic link por email** (sin contraseña, sin OAuth
  al principio — lo más simple). La extensión abre una pestaña con la página de
  login y guarda el token de sesión en `chrome.storage.local`.
- **Base de datos** (Postgres + Row Level Security, cada usuario solo ve lo suyo):

```sql
-- Perfil (datos duros + blob de super memoria)
create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  hard_fields jsonb not null default '{}',
  blob text not null default '',
  updated_at timestamptz not null default now()
);

-- Caché de respuestas aprobadas
create table approved_answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  question text not null,
  answer text not null,
  uses int not null default 0,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
alter table approved_answers enable row level security;
create policy "own profile" on profiles for all using (auth.uid() = user_id);
create policy "own answers" on approved_answers for all using (auth.uid() = user_id);
```

- **Sincronización**: last-write-wins con `updated_at`; la fuente primaria sigue
  siendo local (la extensión funciona offline y sin cuenta).
- **La API key de Gemini NUNCA se sube**: cada usuario usa la suya, local.
  (Más adelante se podría ofrecer un proxy con Edge Functions para usuarios sin
  key, pero eso implica pagar el consumo — fuera de alcance por ahora.)

## Nota sobre el plan gratis de Supabase

El límite de **2 proyectos activos gratis es por organización**, no por cuenta
de GitHub. Se puede crear otra organización en la misma cuenta de Supabase (el
mismo login con GitHub) y ahí crear el proyecto de Easy Apply. El login con
GitHub es solo autenticación: el proyecto de Supabase no queda "atado" a ningún
repositorio. Si alguna vez Supabase limitara las organizaciones gratis, la
alternativa es una segunda cuenta registrada con email (no hace falta otra
cuenta de GitHub).
