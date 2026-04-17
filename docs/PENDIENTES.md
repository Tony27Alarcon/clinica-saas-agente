# Pendientes — Estado vivo

> Checklist de lo que falta para cerrar features en curso.
> **Regla:** cada ítem se tilda al cerrarlo y se mueve a la sección "Cerrado reciente" (última semana). Items más viejos se purgan o se archivan en CHANGELOG.

Última actualización: 2026-04-16

---

## 🧪 Modo Test (staff → `/test` / `/exit`)

Feature que permite al staff probar el agente público desde su mismo número por 20 min, con borrado de mensajes al salir y resumen inyectado en la conversación admin.

- [ ] **Aplicar migración SQL** `sql/add_test_sessions_table.sql` en Supabase (staging y prod).
- [ ] **QA manual end-to-end**:
  - `/test` abre sesión y responde con copy correcto.
  - 2-3 turnos como "paciente" reciben respuesta del agente público.
  - `/exit` envía resumen al staff y purga `test_conversation_id`.
  - La conv admin del staff tiene un mensaje `role='system'` con el resumen.
  - Timeout de 20 min: el siguiente mensaje dispara cierre + passthrough admin.
  - `/test` estando ya en sesión → responde "ya estás en modo test, restan X min".
- [ ] **Atomicidad de `closeSession`** (`src/pipelines/test-mode.pipeline.ts:113-131`): invertir orden → `saveMessage` admin con summary *antes* de `purgeTestConversation`. Si la purga falla, la sesión queda `ended` pero se puede re-purgar idempotentemente; en cambio si falla el save del admin después de purgar, se pierde el summary.
- [ ] **Cleanup si falla `startSession`**: si el insert en `test_sessions` falla después de crear el contacto aliasado, quedar con un contact huérfano `${phone}__test`. Envolver en try/catch y borrar el contact.
- [ ] **Recortar copy `TEST_MODE_COPY.exited`** (`src/config/constants.ts`): no duplicar el summary en WhatsApp del staff — basta con "Modo test cerrado. Resumen disponible en el hilo admin.".
- [ ] **(Opcional)** Comando `/admin force-exit-test` para cerrar sesión de test de otro staff (protección contra sesiones colgadas).

---

## 🎨 HTML enriquecido en mensajes

Feature: los agentes pueden generar un documento HTML y enviarlo por WhatsApp como adjunto (para resúmenes, confirmaciones, reportes).

- [ ] **Wire de `createSendHtmlDocumentTool`** en los agentes. Hoy la tool existe en `src/tools/send-html.tool.ts` pero **no está registrada** en ningún `generateText`:
  - `AiService.generarRespuestaAdmin` → habilitarla para reportes operativos del staff.
  - `AiService.generarRespuestaClinicas` → habilitarla para confirmaciones de cita, resúmenes de tratamiento al paciente.
  - `AiService.generarRespuestaSuperAdmin` (Bruno) → habilitarla para propuesta comercial / resumen del onboarding.
- [ ] **Skill de estilos HTML** (nuevo archivo `src/skills/html-styles.skill.ts` o inline en `system-patient-skills.ts`): guía al LLM sobre paleta, tipografía, layout móvil, header/footer con branding de la clínica. Evita markup genérico y feo.
  - Paleta por defecto (e.g. primary, accent, text, bg) parametrizable por `company.brand_colors`.
  - Templates mínimos: "resumen-cita", "confirmación", "instrucciones-pre-tratamiento", "reporte-diario".
  - Ejemplos de markup en la skill para que el LLM copie el estilo.
- [ ] **Preview/validación del HTML** antes de subir: sanitizar `<script>` inline como mínimo. `MediaService.uploadToSupabase` ya lo deja público — meter validación básica en la tool.
- [ ] **Branding desde `companies`**: que la tool lea `company.logo_url` y `company.brand_colors` y los inyecte como contexto para el LLM sin que el agente los invente.

---

## 🔗 Envío de link de Kapso

Ya existen dos tools relacionadas. Verificar alcance de lo que falta.

- [x] `createBrunoSendKapsoLinkTool` — Bruno envía link de conexión WhatsApp al owner durante onboarding (`src/tools/bruno-onboarding.tools.ts`).
- [x] `createAdminSendPortalLinkTool` — Admin envía link del portal web (`src/tools/clinicas-admin.tools.ts`).
- [ ] **¿Falta algo?** Pendiente confirmar con el usuario el caso de uso exacto que motivó el ítem ("envio de link de kapso"). Posibles interpretaciones:
  - Reenvío de link de Kapso desde el agente admin (no solo Bruno) cuando el staff perdió el link inicial.
  - Link personalizado por canal / re-conexión cuando el número se desvincula.
  - Link de invitación para nuevos staff (onboarding secundario).

---

## 📋 Onboarding iniciado por agente (Bruno)

Ver `commercial/omboarding_tecnico.md` para el spec completo.

- [x] Tool `start_onboarding` idempotente.
- [x] Tool `send_kapso_connection_link`.
- [x] Tool `connect_google_calendar_owner` con OAuth.
- [x] Tool `configure_availability` (modelo invertido: bloquea lo ocupado).
- [x] Campos en `companies`: timezone, country_code, onboarding_completed_at (ver `sql/add_bruno_onboarding_fields.sql`).
- [ ] **Aplicar `sql/add_bruno_onboarding_fields.sql`** a Supabase (si aún no).
- [ ] **Decisión pendiente:** normalizar `timezone` a IANA (`America/Bogota` no `Medellin/Colombia`).
- [ ] **Decisión pendiente:** estrategia de marcado de eventos creados por el agente → `extendedProperties.private` recomendado.
- [ ] **Decisión pendiente:** manejo de revocación OAuth (¿notificar al staff? ¿desactivar tool?).
- [ ] **Decisión pendiente:** dónde persistir estado `pending` / `connected` del canal → `channels.metadata` o columna nueva.

---

## 🧰 Skills del agente (sistema configurable)

- [x] `admin-agent-skills.ts` (+160 líneas) — buenas prácticas WhatsApp para guiar al staff en configuración.
- [x] `system-patient-skills.ts` (+186 líneas) — skills del agente paciente.
- [x] UI admin en `web/app/admin/[companyId]/skills/` para toggles y skills privadas.
- [ ] **Committear y probar** el CRUD completo de skills privadas (crear/editar/eliminar/toggle).
- [ ] Auditar que el recompilado del prompt (`PromptRebuildService`) se dispara en **cada** mutación de skills (no solo create).

---

## 📚 Documentación

- [x] `docs/AGENTS_ARCHITECTURE.md` — taxonomía de agentes y routing.
- [ ] Actualizar `docs/company-skills.md` (ya modificado, falta revisión final).
- [ ] README del directorio `src/skills/` (hay `src/skills/README.md` nuevo sin committear — revisar contenido).

---

## 🧹 Higiene del repo

- [ ] Muchos archivos modificados/untracked sin committear (`git status` muestra ~18 modificados + 10 nuevos). Decidir qué va en cuál commit — al menos separar:
  1. `feat(test-mode): pipeline de /test y /exit para staff`
  2. `feat(onboarding): Bruno crea tenants y configura Google Calendar`
  3. `feat(skills): CRUD de skills configurables del agente paciente`
  4. `feat(tools): sendHtmlDocument para adjuntar HTML por WhatsApp`
  5. `docs: arquitectura de agentes + pendientes`

---

## Cerrado reciente

_(vacío — empezar a llenar a medida que se tilda arriba)_
