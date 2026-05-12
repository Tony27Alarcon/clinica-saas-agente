# Pendientes — Estado vivo

> Checklist de lo que falta para cerrar features en curso.
> **Regla:** cada ítem se tilda al cerrarlo y se mueve a la sección "Cerrado reciente" (última semana). Items más viejos se purgan o se archivan en CHANGELOG.

Última actualización: 2026-05-12

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

Las views/funciones viejas vivían en `public` y fueron **eliminadas** por `cleanup_public_artifacts.sql`. Mientras no existan, los dashboards y queries "por nombre" fallan; hay que recrearlas sobre la nueva tabla con UUIDs. Plan sugerido en un archivo nuevo `sql/add_logs_eventos_views.sql`:

- [ ] **`clinicas.v_conversation_timeline`** — `SELECT created_at, level, stage, event_code, outcome, reason, summary, message FROM clinicas.logs_eventos WHERE conversation_id = $1 ORDER BY created_at`. Cambia el filtro: antes era `conversacion_id bigint`, ahora `conversation_id uuid`.
- [ ] **`clinicas.v_daily_outcome_ratios`** — agregar por día/outcome: `SELECT date_trunc('day', created_at) AS day, outcome, count(*) FROM clinicas.logs_eventos WHERE outcome IS NOT NULL GROUP BY 1, 2`. Opcional: cortar a últimos 30 días.
- [ ] **`clinicas.v_reason_breakdown_7d`** — top reasons por outcome últimos 7 días: `SELECT outcome, reason, count(*) FROM clinicas.logs_eventos WHERE created_at > now() - interval '7 days' AND reason IS NOT NULL GROUP BY 1, 2 ORDER BY 3 DESC`.
- [ ] **`clinicas.fn_request_trace(p_request_id text)`** — devuelve todas las filas del mismo webhook ordenadas, con columnas acotadas (created_at, level, stage, event_code, outcome, summary, error_message).
- [ ] **Actualizar `docs/LOGGING.md`** — sección *Consultas típicas para la IA* para reemplazar las queries a mano por llamadas a las views/RPC cuando queden creadas.
- [ ] Opcional: agregar índices adicionales si las views muestran planes feos en Supabase (`EXPLAIN` primero; los índices actuales cubren la mayoría de casos).

Criterio de listo: las cuatro queries corren en <200ms sobre la tabla en staging y quedan documentadas en `docs/LOGGING.md`.

### 👥 Advisors de Bruno — filtrar por `staff_role`

- [ ] **`src/controllers/webhook.controller.ts:924`** — hoy `processSuperAdminEvent` calcula `advisors` como *todos* los `clinicas.staff` de la company platform que tengan `phone`. Eso incluye cualquier rol (`owner`, `admin`, `staff`). El `notifyStaff` de Bruno debería escalar solo a **asesores comerciales**, no al resto del equipo.

    Plan:
    1. Cambiar la llamada `ClinicasDbService.listStaff(company.id, false)` por una variante que filtre por `staff_role IN ('admin')` (o crear flag `{ role: 'admin' }` en el método).
    2. Poblar `staff_role='admin'` en los miembros del equipo comercial de Bruno Lab manualmente (una sola vez). El resto queda como `staff`/`owner`.
    3. Mantener `assignedAdvisor = advisors[0] ?? fallback`, pero loggear `WARN` si `advisors.length === 0` (hoy ya lo hace).
    4. Regression test manual: disparar `notifyStaff` desde el flujo de Bruno y verificar que solo recibe la alerta el teléfono del admin comercial, no el resto del staff.

    Criterio de listo: el webhook del SuperAdmin filtra por `staff_role='admin'` y queda documentado el requisito de marcar manualmente a los asesores comerciales.

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

- [ ] **Wire de `createSendHtmlDocumentTool`** en los agentes. Hoy la tool existe en `src/tools/send-html.tool.ts` pero **no está registrada** en ningún `generateText`:
  - `AiService.generarRespuestaAdmin` → habilitarla para reportes operativos del staff.
  - `AiService.generarRespuestaClinicas` → habilitarla para confirmaciones de cita, resúmenes de tratamiento al paciente.
  - `AiService.generarRespuestaSuperAdmin` (Bruno) → habilitarla para propuesta comercial / resumen del onboarding.
  - Al registrar: importar la factory, añadirla al objeto `tools` del `generateText` correspondiente y pasar **`phoneNumberId`** y **`telefono`** del mismo contexto que ya usa el webhook (E.164 sin `+`).
  - Elegir **`folderHint`** para organizar archivos en Supabase (`html/<folderHint>/…`): por ejemplo `companyId`, o `companyId` + sufijo de contacto si hace falta trazabilidad por conversación.
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
- [x] Tool `configure_company` (dirección, horarios, timezone).
- [x] Tool `configure_agent` (nombre, tono, personalidad, objeciones).
- [x] Tool `add_treatment` (crea tratamientos en el onboarding).
- [x] Tool `complete_onboarding` (valida ≥1 treatment, marca completado, rebuild).
- [x] `resolveCompanyId` — protección contra UUIDs inventados por modelos ligeros.
- [x] System prompt anti-llamada (prohibiciones explícitas de demos/calls/derivación).
- [x] Logging estructurado: `logAiMetrics` en los 3 pipelines, eventos de rebuild, SuperAdmin con paridad de eventos vs pacientes.
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
