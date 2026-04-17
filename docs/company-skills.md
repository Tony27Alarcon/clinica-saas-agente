# Skills configurables por empresa

Capa de skills opcionales que cada clínica puede activar/desactivar para SU agente paciente, además de las **reglas fundamentales** (no editables) de `buildBaseAgentSkills()`.

## Tipos

| Tipo      | Origen del contenido                                                | Quién activa | Quién edita    |
|-----------|---------------------------------------------------------------------|--------------|----------------|
| `system`  | Catálogo global en `src/skills/system-patient-skills.ts`            | Admin clínica| Solo nosotros  |
| `private` | Persistido en `clinicas.company_skills` (name/trigger/guidelines)   | Admin clínica| Admin clínica  |

## Protocolo (mismo shape que `AdminSkill`)

Toda skill — system o private — cumple:

```ts
{
  id:         string;  // slug [a-z0-9-]+, único en la empresa
  name:       string;
  trigger:    string;  // condición concreta de activación
  guidelines: string;  // instrucciones detalladas (mín. 30 chars)
}
```

Validación adicional para `private`: el `skill_id` no puede colisionar con el catálogo `system`.

## Orden de aplicación en el system prompt

```
1. Identidad (sección 1)
2. buildBaseAgentSkills()         ← REGLAS FUNDAMENTALES (no editables)
3. buildCompanySkillsSection()    ← system activas + private activas
4. Contexto de clínica, catálogo, staff, horarios, pipeline, reglas, objeciones
```

Las skills configurables van **después** de las reglas base para dejar clara su prioridad: complementan, nunca anulan.

## Reglas explícitas

- **Empresa nueva sin skills privadas:** todas las `system` están activas por defecto (no requiere row en BD). El catálogo se inyecta tal cual.
- **Admin desactiva una skill `system`:** se persiste row con `enabled=false`. El prompt **omite** esa skill — el agente NO debe inventar ese comportamiento.
- **Skill privada mal formada:** rechazada por la API y por el constraint SQL `company_skills_private_content`.
- **Conflicto base ↔ privada:** las reglas base SIEMPRE ganan. El recordatorio explícito vive en el header de `buildCompanySkillsSection()`.
- **Cambio de skills:** un trigger Postgres encola un rebuild en `prompt_rebuild_queue` (`triggered_by='company_skills'`). El admin Next.js además dispara `POST /internal/rebuild-prompt/:companyId`.

## Permisos

El JWT del portal incluye `{ companyId, role: 'admin' | 'staff' }`. El middleware lo verifica y propaga `x-company-id` y `x-user-role` como headers de request a las route handlers (no son seteables desde el cliente).

- **`admin`** — puede activar/desactivar cualquier skill (system o private), crear, editar y borrar privadas.
- **`staff`** — solo puede leer (`GET`). Cualquier mutación devuelve 403.

Helper: `requireAdmin(req, companyId)` en `web/lib/auth.ts`. La UI consulta `GET /api/admin/:companyId/me` para mostrar/ocultar acciones según el rol.

**Back-compat:** tokens viejos sin `role` se asumen `admin` (mantiene operativos los magic links emitidos antes del cambio).

El skill `manage-private-skills` en `ADMIN_SKILLS` documenta el protocolo para que el agente admin (asistente conversacional) lo aplique solo cuando el usuario tenga rol admin.

## Endpoints

```
GET    /api/admin/:companyId/skills                    → { system, private }
POST   /api/admin/:companyId/skills                    → crear privada
PATCH  /api/admin/:companyId/skills/:skillId?kind=...  → toggle / editar
DELETE /api/admin/:companyId/skills/:skillId?kind=private  → borrar privada
```

## UI

`/admin/:companyId/skills` — toggles para system, CRUD para private, con expandir/colapsar guidelines.

## Migración

`sql/add_company_skills.sql` — tabla, constraints, trigger de rebuild. Idempotente.

---

## Catálogo actual de skills del agente paciente (`system`)

Todas activas por defecto. Admin puede desactivar cualquiera desde `/admin/:companyId/skills`.

| `skill_id` | Cuándo se activa |
|------------|------------------|
| `objection-price-pro` | Paciente dice que es caro, pide descuento, o menciona que no tiene presupuesto. |
| `appointment-confirmation` | Inmediatamente después de cerrar una cita, y al enviar recordatorios programados. |
| `rescheduling-flow` | Paciente pide cambiar, mover o cancelar una cita ya agendada. |
| `gentle-cross-sell` | Paciente ya confirmó y hay tratamientos complementarios en el catálogo. |
| `lead-qualification-soft` | Primer mensaje sin contexto o "quiero info / cuánto cuesta" sin tratamiento específico. |
| `clinical-intake-pre-cita` | Tras un bookAppointment exitoso, antes del recordatorio 24h. |
| `dormant-lead-recovery` | Reminder a 30/60 días sobre lead que nunca agendó, o reactivación manual del staff. |
| `post-treatment-follow-up` | Reminder a 3/7/30 días post-cita completada. |
| `referral-ask-natural` | 30 días post-cita con feedback positivo, o satisfacción espontánea ("me encantó"). |
| `third-party-booking` | Quien escribe indica que la cita es para otra persona (esposa, hija, regalo). |
| `nutrition-coach` | Paciente pregunta por dieta, alimentación, control de peso, suplementos o comparte avances de entrenamiento. |

## Skills del agente admin (`ADMIN_SKILLS`)

Globales — no toggleables por la empresa. Se inyectan en el prompt del asistente admin cuando corresponde al trigger.

| `skill_id` | Propósito |
|------------|-----------|
| `write-instructions` | Escritura humanizada de instrucciones WhatsApp. |
| `configure-personality` | Nombre, tono y persona del agente. |
| `configure-company` | Datos de clínica y horarios. |
| `configure-treatments` | Catálogo de tratamientos. |
| `configure-objections` | Base de respuestas a objeciones. |
| `configure-escalation` | Keywords, max turns, descalificación. |
| `whatsapp-best-practices` | Checklist de calidad de mensajes. |
| `configure-booking` | Instrucciones de reserva. |
| `manage-private-skills` | Crear/editar skills privadas (rol admin). |
| `daily-briefing` | Resumen accionable del día. |
| `noshow-recovery-flow` | Marcar no-show + recovery opcional. |
| `patient-quick-actions` | Búsqueda → acción rápida sobre un paciente. |
| `agent-performance-check` | Revisión honesta del rendimiento del agente paciente. |
| `broadcast-scheduling` | Programación de mensajes masivos con doble confirmación. |
