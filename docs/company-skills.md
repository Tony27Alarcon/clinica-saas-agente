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

Hoy el modelo de auth es por sesión JWT con `companyId` (ver `web/middleware.ts`). Cualquier sesión válida para esa clínica puede activar/crear/borrar skills (admin de facto). El skill `manage-private-skills` en `ADMIN_SKILLS` documenta el protocolo para que el agente admin (asistente conversacional) lo aplique solo cuando el usuario tenga rol admin.

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
