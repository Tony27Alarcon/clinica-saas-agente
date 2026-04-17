# Skills del sistema — Guía de mantenimiento

> **Para agentes (Claude Code, Cursor u otros) que toquen este directorio:** leé esto ANTES de crear, editar o borrar una skill. Las skills moldean el comportamiento del agente en producción; errores acá se sienten en cada conversación de cada clínica.

## 1. Arquitectura de skills

Existen **3 capas** con prioridad descendente cuando se compila el system prompt (ver `src/services/prompt-compiler.service.ts` → `buildSystemPrompt()`):

| Orden | Capa | Archivo | Editable por |
|-------|------|---------|--------------|
| 1 | **Base** (no editable) | `base-agent-skills.ts` → `buildBaseAgentSkills()` | Solo nosotros, con justificación fuerte |
| 2 | **System del paciente** | `system-patient-skills.ts` → `SYSTEM_PATIENT_SKILLS` | Solo nosotros (agentes/devs). Empresas solo togglean. |
| 3 | **Privadas** | Persistidas en `clinicas.company_skills` (kind='private') | Admin de cada clínica |

El agente **admin** (asistente conversacional del staff) usa además:

- `admin-agent-skills.ts` → `ADMIN_SKILLS[]`: skills globales que guían al asistente admin cuando ayuda a configurar la clínica u operar el día a día.

**Regla de oro:** las capas superiores NUNCA son contradichas por las inferiores. Si una private contradice la base, la base gana (y está documentado al paciente en `buildCompanySkillsSection()`).

## 2. Protocolo: shape obligatorio de toda skill

Todas las skills — base (en espíritu), admin, system-patient, private — comparten el mismo contrato:

```ts
interface Skill {
  id:         string;   // slug [a-z0-9][a-z0-9-]{1,63}$, estable, nunca renombrar
  name:       string;   // nombre legible (ej: "Manejo Avanzado de Objeción de Precio")
  trigger:    string;   // CONDICIÓN concreta observable. No "siempre".
  guidelines: string;   // ≥30 chars, imperativo, con pasos numerados y ejemplos
}
```

Validado por:
- `CompanySkillsService.validatePrivateContent()` (runtime)
- Constraint SQL `company_skills_private_content` en `sql/add_company_skills.sql`

## 3. Cuándo crear una skill nueva

**Creá una skill cuando:**
- Existe un **caso de uso repetido** que el agente hoy maneja mal o inconsistente.
- Se apoya en **tools ya existentes** (verificar en `src/tools/`). Si necesitás una tool nueva, esa es otra tarea antes.
- Hay un **KPI concreto** que mejora (no-show%, conversión, retención, CAC, etc.) o un dolor operativo claro.
- El comportamiento **no está ya cubierto** por otra skill o por la base.

**NO crees una skill cuando:**
- Es una regla universal → va en `base-agent-skills.ts`.
- Es específica de una clínica → el admin la crea como `private` desde la UI.
- Duplica 80% de una existente → editá la existente, no dupliques.
- No la podés disparar con un trigger observable (evitar skills "ambiente").

## 4. Checklist para crear o editar una skill

### a. Antes de escribir

- [ ] Leer `base-agent-skills.ts` completo. ¿Estás por escribir algo que ya está ahí?
- [ ] Listar las skills existentes del mismo agente. ¿Hay solape con alguna?
- [ ] Identificar las **tools reales** que la skill orquestará. Abrir `src/tools/clinicas.tools.ts` (paciente) o `src/tools/clinicas-admin.tools.ts` (admin) y confirmar que existen.
- [ ] Identificar el **trigger** — una frase observable, no un estado abstracto.

### b. Al escribir `guidelines`

- [ ] Imperativo (“Recolectá…”, “Usá…”, “Escalá a humano si…”).
- [ ] Pasos numerados cuando hay orden de ejecución.
- [ ] Nombrar explícitamente las tools que se usan (`updateContactProfile`, `scheduleReminder`, etc.). Esto reduce alucinación.
- [ ] Incluir al menos 1 ejemplo concreto de mensaje (texto entre comillas).
- [ ] Incluir **"QUÉ NO HACER"** (negatives son tan importantes como positives).
- [ ] ≥30 chars, pero **denso**: tokens cuestan en cada invocación del agente.
- [ ] Sin Markdown pesado (usar guiones simples, no tablas ni HTML).

### c. Al registrar

Agregar al array exportado correspondiente — el orden dentro del array NO afecta prioridad, pero mantener el orden por tema ayuda a revisar:

| Skill para | Agregar al array en | Además |
|------------|---------------------|--------|
| Agente paciente (system) | `system-patient-skills.ts` → `SYSTEM_PATIENT_SKILLS` | Reflejar el nuevo id en `web/lib/skills-catalog.ts` y actualizar `docs/company-skills.md` |
| Agente admin | `admin-agent-skills.ts` → `ADMIN_SKILLS` | Ninguna sincronía extra (es puro backend) |
| Reglas universales | `base-agent-skills.ts` → `buildBaseAgentSkills()` | Solo secciones, no array; requiere discusión humana |

### d. Verificación

- [ ] `npx tsc --noEmit` desde root pasa limpio.
- [ ] `npx tsc --noEmit` desde `web/` pasa limpio (si tocaste system-patient).
- [ ] `SYSTEM_PATIENT_SKILLS.length` en backend coincide con array en `web/lib/skills-catalog.ts`; los `id` son idénticos.
- [ ] El id del skill **NO colisiona** con uno existente (`grep -r "id: 'mi-skill-id'" src/skills/`).
- [ ] `docs/company-skills.md` refleja el estado actual (si es system).

## 5. Sincronía backend ↔ frontend (crítico)

El catálogo `SYSTEM_PATIENT_SKILLS` vive **duplicado**:

- Fuente de verdad: `src/skills/system-patient-skills.ts` (backend, full guidelines).
- Espejo UI: `web/lib/skills-catalog.ts` (solo lo necesario para mostrar en `/admin/:companyId/skills` y validar colisión al crear privadas).

**Cada vez que agregues, renombres o borres un skill system, actualizá AMBOS archivos.** Si no, la UI mostrará un catálogo desactualizado o rechazará slugs que no colisionan con nada real.

Motivo de la duplicación: `web/` es un proyecto Next.js independiente con su propio `tsconfig.json` y alias `@/*` apuntando a `./web`. No puede importar desde `../src/skills/` sin tooling extra. Si esto se vuelve un problema recurrente, la solución correcta es extraer el catálogo a un paquete compartido, NO "tirarlo a mano" importando cross-project.

## 6. Cómo editar o deprecar

### Editar contenido (name, trigger, guidelines)

- OK sin coordinación. El próximo rebuild de prompt lo toma.
- Si el cambio es grande, mencionarlo en el commit message para que quede trazable.

### Renombrar `id`

- **No lo hagas.** El `id` es un contrato:
  - Las rows de `clinicas.company_skills` con `kind='system'` guardan ese id literal.
  - Renombrar deja rows huérfanas que el prompt ignora pero que aparecen en la UI como "toggle fantasma".
- Si es inevitable: agregar el nuevo, dejar el viejo marcado como deprecated en `guidelines`, y planificar migración SQL que actualice `skill_id`.

### Borrar un skill

- Antes de borrar: buscar rows en producción con `SELECT COUNT(*) FROM clinicas.company_skills WHERE kind='system' AND skill_id='<id>';`
- Si hay rows, decidir:
  - (Preferido) Dejar el skill con guidelines vacío/minimal hasta que termine el ciclo de rebuild y luego purgar.
  - Ejecutar un DELETE explícito de rows huérfanas como parte del mismo cambio.
- Remover del array `SYSTEM_PATIENT_SKILLS`, del espejo `web/lib/skills-catalog.ts`, y de `docs/company-skills.md`.

## 7. Tools nuevas: flujo correcto

Si al diseñar una skill descubrís que falta una tool:

1. Parar el diseño de la skill.
2. Agregar la tool en `src/tools/clinicas.tools.ts` (paciente) o `clinicas-admin.tools.ts` (admin).
3. Wireárla en `src/services/ai.service.ts` en los **3 sitios** (call principal, fallback, y onboarding si aplica).
4. Recién después, escribir la skill referenciando la tool.

No hagas el flujo inverso: una skill que pide una tool inexistente es una alucinación programada.

## 8. Quién puede qué (resumen de permisos)

| Acción | Quién | Cómo |
|--------|-------|------|
| Crear/editar `base-agent-skills` | Devs con revisión humana | PR con justificación |
| Crear/editar `SYSTEM_PATIENT_SKILLS` | Devs / agentes de código | PR + sincronía con `web/lib/skills-catalog.ts` |
| Crear/editar `ADMIN_SKILLS` | Devs / agentes de código | PR |
| Toggle system por empresa | Admin de la clínica | UI `/admin/:companyId/skills` o tool `toggleCompanySkill` del agente admin |
| CRUD de skills `private` | Admin de la clínica (rol `admin` en JWT) | UI o tools `createPrivateSkill` / `updatePrivateSkill` / `deletePrivateSkill` |
| Toggle/CRUD con rol `staff` | — | 403, bloqueado por `requireAdmin()` en `web/lib/auth.ts` |

## 9. Rebuild del prompt

Cualquier cambio en `clinicas.company_skills` encola un rebuild vía trigger Postgres (`trg_prompt_rebuild_company_skills`). El backend procesa la cola asíncronamente (`PromptRebuildService.processRebuildQueue`).

Cambios en **código** de skills (este directorio) **NO disparan rebuild automático** — son código estático compilado en el prompt al próximo rebuild que ocurra por cualquier otro motivo. Si hacés un cambio crítico en skills de sistema y querés forzar el rebuild de todas las clínicas:

```sql
INSERT INTO clinicas.prompt_rebuild_queue (company_id, triggered_by)
SELECT id, 'manual' FROM clinicas.companies WHERE active = true;
```

Luego correr el procesador (endpoint interno o proceso programado).

## 10. Referencias cruzadas

- **Servicio**: `src/services/company-skills.service.ts` — lista/toggle/CRUD y filtrado de activas para el prompt.
- **Compilador**: `src/services/prompt-compiler.service.ts` → `buildSystemPrompt()` inyecta `buildCompanySkillsSection(customSkills)`.
- **Tool para agente admin**: `src/tools/clinicas-admin.tools.ts` → `createAdminListCompanySkillsTool`, `createAdminToggleCompanySkillTool`, `createAdminCreate/Update/DeletePrivateSkillTool`.
- **API web**: `web/app/api/admin/[companyId]/skills/**`.
- **UI admin**: `web/app/admin/[companyId]/skills/page.tsx`.
- **SQL**: `sql/add_company_skills.sql`.
- **Feature doc**: `docs/company-skills.md` (catálogo público + protocolo + escenarios).

---

**Última verdad:** si estás a punto de inventar un comportamiento porque "parece buena idea", buscá primero si existe. Si existe y está roto, arreglá el existente. No duplicar, no improvisar.
