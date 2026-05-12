# Logging estructurado (consumo por IA)

Este documento describe el sistema de logs pensado para que una IA pueda leerlos, filtrar y agregar sin parsear prosa libre. Para los humanos, el formato a consola sigue siendo legible como siempre.

## Dos canales, un solo emisor

| Canal | Formato | Quién lo lee |
|---|---|---|
| Consola (Railway) | `[LEVEL] marker [ts] [req=… co=… tel=… conv=…] mensaje {extra}` | Humanos depurando en vivo. |
| `clinicas.logs_eventos` (Supabase) | JSON estructurado con columnas dedicadas. | IA, dashboards, post-mortems. |

El logger (`src/utils/logger.ts`) emite a ambos. El sink a BD vive en `src/services/log.service.ts` y batchea inserts.

> **Historial:** la tabla vieja `public.logs_eventos` (y sus views/RPC) fue **eliminada** por `sql/cleanup_public_artifacts.sql`. El sink escribe exclusivamente en `clinicas.logs_eventos` (ver `sql/add_logs_eventos_clinicas.sql`).

> **Retención:** 60 días. Un job de `pg_cron` llamado `clinicas_logs_eventos_retention_60d` corre todos los días a las 03:15 UTC y borra todo lo que pasó de esa ventana. Se crea con `sql/add_logs_eventos_retention.sql`. Para cambiar la ventana, re-ejecutar ese script con otro `interval`.

### Columnas relevantes de `clinicas.logs_eventos`

| Columna | Tipo | Origen en el logger |
|---|---|---|
| `request_id` | text | `context.requestId` |
| `company_id` | uuid | `context.companyId` (se setea al entrar al webhook) |
| `contact_id` | uuid | `context.contactoId` (post Step A) |
| `conversation_id` | uuid | `context.conversacionId` (post Step C) |
| `stage` | text | `context.stage` (se setea automáticamente dentro de `logger.stage(...)`) |
| `tipo` | text | `context.tipo` (tipo de mensaje WhatsApp) |
| `event_code` / `outcome` / `reason` / `summary` | text | campos estructurados de `logger.event()` |
| `error_message` / `error_stack` | text | pasado desde `logger.error(...)` / `logger.critical(...)` |
| `extra` | jsonb | `data` del `event()` / `extra` del clásico, sanitizado |

El sink valida que `company_id`, `contact_id` y `conversation_id` sean UUID antes de insertar; si no lo son, los manda como `NULL` para no romper el batch.

## API rápida

```ts
import { logger } from './utils/logger';
import { LOG_EVENTS, LOG_REASONS } from './utils/log-events';
```

### `logger.info/warn/error/critical` — logs clásicos
Mensaje libre. No pueblan `event_code/outcome/reason/summary`. **No son lo preferido para puntos de decisión** — los recomendados para eso son los de abajo.

### `logger.event(...)` — log estructurado para IA
```ts
logger.event({
    code: LOG_EVENTS.WEBHOOK_FALLBACK_SENT,   // requerido, enum cerrado
    outcome: 'fallback',                      // requerido: ok|skipped|fallback|failed|noop
    summary: 'Fallback enviado: tipo=unsupported sin caption', // requerido, ≤120 chars
    reason: LOG_REASONS.TYPE_IN_UNREADABLE_SET,  // opcional pero muy recomendado
    data: { messageType, rawType },           // opcional, payload plano y chico
    error: someError,                         // opcional, si outcome=failed
});
```

Level por default (configurable con `level: 'WARN'` si hace falta):
- `failed` → ERROR
- `fallback` → WARN
- `skipped` / `ok` → INFO
- `noop` → DEBUG

### `logger.decision(code, {...})` — azúcar
Equivalente a `event()` con `outcome='skipped'` por default. Ideal para registrar ramas del pipeline.

### `logger.stage('A', 'nombre', fn)` — sin cambios
Sigue funcionando igual. Loggea inicio/fin/duración de cada Step.

## Reglas de escritura

1. **Un `event()` por decisión.** No uses `event()` para narrar cada paso; usalo para dejar registro de una bifurcación del flujo (enrutado, filtro, fallback, loop detectado, respuesta enviada/fallida, etc.).
2. **`summary` es autocontenido.** Un humano leyendo solo esa línea entiende qué pasó. Sin jerga interna.
3. **Vocabulario cerrado.** Siempre pasar `code` desde `LOG_EVENTS` y `reason` desde `LOG_REASONS`. Si falta uno, agregarlo al enum antes de usarlo.
4. **`data` plano y chico.** <20 claves, <2KB. Si hay payload grande, guardá solo IDs; el origen ya está en su tabla.
5. **Sin secretos ni PII bruta.** El sanitizador del sink cubre teléfonos/emails/tokens, pero no lo uses como excusa para loguear info clínica del paciente.
6. **`level` secundario.** El outcome es el campo principal para la IA; el level sigue sirviendo para alertas humanas y filtrado en consola.

## Catálogo actual (ver archivo)

Fuente de verdad: `src/utils/log-events.ts`. Los grupos actuales:

| Dominio | Prefijo | Ejemplos |
|---|---|---|
| Webhook | `webhook.*` | `webhook.received`, `webhook.deduped`, `webhook.fallback.sent`, `webhook.outbound.saved`, `webhook.ignored.empty` |
| Routing | `route.*` | `route.tenant.matched`, `route.tenant.unknown`, `route.admin.detected` |
| Pipeline | `pipeline.*` | `pipeline.stage.*`, `pipeline.loop.detected`, `pipeline.contact.reset` |
| IA | `ai.*` | `ai.response.generated`, `ai.response.failed`, `ai.tool.called`, `ai.tool.failed`, `ai.noreply.decided`, `ai.followup.forced` |
| Prompt | `prompt.*` | `prompt.rebuild.ok`, `prompt.rebuild.failed` |
| Kapso | `kapso.*` | `kapso.send.ok`, `kapso.send.failed`, `kapso.mark_read` |
| Reminders | `reminder.*` | `reminder.scheduled`, `reminder.triggered`, `reminder.failed` |
| Sistema | `support.notified` | — |

## Consultas típicas para la IA

> Las views/RPC (`v_conversation_timeline`, `v_daily_outcome_ratios`, `v_reason_breakdown_7d`, `fn_request_trace`) que vivían en `public` fueron **eliminadas** por `sql/cleanup_public_artifacts.sql`. Su recreación sobre `clinicas.logs_eventos` con UUIDs está como tarea abierta en `docs/PENDIENTES.md` → *Observabilidad — views/RPC*. Mientras tanto, queries directas a la tabla:

Timeline completo de una conversación:
```sql
select created_at, level, stage, event_code, outcome, reason, summary, message
from clinicas.logs_eventos
where conversation_id = $1
order by created_at;
```

Drill-down por `request_id` (todo lo que pasó en un webhook):
```sql
select created_at, level, stage, event_code, outcome, message, error_message
from clinicas.logs_eventos
where request_id = $1
order by created_at;
```

Todo lo de un tenant en las últimas 24h:
```sql
select date_trunc('hour', created_at) h, outcome, count(*)
from clinicas.logs_eventos
where company_id = $1
  and created_at > now() - interval '1 day'
group by 1, 2
order by 1 desc;
```

## `logAiMetrics` — métricas de cada llamada a Gemini

Helper en `src/services/ai.service.ts` que se ejecuta al final de cada `generateText()` en los 3 pipelines (clinicas, admin, superadmin). Emite:

| Evento | Cuándo | Datos clave |
|---|---|---|
| `ai.tool.called` | Por cada tool invocada (agrupado por nombre) | `toolName`, `count` |
| `ai.tool.failed` | Cuando una tool retorna `ok: false` o `error` | `toolName`, `error` |
| `ai.followup.forced` | Cuando la primera llamada no generó texto y se forzó una segunda | `followUpToolCalls`, `hasText` |
| `ai.response.generated` | Resumen final de la llamada | `durationMs`, `steps`, `toolCalls`, `toolCallsByName`, `failedToolCalls`, `responseLength`, `finishReason`, `followUp` |

### Consulta: rendimiento de IA por pipeline

```sql
select
  extra->>'pipeline' as pipeline,
  avg((extra->>'durationMs')::int) as avg_ms,
  avg((extra->>'toolCalls')::int) as avg_tools,
  avg((extra->>'responseLength')::int) as avg_chars,
  count(*) filter (where outcome = 'failed') as failures
from clinicas.logs_eventos
where event_code = 'ai.response.generated'
  and created_at > now() - interval '7 days'
group by 1;
```

### Consulta: tools que más fallan

```sql
select
  extra->>'toolName' as tool,
  extra->>'error' as error,
  count(*)
from clinicas.logs_eventos
where event_code = 'ai.tool.failed'
  and created_at > now() - interval '7 days'
group by 1, 2
order by 3 desc;
```

## `prompt.rebuild.*` — tracking de recompilación

Cada vez que una tool modifica config que afecta al agente paciente (tratamientos, agente, empresa), dispara `PromptRebuildService.rebuildPromptForCompany()` en background. El resultado se logea como:

- `prompt.rebuild.ok` — rebuild exitoso.
- `prompt.rebuild.failed` — rebuild falló (fire-and-forget, no rompe el pipeline).

Aplica tanto a tools de Bruno (onboarding) como a tools admin (CRUD).

## Cómo agregar un código nuevo

1. Definir la entrada en `LOG_EVENTS` (o `LOG_REASONS`) en `src/utils/log-events.ts`. Documentar cuándo se emite.
2. Importar y usarlo desde el call site con `logger.event()`.
3. Si encaja en un dashboard o métrica, agregar view/RPC en el esquema `clinicas` con una nueva migración en `sql/`.
