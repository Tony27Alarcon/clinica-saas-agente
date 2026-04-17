# Arquitectura de Agentes

> Taxonomía de los agentes del sistema, cómo se enrutan los mensajes y dónde vive cada pieza en el código.

Tres agentes, un solo webhook, un árbol de decisión único:

```
webhook Kapso
      │
      ▼
companies.getByWaPhone(phoneNumberId)
      │
      ├─ company.kind = 'platform'    →  ❶ SuperAdmin (Bruno)
      │
      ├─ staff.findByPhone(from) matcha→  ❷ Admin (clínica)
      │
      └─ default                      →  ❸ Público (paciente)
```

---

## ❶ SuperAdmin — *Bruno*

| | |
|---|---|
| **A quién atiende** | Prospectos del WhatsApp comercial de Bruno Lab. |
| **Tenant** | Una sola `companies` con `kind='platform'` (Bruno Lab). |
| **Quién lo invoca** | `WebhookController.processSuperAdminEvent` → `AiService.generarRespuestaSuperAdmin`. |
| **System prompt** | Hardcoded en el método (basado en `commercial/BRUNO_AGENTE_COMERCIAL.md`). |
| **Tools disponibles** | `start_onboarding`, `send_kapso_connection_link`, `connect_google_calendar_owner`, `configure_availability`, `notifyStaff`. |
| **Archivos** | `src/tools/bruno-onboarding.tools.ts`, `src/tools/bruno-commercial.tools.ts`. |

**Responsabilidades:**
1. Califica al prospecto (§2 del playbook: tipo de negocio, volumen/dolor, decisor).
2. Maneja objeciones (§9).
3. Cuando el prospecto acepta → **crea el tenant** via `start_onboarding` (única vía de creación de companies).
4. Envía link de Kapso para conectar el WhatsApp Business del owner.
5. Envía OAuth de Google Calendar y configura la disponibilidad bloqueando tiempo ocupado.
6. Escala a humano via `notifyStaff` ante riesgo reputacional, caso Enterprise, o bloqueo técnico.

**Detección:** `company.kind === 'platform'` o `company.id === env.BRUNO_LAB_COMPANY_ID`.

**Por qué "SuperAdmin":** es el único agente con permiso de **crear empresas**. Ningún otro agente puede hacerlo.

---

## ❷ Admin — agente del staff

| | |
|---|---|
| **A quién atiende** | Staff de una clínica cliente. |
| **Tenant** | Cualquier `companies.kind='tenant'`. |
| **Detección** | `clinicas.staff.phone` matchea al remitente del webhook. |
| **Quién lo invoca** | `WebhookController.processAdminEvent` → `AiService.generarRespuestaAdmin`. |
| **Dos modos** | **Onboarding** (`company.onboarding_completed_at IS NULL`) → `generarRespuestaOnboarding` con 6 pasos guiados. **Normal** (ya onboardeado) → CRUD + consultas. |
| **Tools** | `src/tools/clinicas-admin.tools.ts` completo. |

**Responsabilidades:**
- CRUD de tratamientos, staff, perfil de clínica, configuración del agente paciente.
- Consultas operativas: citas próximas, slots libres, resumen diario.
- Envío de mensajes a pacientes desde el número de la clínica.
- Gestión de skills configurables del agente paciente.
- Completar el onboarding una vez la clínica tenga mínimos.

---

## ❸ Público — agente paciente

| | |
|---|---|
| **A quién atiende** | Pacientes / leads del canal WhatsApp de la clínica. |
| **Tenant** | `companies.kind='tenant'`. |
| **Detección** | Default — el remitente NO está en staff y la company no es platform. |
| **Quién lo invoca** | `WebhookController.processClinicasEvent` → `AiService.generarRespuestaClinicas`. |
| **System prompt** | Se **compila dinámicamente** desde `agents.system_prompt` + tratamientos + skills activas (`PromptCompilerService`). |
| **Tools** | `src/tools/clinicas.tools.ts` (públicas: agendar cita, consultar servicios, escalar, etc.). |

Se reconstruye cada vez que el admin toca `updateAgentConfig`, `createTreatment`, etc. Ver `PromptRebuildService`.

---

## Esquema — diferencias clave

| Pieza | Significado |
|---|---|
| `companies.kind` | `'platform'` (Bruno Lab) \| `'tenant'` (clínica cliente). Único `platform` por constraint. |
| `companies.onboarding_completed_at` | `NULL` activa modo onboarding en el agente Admin. |
| `staff.staff_role` | `'owner'` \| `'admin'` \| `'staff'`. El owner es único por company. Creado por `start_onboarding`. |
| `staff.phone` | Clave de detección del agente Admin (remitente ↔ staff). |
| `channels.metadata.connection_status` | `'pending'` \| `'connected'`. Pending = canal creado pero Kapso aún no conectó. |
| `channels.connected_at` | Timestamp del primer inbound real (= conexión confirmada). |
| `companies.referred_by` | FK a otra company (programa embajador). |

---

## Flujos clave

### Nacimiento de un tenant

```
prospecto → WhatsApp Bruno Lab (kind=platform)
  → Bruno califica y cierra
  → start_onboarding()          ── crea companies(kind='tenant') + agent + channel(pending) + staff(owner)
  → setup conversacional (6 bloques)
  → send_kapso_connection_link  ── owner abre link, conecta su WA Business
  → primer webhook al nuevo canal → channels.connected_at = now()
  → Bruno marca onboarding_completed_at  (via completeOnboarding tool)
  → el tenant empieza a atender pacientes por su propio número
```

A partir de ese momento:
- Los mensajes al número *del cliente* se enrutan al **Admin** (si escribe el owner/staff) o al **Público** (si escribe un paciente).
- Bruno queda como SuperAdmin solo en el canal de Bruno Lab.

### Idempotencia de `start_onboarding`

Si el prospecto retoma la conversación días después:
1. Bruno vuelve a llamar `start_onboarding` (el LLM no recuerda el `company_id` entre sesiones).
2. La tool busca `findPendingOnboardingByOwner(ownerPhone)` — si ya hay un owner con ese teléfono → retorna el `company_id` existente y `already_exists: true`.
3. El setup conversacional retoma donde quedó.

No se guarda `active_company_id` en la conversación: la idempotencia de la tool hace innecesario el estado.

---

## Configuración requerida

Variables de entorno nuevas para este sistema:

```bash
# Identidad de Bruno Lab (company platform)
BRUNO_LAB_COMPANY_ID=062f4cb7-b06d-45ef-9e54-be684a07d239

# Onboarding de Kapso (embedded signup de Meta)
KAPSO_ONBOARDING_URL=https://app.kapso.ai/embed/signup

# Google OAuth (ya existente, requerido para configure_availability del owner)
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://tu-host/auth/google/callback
```

Migración SQL: `sql/add_bruno_onboarding_fields.sql` — agrega `companies.kind`, `staff.staff_role`, `channels.connected_at`, `companies.referred_by`.

Tras aplicarla, marcar manualmente la fila de Bruno Lab:

```sql
UPDATE clinicas.companies
   SET kind = 'platform'
 WHERE id = '062f4cb7-b06d-45ef-9e54-be684a07d239';
```

---

## Dónde vive cada pieza

| Capa | SuperAdmin (Bruno) | Admin | Público |
|---|---|---|---|
| Router webhook | `processSuperAdminEvent` | `processAdminEvent` | `processClinicasEvent` |
| AI method | `generarRespuestaSuperAdmin` | `generarRespuestaAdmin` (+ `generarRespuestaOnboarding`) | `generarRespuestaClinicas` |
| Tools | `bruno-onboarding.tools.ts` + `bruno-commercial.tools.ts` | `clinicas-admin.tools.ts` | `clinicas.tools.ts` |
| System prompt | Hardcoded (basado en playbook) | Hardcoded (método) | Compilado en BD via `PromptCompilerService` |

---

## Pendientes conocidos

- **Webhook → channel connected:** cuando llega el primer inbound a un canal `pending`, falta el hook que llame `updateChannelConnectionStatus(channelId, 'connected')`. Hoy el campo se queda en `pending`.
- **Referral lookup:** `start_onboarding.referred_by_slug` solo se loggea; falta resolverlo a UUID.
- **Advisors de Bruno:** el `notifyStaff` hoy usa todos los `staff` con `phone` de la company platform. Puede refinarse a filtrar por `staff_role='admin'` cuando se diferencie al equipo comercial del resto.
- **Gemini model:** `generarRespuestaSuperAdmin` usa `env.GEMINI_MODEL`; evaluar un modelo distinto si Bruno requiere más tool-calling steps.
