# Logging estructurado (consumo por IA)

Este documento describe el sistema de logs pensado para que una IA pueda leerlos, filtrar y agregar sin parsear prosa libre. Para los humanos, el formato a consola sigue siendo legible como siempre.

## Dos canales, un solo emisor

| Canal | Formato | Quién lo lee |
|---|---|---|
| Consola (Railway) | `[LEVEL] marker [ts] [req=... tel=...] mensaje {extra}` | Humanos depurando en vivo. |
| `public.logs_eventos` (Supabase) | JSON estructurado con columnas dedicadas. | IA, dashboards, post-mortems. |

El logger (`src/utils/logger.ts`) emite a ambos. El sink a BD vive en `src/services/log.service.ts` y batchea inserts.

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
| IA | `ai.*` | `ai.response.generated`, `ai.response.failed`, `ai.tool.*`, `ai.noreply.decided` |
| Kapso | `kapso.*` | `kapso.send.ok`, `kapso.send.failed`, `kapso.mark_read` |
| Reminders | `reminder.*` | `reminder.scheduled`, `reminder.triggered`, `reminder.failed` |
| Sistema | `support.notified` | — |

## Consultas típicas para la IA

Timeline completo de una conversación:
```sql
select * from v_conversation_timeline
where conversacion_id = $1
order by created_at;
```

Drill-down por request_id (todo lo que pasó en un webhook):
```sql
select * from fn_request_trace($1);
```

Ratios del último día, agrupados por outcome:
```sql
select * from v_daily_outcome_ratios where day = current_date;
```

Top reasons detrás de los fallbacks/failures de la semana:
```sql
select * from v_reason_breakdown_7d where outcome = 'fallback';
```

## Cómo agregar un código nuevo

1. Definir la entrada en `LOG_EVENTS` (o `LOG_REASONS`) en `src/utils/log-events.ts`. Documentar cuándo se emite.
2. Importar y usarlo desde el call site con `logger.event()`.
3. Si encaja en un dashboard o métrica, agregar view/RPC en `sql/add_logs_eventos_ai_fields.sql` (o nueva migración).
