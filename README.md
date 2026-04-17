# Bruno Lab — Agentes de IA para WhatsApp de clínicas 🤖

Motor multi-tenant que conecta WhatsApp Business (vía **Kapso**) con **Gemini** y **Supabase** para atender, calificar y **agendar pacientes 24/7** sin reemplazar a la recepción de la clínica.

> **Producto:** Bruno Lab vende el agente como servicio (Starter $99 USD/mes, hasta 200 conversaciones). Plan comercial completo en `commercial/`.

---

## 🧠 Los tres agentes, un solo webhook

Todos los mensajes entrantes de Kapso llegan a `/webhook` y se enrutan según a qué tenant pertenece el número y quién escribe:

```
webhook Kapso
     │
     ▼
companies.getByWaPhone(phoneNumberId)
     │
     ├─ company.kind = 'platform'      →  ❶ SuperAdmin (Bruno)
     │
     ├─ staff.findByPhone(from) match  →  ❷ Admin (clínica)
     │
     └─ default                        →  ❸ Público (paciente)
```

| # | Agente | A quién atiende | Qué hace |
|---|---|---|---|
| ❶ | **Bruno (SuperAdmin)** | Prospectos del WhatsApp comercial de Bruno Lab | Califica, vende, cierra y **hace el onboarding completo** (crea tenant, envía link Kapso, conecta Google Calendar). |
| ❷ | **Admin** | Staff/owner de una clínica cliente | Onboarding guiado en 6 bloques + CRUD de tratamientos, staff, agente, citas. |
| ❸ | **Público** | Pacientes y leads de la clínica | Responde, califica, agenda en Google Calendar y escala a humano según reglas. |

Detalle completo en `docs/AGENTS_ARCHITECTURE.md`.

---

## 🛠️ Stack

- **Node.js + TypeScript** · servidor Express con webhook único.
- **Supabase (PostgreSQL)** · todo el dominio vive en el esquema **`clinicas`** (multi-tenant). El esquema `public` pertenece a otro proyecto y no se toca.
- **Google Gemini** vía **Vercel AI SDK** · generación + tool-calling + soporte multimodal (imagen, audio, PDF).
- **Kapso** · WhatsApp Cloud API (entrada y salida).
- **Google Calendar API** · agenda por staff, OAuth por owner.
- **Vitest** · tests unitarios e integración.

---

## 📁 Estructura

```
src/
  index.ts                     · bootstrap Express
  controllers/webhook.*        · router de los 3 agentes
  services/
    ai.service.ts              · generarRespuesta{SuperAdmin|Admin|Clinicas|Onboarding}
    db.service.ts              · acceso Supabase (schema 'clinicas')
    kapso.service.ts           · envío WhatsApp
    media.service.ts           · descarga/optimización multimedia
    prompt-compiler.service.ts · compila el system_prompt del agente público
    log.service.ts             · logs_eventos (observabilidad)
  tools/
    bruno-onboarding.tools.ts  · start_onboarding, send_kapso_connection_link…
    bruno-commercial.tools.ts  · notifyStaff (escalamiento humano)
    clinicas-admin.tools.ts    · CRUD completo del tenant
    clinicas.tools.ts          · tools públicas (agendar, consultar, escalar)
    send-html.tool.ts          · documentos HTML enriquecidos por WhatsApp
  skills/                      · skills configurables del agente paciente
sql/                           · migraciones (todas sobre schema 'clinicas')
commercial/                    · playbooks de venta, onboarding, referidos
docs/                          · arquitectura, logging, pendientes
scripts/testing/               · seed y smoke tests
```

---

## ⚙️ Variables de entorno

| Variable | Uso |
|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Acceso al schema `clinicas`. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini. |
| `KAPSO_API_URL` / `KAPSO_API_TOKEN` / `KAPSO_WEBHOOK_SECRET` | WhatsApp Cloud API. |
| `KAPSO_ONBOARDING_URL` | Embedded signup de Meta (link que Bruno envía al owner). |
| `BRUNO_LAB_COMPANY_ID` | UUID del tenant `kind='platform'` (Bruno Lab). |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | OAuth de Google Calendar para staff. |
| `PORT` | Default 3000. |

---

## 🚀 Puesta en marcha

```bash
npm install
npm run dev        # nodemon + ts-node
npm run build      # tsc
npm start          # dist/index.js
npm test           # vitest
```

Despliegue: el repo está preparado para **Railway** (detecta `npm start` automáticamente). Cualquier host con Node ≥ 20 funciona.

### Migraciones SQL

Los scripts de `sql/` aplican **solo sobre `clinicas`**. Aplicar en orden lógico (ver `sql/README.md`). Tras aplicar, marcar la fila de Bruno Lab:

```sql
UPDATE clinicas.companies
   SET kind = 'platform'
 WHERE id = '<BRUNO_LAB_COMPANY_ID>';
```

---

## 📚 Documentación

- `docs/AGENTS_ARCHITECTURE.md` — taxonomía de agentes, detección, tools por capa.
- `docs/LOGGING.md` — observabilidad con `logs_eventos`.
- `docs/PENDIENTES.md` — backlog técnico activo.
- `commercial/BRUNO_AGENTE_COMERCIAL.md` — playbook de venta + onboarding (fuente del system prompt de Bruno).
- `commercial/GUERRILLA_GROWTH.md`, `GUION_DE_VENTAS_frio.md`, `REFERRAL_PROGRAM.md`, `UNIT_ECONOMICS.md` — estrategia comercial.

---

**Generamos más que energía.** ☀️
