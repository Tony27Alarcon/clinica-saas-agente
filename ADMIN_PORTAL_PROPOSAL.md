# Portal Admin — Propuesta de Arquitectura
## MedAgent · Admin Dashboard

> **TL;DR:** La propuesta de Magic Links tiene la dirección correcta pero usa la herramienta equivocada.
> Supabase Auth ya resuelve esto en 2 líneas. El problema real no es el auth — es que no sabemos qué construir después de que el admin se loguea.

---

## Parte 1 — Crítica a la Propuesta Anterior

### Lo que está bien ✓
- Flujo sin contraseña vía WhatsApp es la decisión correcta para el contexto de clínicas LATAM
- Token de uso único con expiración es el estándar correcto
- Identificar que Next.js + Supabase ya están en el stack es pragmático

### Los problemas reales ✗

#### Problema 1 — Reinventar lo que ya existe
La propuesta crea una tabla `admin_magic_links` con UUID, `expires_at`, `is_used`.
**Esto ya existe.** Supabase Auth tiene Magic Links nativos:

```typescript
// Lo que propone la propuesta anterior (200+ líneas de código custom):
// INSERT INTO admin_magic_links (token, admin_id, expires_at) VALUES (...)
// SELECT * FROM admin_magic_links WHERE token = ? AND is_used = false AND expires_at > NOW()
// UPDATE admin_magic_links SET is_used = true WHERE token = ?
// + lógica de cookies custom + manejo de sesión manual

// Lo que Supabase hace en 2 líneas:
const { data } = await supabase.auth.admin.generateLink({
  type: 'magiclink',
  email: admin.email,
});
// → data.properties.action_link  (token seguro, expira en 1h, uso único)
```

El código custom introduce:
- Superficie de ataque mayor (lógica de validación manual)
- Sin integración con JWT → RLS de Supabase no funciona
- Mantenimiento de un sistema de sesiones paralelo

#### Problema 2 — Multi-tenant ignorado
El proyecto usa `company_id` para aislar datos entre clínicas (RLS en schema `clinicas`).
La propuesta no responde: **¿cómo sabe el portal a qué clínica pertenece la sesión?**

Sin esto, un admin podría acceder a datos de otra clínica.
La solución correcta requiere que `company_id` viaje en el JWT como `user_metadata`.

#### Problema 3 — El auth no es el producto
La propuesta se enfoca completamente en autenticación y dedica cero palabras a
**qué hace el admin una vez adentro**. El portal admin *es* el producto — el auth es solo la puerta.

---

## Parte 2 — Propuesta: MedAgent Admin Portal

### Filosofía de Diseño

El agente IA ya puede hacer todo: buscar contactos, ver citas, responder pacientes.
El portal admin **no reemplaza al agente** — le da a la clínica visibilidad y control
sobre lo que el agente está haciendo.

```
Agente IA (WhatsApp)      →   opera 24/7 de forma autónoma
Portal Admin (Web/PWA)    →   monitor, override, configuración
```

---

### Arquitectura de Autenticación (Revisada)

#### Stack: Supabase Auth + Magic Link + WhatsApp delivery

```
[Admin escribe "panel" al agente IA]
          ↓
[Backend genera magic link via Supabase Auth]
    supabase.auth.admin.generateLink({ type: 'magiclink', email })
          ↓
[Backend envía link por WhatsApp via Kapso]
    kapsoService.sendMessage(adminPhone, "Accede al panel: https://...")
          ↓
[Admin toca el link en WhatsApp]
          ↓
[Next.js /auth/callback captura el token de Supabase]
    supabase.auth.exchangeCodeForSession(code)
          ↓
[Supabase valida, genera JWT con company_id en user_metadata]
          ↓
[Middleware Next.js verifica JWT en cada ruta /admin/*]
          ↓
[Todas las queries a Supabase heredan el contexto de company_id]
```

#### Tabla de usuarios admin (nueva, en schema `clinicas`)

```sql
-- Los "admins" son staff con rol elevado
ALTER TABLE clinicas.staff ADD COLUMN IF NOT EXISTS
  supabase_user_id UUID REFERENCES auth.users(id),
  role TEXT DEFAULT 'staff' CHECK (role IN ('owner', 'admin', 'staff'));

-- Al crear el magic link, se pasa company_id en metadata
-- Supabase lo embebe en el JWT → RLS lo lee automáticamente
```

---

### El Portal — 4 Vistas, No Más

Para el MVP que valida con una clínica real, el portal tiene exactamente 4 pantallas.
Cada una resuelve un dolor que el agente no puede resolver solo.

---

#### Vista 1 — `/admin` — Pulso del Día

**El problema que resuelve:** La clínica no sabe qué está pasando en tiempo real sin revisar WhatsApp uno por uno.

```
┌─────────────────────────────────────────────────────────┐
│  Hoy · Jueves 10 abril                      ● En vivo  │
├──────────────┬──────────────┬──────────────┬────────────┤
│  8 citas     │  3 leads     │  2 no-shows  │  94% resp  │
│  confirmadas │  calificados │  en riesgo   │  del agente│
├─────────────────────────────────────────────────────────┤
│  PRÓXIMAS CITAS                                         │
│  10:00  Ana Martínez  · Botox facial    · Confirmada ✓  │
│  11:30  Carla Ruiz    · Hydrafacial     · Sin respuesta ⚠│
│  14:00  Laura Gómez   · Relleno labial  · Confirmada ✓  │
├─────────────────────────────────────────────────────────┤
│  CONVERSACIONES ACTIVAS          [Ver todo]             │
│  📱 Mónica López  "¿tienen disponible el viernes?"      │
│  📱 Sandra Torres  "¿cuánto cuesta el botox?"           │
└─────────────────────────────────────────────────────────┘
```

**Datos:** `getDailySummary` + `getUpcomingAppointments` (ya existen en `clinicas-admin.tools.ts`)

---

#### Vista 2 — `/admin/agenda` — Control de Citas

**El problema que resuelve:** El agente agenda bien, pero la clínica necesita mover/cancelar citas sin hablarle al agente.

```
┌─────────────────────────────────────────────────────────┐
│  Semana del 7 al 13 abril              [← Anterior]    │
├──────┬──────────┬──────────┬──────────┬────────────────┤
│      │  Lun 7   │  Mar 8   │  Mié 9   │   Jue 10  ...  │
├──────┼──────────┼──────────┼──────────┼────────────────┤
│ 9am  │          │ Ana M.   │          │  Carla R.      │
│      │          │ Botox ✓  │          │  Hydra ⚠       │
├──────┼──────────┼──────────┼──────────┼────────────────┤
│10am  │ Laura G. │          │ Paula S. │                │
│      │ Relleno✓ │          │ Láser ✓  │                │
└──────┴──────────┴──────────┴──────────┴────────────────┘

[Click en cita] → Panel lateral:
  · Confirmar / Cancelar / Reagendar
  · Notas internas
  · Historial del paciente
  · Enviar recordatorio manual por WhatsApp
```

**Datos:** `getUpcomingAppointments`, `getFreeSlots`, `updateAppointmentStatus`

---

#### Vista 3 — `/admin/contactos` — CRM Mínimo

**El problema que resuelve:** Los leads llegan por WhatsApp pero no hay forma de ver el pipeline completo.

```
┌─────────────────────────────────────────────────────────┐
│  Contactos  [Buscar...]                [Filtrar ▼]     │
├─────────────────────────────────────────────────────────┤
│  Estado: Lead calificado  (12)                          │
│  ● Ana M.  "interesada en botox, pide precio"  Hoy 10am │
│  ● Sofía R. "quiere agendar pero no confirma"  Ayer 3pm │
│                                                         │
│  Estado: Paciente activa  (34)                          │
│  ● Carla R.  2 citas historial  Última: 5 abr           │
│  ● Laura G.  5 citas historial  Última: 10 abr          │
├─────────────────────────────────────────────────────────┤
│  [Click contacto] → Perfil completo:                   │
│  · Historial de conversaciones                          │
│  · Tratamientos realizados                              │
│  · Próxima cita                                         │
│  · Historia clínica (PDF si ya la completó)             │
│  · [Enviar mensaje] — abre chat directo                 │
└─────────────────────────────────────────────────────────┘
```

**Datos:** `searchContacts`, `getContactSummary`, `sendMessageToPatient`

---

#### Vista 4 — `/admin/agente` — Configuración del Agente IA

**El problema que resuelve:** La clínica necesita personalizar el agente sin pedirle a un desarrollador.

```
┌─────────────────────────────────────────────────────────┐
│  Mi Agente                                              │
├─────────────────────────────────────────────────────────┤
│  Nombre del agente:  [Sofía              ]              │
│  Tono de voz:        ○ Profesional  ● Cálido  ○ Directo │
│                                                         │
│  Presentación:                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Hola, soy Sofía de Clínica Aurora. Estoy aquí    │  │
│  │ para ayudarte a agendar tu consulta...            │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Horario de atención:  Lun-Vie 9am - 7pm               │
│  Fuera de horario:     [Mensaje personalizado]          │
│                                                         │
│  Escalación a humano:  ● Activado                       │
│  Palabra clave:        "hablar con alguien"             │
│                                                         │
│  Tratamientos activos:                                  │
│  ✓ Botox facial  ✓ Hydrafacial  ✓ Relleno labial        │
│  + Agregar tratamiento                                  │
│                                                         │
│                              [Guardar cambios]         │
└─────────────────────────────────────────────────────────┘
```

**Datos:** Tabla `clinicas.agents`, endpoint `/internal/rebuild-prompt/:companyId`

---

### Diseño Visual — Estilo Consistente con la Landing

El portal hereda el sistema de diseño del landing (`bruno_lab_landing/`):

| Token         | Landing               | Portal Admin          |
|---------------|----------------------|-----------------------|
| Font display  | Epilogue 700/800     | Epilogue 700 (headers) |
| Font body     | Outfit 400/500       | Outfit 400/500        |
| Background    | `#0a0a0a` negro      | `#0f0f0f` (sidebar dark) + `#161616` (content) |
| Accent        | Verde `#22c55e`      | Verde `#22c55e` (status online, acciones primarias) |
| Warning       | —                    | Ámbar `#f59e0b` (citas sin confirmar, leads fríos) |
| Danger        | —                    | Rojo `#ef4444` (no-shows, errores) |
| Border        | subtle white 8%      | `rgba(255,255,255,0.08)` |
| Radius        | 12px                 | 8px (más utilitario, menos marketing) |

**Principio:** La landing vende el producto. El portal *es* el producto — mismo lenguaje visual, menos dramatismo, más densidad de información.

---

### Plan de Implementación (3 Sprints)

#### Sprint 1 — Auth (2-3 días)
```
1. Activar Supabase Auth en el proyecto
2. Agregar supabase_user_id + role a clinicas.staff
3. Endpoint POST /auth/request-link:
   - Recibe phone o email del admin
   - Busca en clinicas.staff
   - Genera link con supabase.auth.admin.generateLink()
   - Envía por WhatsApp via Kapso
4. Ruta Next.js /auth/callback:
   - exchangeCodeForSession(code)
   - Guarda session en cookie
   - Redirect a /admin
5. Middleware en web/middleware.ts:
   - Protege todas las rutas /admin/*
   - Verifica sesión válida
```

#### Sprint 2 — Vista Pulso + Agenda (3-4 días)
```
1. API routes en Next.js:
   - GET /api/admin/dashboard    → getDailySummary
   - GET /api/admin/appointments → getUpcomingAppointments
   - PATCH /api/admin/appointments/:id → updateAppointmentStatus
2. Componentes UI:
   - <MetricCard /> (citas, leads, no-shows)
   - <AppointmentRow /> con acciones inline
   - <CalendarWeek /> para vista de agenda
3. Autenticación en cada API route (verifica JWT + company_id)
```

#### Sprint 3 — Contactos + Configuración del Agente (3-4 días)
```
1. API routes:
   - GET /api/admin/contacts      → searchContacts
   - GET /api/admin/contacts/:id  → getContactSummary
   - PUT /api/admin/agent         → actualiza clinicas.agents
   - POST /api/admin/agent/rebuild → POST /internal/rebuild-prompt
2. Componentes:
   - <ContactList /> con filtros por estado
   - <ContactProfile /> panel lateral
   - <AgentSettings /> formulario de configuración
```

---

### Estructura de Archivos (lo que se crea)

```
web/
├── app/
│   ├── auth/
│   │   ├── callback/
│   │   │   └── route.ts          # Intercambia code por session
│   │   └── error/
│   │       └── page.tsx          # Link expirado / error
│   ├── admin/
│   │   ├── layout.tsx            # Sidebar + nav, protegido
│   │   ├── page.tsx              # Dashboard (Vista 1)
│   │   ├── agenda/
│   │   │   └── page.tsx          # Vista 2
│   │   ├── contactos/
│   │   │   ├── page.tsx          # Lista (Vista 3)
│   │   │   └── [id]/page.tsx     # Perfil individual
│   │   └── agente/
│   │       └── page.tsx          # Configuración (Vista 4)
│   └── api/
│       └── admin/                # API routes protegidas
│           ├── dashboard/route.ts
│           ├── appointments/route.ts
│           ├── contacts/route.ts
│           └── agent/route.ts
├── middleware.ts                 # Protección de rutas /admin/*
└── lib/
    └── supabase-server.ts        # Client con cookies (SSR)

src/                              # Backend existente
└── routes/
    └── auth.routes.ts            # POST /auth/request-link (nuevo)
```

---

### Decisiones Que Se Toman Ahora

| Decisión | Opción A | Opción B | **Recomendación** |
|----------|----------|----------|-------------------|
| Auth provider | Custom tokens (propuesta anterior) | Supabase Auth nativo | **Supabase Auth** |
| Trigger del magic link | Solo desde portal web | Desde el agente IA por WhatsApp | **Agente IA** (ya habla con el admin) |
| Sesión en frontend | Cookie custom firmada | Cookie de Supabase Auth | **Supabase** (integra con RLS) |
| PWA o Web | Web pura | PWA (instalable) | **PWA** (clínicas usan móvil) |
| Stack de componentes | Instalar shadcn/radix | CSS propio (como la landing) | **CSS propio primero** (menos deps) |
| Deploy | Mismo Railway | Vercel (Next.js optimizado) | **Vercel** (mejor DX para Next.js) |

---

### Lo Que No Se Construye (aún)

- Sistema de pagos / billing dentro del portal
- Estadísticas históricas y reportes
- Multi-staff (cada doctor con su login)
- Notificaciones push
- Modo "sin agente" (gestión manual de chats)

Todo esto puede venir después. El MVP es: **la clínica ve qué está pasando y puede intervenir cuando necesita.**

---

*Propuesta generada: Abril 2026 · MedAgent v0.1 MVP*
