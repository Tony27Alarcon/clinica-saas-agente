# Pendientes — Estado vivo

> Checklist de lo que falta para cerrar features en curso.
> **Regla:** cada ítem se tilda al cerrarlo y se mueve a la sección "Cerrado reciente" (última semana). Items más viejos se purgan o se archivan en CHANGELOG.

Última actualización: 2026-04-17 (tarde)

---

## 🗄️ Esquemas Supabase (`public` vs `clinicas`)

El esquema `public` lo comparte otro proyecto. Regla de oro documentada en `docs/AGENTS_ARCHITECTURE.md` (sección inicial). Estado: **cerrado para este ciclo**, salvo los ítems marcados abajo.

- [x] **Regla de oro:** todo en `clinicas`, nada en `public` (ni lectura ni escritura).
- [x] **Borrar** `sql/create_public_schema.sql` y `sql/add_notificaciones_soporte.sql` (pisaban tablas del otro proyecto).
- [x] **Borrar** carpeta `sql/legacy/` completa (sin datos en producción, no hace falta archivo histórico).
- [x] **`clinicas.logs_eventos`** con UUIDs (`company_id`, `contact_id`, `conversation_id`). Aplicada. Script: `sql/add_logs_eventos_clinicas.sql`.
- [x] **`LogService`** escribe en `clinicas.logs_eventos` y valida UUIDs antes de insertar.
- [x] **`LogContext`** extendido con `companyId`. El webhook lo setea al entrar en los 3 flujos (público/admin/super-admin).
- [x] **Borrar** `sql/add_is_admin_function.sql`. El DROP está en el cleanup abajo.
- [x] **Cleanup `public`** (`sql/cleanup_public_artifacts.sql`): drops de `public.is_admin()`, `public.logs_eventos`, views (`v_conversation_timeline`, `v_daily_outcome_ratios`, `v_reason_breakdown_7d`) y función `fn_request_trace(text)`. **Pendiente: correrlo una vez en Supabase.**
- [x] **`clinicas.media_assets`** nuevo (`sql/add_media_assets_clinicas.sql`): versión limpia para metadata de adjuntos per-mensaje. La tabla híbrida `public.media_assets` se deja intacta (la usa el otro proyecto); nosotros dejamos de escribir ahí.
- [x] **`sql/README.md`** con inventario ordenado y orden de aplicación para entorno limpio.
- [x] **Ejecutar `sql/cleanup_public_artifacts.sql` en Supabase** — corrido, `public` libre de artefactos del proyecto.
- [x] **Ejecutar `sql/add_media_assets_clinicas.sql` en Supabase** — corrido, tabla `clinicas.media_assets` disponible.
- [x] **Retención de `clinicas.logs_eventos`** — 60 días via `pg_cron` (job `clinicas_logs_eventos_retention_60d`, 03:15 UTC). Script: `sql/add_logs_eventos_retention.sql`. **Falta correrlo en Supabase** (requiere extensión `pg_cron` habilitada).

### 🔭 Observabilidad — views/RPC sobre `clinicas.logs_eventos`

- [x] **`clinicas.v_conversation_timeline`**, **`clinicas.v_daily_outcome_ratios`**, **`clinicas.v_reason_breakdown_7d`**, **`clinicas.fn_request_trace(text)`** — recreadas en `sql/add_logs_eventos_views.sql`. Idempotente (CREATE OR REPLACE).
- [x] **Actualizar `docs/LOGGING.md`** — sección *Consultas típicas para la IA* migrada a llamadas via views/función.
- [ ] **Aplicar `sql/add_logs_eventos_views.sql` en Supabase** (staging y prod).
- [ ] Opcional: validar planes con `EXPLAIN` en Supabase y agregar índices si una view tiene plan feo (los índices actuales en `add_logs_eventos_clinicas.sql` cubren la mayoría de casos).

### 👥 Advisors de Bruno — filtrar por `staff_role`

- [x] **`src/controllers/webhook.controller.ts`** `processSuperAdminEvent` ahora pasa `{ staffRole: 'admin' }` a `ClinicasDbService.listStaff` para escalar solo a asesores comerciales. La columna `staff_role` se incluye en el SELECT.
- [ ] **Marcar manualmente a los asesores comerciales** en producción: `UPDATE clinicas.staff SET staff_role='admin' WHERE company_id=<platform> AND <criterio>;` — sin esto, `advisors` queda vacío y el WARN del webhook lo deja loggeado.
- [ ] Regression test manual: disparar `notifyStaff` desde el flujo de Bruno y verificar que solo recibe la alerta el teléfono del admin comercial, no el resto del staff.

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

**Documentación:** flujo técnico, parámetros y estado actual en `docs/AGENTS_ARCHITECTURE.md` → sección *Envío de documentos HTML por WhatsApp*.

- [x] **Wire de `createSendHtmlDocumentTool`** en los 3 agentes (`AiService.generarRespuestaClinicas` + follow-up, `generarRespuestaAdmin` + follow-up, `generarRespuestaSuperAdmin`). FolderHints: `clinicas/<companyId>/<contactId>`, `admin/<companyId>`, `bruno/<prospectPhone>`.
- [x] **Skill de estilos HTML** (`src/skills/html-styles.skill.ts`): inyectada en el system prompt de los 3 agentes via `buildHtmlStylesSkill`. Paleta default sobria, parametrizable por `BrandColors`/`logoUrl`. Define templates (resumen-cita, confirmacion-formal, reporte-diario, propuesta-comercial), reglas de tipografía y componentes inline. Mobile-first.
- [x] **Preview/validación del HTML** antes de subir (`sanitizeHtmlForUpload` en `src/tools/send-html.tool.ts`): quita `<script>`, `<iframe>`, `<object>`/`<embed>`, handlers `on*=`, y neutraliza `javascript:` / `data:text/html` en hrefs/src. Tests: `src/__tests__/send-html.sanitize.test.ts` (5 casos).
- [ ] **Branding desde `companies`** — la skill ya lee `(company as any).brand_colors` y `(company as any).logo_url`, pero `clinicas.companies` aún NO tiene esas columnas. Pendiente: migración SQL `ALTER TABLE clinicas.companies ADD COLUMN logo_url text, ADD COLUMN brand_colors jsonb;` + tool admin para que el staff las edite. Mientras tanto la skill usa defaults sobrios.

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

- [x] **HTML enriquecido — wire completo en los 3 agentes**: `sendHtmlDocument` registrada en Clinicas/Admin/Bruno (incluyendo follow-ups), skill `buildHtmlStylesSkill` inyectada en cada system prompt con paleta + templates, sanitización defensiva en `sanitizeHtmlForUpload` (5 tests). Pendiente: migrar `companies` para añadir `logo_url`/`brand_colors` reales.
- [x] **Observabilidad: views/RPC sobre `clinicas.logs_eventos`** recreadas en `sql/add_logs_eventos_views.sql` (`v_conversation_timeline`, `v_daily_outcome_ratios`, `v_reason_breakdown_7d`, `fn_request_trace`). `docs/LOGGING.md` actualizada. Pendiente: aplicar el SQL en Supabase.
- [x] **Bruno escala solo a `staff_role='admin'`**: `processSuperAdminEvent` pasa `{ staffRole: 'admin' }` a `listStaff`. WARN actualizado con la query exacta para marcar advisors. Pendiente: marcar manualmente los advisors comerciales en producción.
- [x] **Comando `/borrar` purga completa y verificada** — antes el handler hacía `deleteContact` que tragaba errores y seguía con un seed sobre conversación vieja. Reemplazado por `ClinicasDbService.purgeContactCompletely` que: cancela eventos GCal, borra archivos del bucket `mensajes` (media + PDFs de `clinical_forms`), `DELETE` explícito de `media_assets` (no tiene FK CASCADE por diseño), anonimiza `logs_eventos` (set `contact_id=NULL, conversation_id=NULL`), `DELETE` de `contacts` (CASCADE limpia el resto) y verifica con `verifyContactPurged` que las tablas hijas quedaron en 0. Si el delete falla, retorna `ok=false` y el handler aborta sin sembrar la conv limpia. Spec completa en `docs/COMANDO_BORRAR.md`. Tests: `src/__tests__/clinicas-db.purge.test.ts` (7 casos).
