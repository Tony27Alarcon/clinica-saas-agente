/**
 * Vocabulario cerrado de eventos y razones para logs estructurados.
 *
 * Cualquier `event_code` o `reason` que se persista en `logs_eventos` debe
 * venir de estos enums. Vocabulario cerrado = la IA puede filtrar, contar
 * y agrupar sin parsear prosa libre.
 *
 * Guía para agregar nuevos valores:
 *  - `event_code`: formato `<dominio>.<objeto>.<accion>`, minúsculas, con puntos.
 *    Ejemplos: `webhook.received`, `pipeline.stage.completed`.
 *  - `reason`: snake_case, describe la causa específica. Si vas a usar la misma
 *    reason en dos event_codes distintos, está bien — es reutilizable.
 *  - Siempre documentar cuándo se emite. Sin eso, el próximo que lo lea (humano
 *    o IA) no sabe si aplica a su caso.
 */

// ============================================================================
// Event codes
// ============================================================================

export const LOG_EVENTS = {
    // --- Webhook (entrada) ----------------------------------------------------
    /** Llegó un evento del webhook y empezamos a procesarlo. */
    WEBHOOK_RECEIVED:          'webhook.received',
    /** Evento descartado por ser duplicado (mismo messageId ya procesado). */
    WEBHOOK_DEDUPED:           'webhook.deduped',
    /** Se envió el fallback "no pude visualizarlo" porque el mensaje era ilegible. */
    WEBHOOK_FALLBACK_SENT:     'webhook.fallback.sent',
    /** Mensaje saliente (direction!=inbound) guardado sin pasar por IA. */
    WEBHOOK_OUTBOUND_SAVED:    'webhook.outbound.saved',
    /** Evento ignorado por ausencia de datos mínimos (sin texto ni media). */
    WEBHOOK_IGNORED_EMPTY:     'webhook.ignored.empty',

    // --- Routing multi-tenant ------------------------------------------------
    /** phoneNumberId coincidió con una clínica registrada → pipeline clínicas. */
    ROUTE_TENANT_MATCHED:      'route.tenant.matched',
    /** phoneNumberId no pertenece a ninguna clínica → evento descartado. */
    ROUTE_TENANT_UNKNOWN:      'route.tenant.unknown',
    /** Se detectó staff (admin pipeline) en vez de paciente. */
    ROUTE_ADMIN_DETECTED:      'route.admin.detected',

    // --- Pipeline (stages A..G) ----------------------------------------------
    PIPELINE_STAGE_STARTED:    'pipeline.stage.started',
    PIPELINE_STAGE_COMPLETED:  'pipeline.stage.completed',
    PIPELINE_STAGE_FAILED:     'pipeline.stage.failed',
    /** Guardarraíl: bucle detectado (mismos mensajes repetidos). */
    PIPELINE_LOOP_DETECTED:    'pipeline.loop.detected',
    /** Comando /borrar ejecutado: contacto reseteado. */
    PIPELINE_CONTACT_RESET:    'pipeline.contact.reset',

    // --- IA ------------------------------------------------------------------
    AI_RESPONSE_GENERATED:     'ai.response.generated',
    AI_RESPONSE_FAILED:        'ai.response.failed',
    AI_TOOL_CALLED:            'ai.tool.called',
    AI_TOOL_FAILED:            'ai.tool.failed',
    AI_NOREPLY_DECIDED:        'ai.noreply.decided',
    /** Segunda llamada forzada porque la primera no generó texto tras tool calls. */
    AI_FOLLOWUP_FORCED:        'ai.followup.forced',

    // --- Prompt Rebuild ------------------------------------------------------
    /** Rebuild del system_prompt completado tras cambio de config. */
    PROMPT_REBUILD_OK:         'prompt.rebuild.ok',
    /** Rebuild del system_prompt falló (fire-and-forget, no rompe pipeline). */
    PROMPT_REBUILD_FAILED:     'prompt.rebuild.failed',

    // --- Kapso (salida WhatsApp) ---------------------------------------------
    KAPSO_SEND_OK:             'kapso.send.ok',
    KAPSO_SEND_FAILED:         'kapso.send.failed',
    KAPSO_MARK_READ:           'kapso.mark_read',

    // --- Recordatorios -------------------------------------------------------
    REMINDER_SCHEDULED:        'reminder.scheduled',
    REMINDER_TRIGGERED:        'reminder.triggered',
    REMINDER_FAILED:           'reminder.failed',

    // --- Sistema --------------------------------------------------------------
    /** Notificación a soporte enviada (o suprimida por dedupe). */
    SUPPORT_NOTIFIED:          'support.notified',
} as const;

export type LogEventCode = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

// ============================================================================
// Outcomes (cerrado por CHECK constraint en la tabla)
// ============================================================================

export const LOG_OUTCOMES = {
    /** La operación se completó como se esperaba. */
    OK:       'ok',
    /** Se saltó intencionalmente (ej: duplicado, ya procesado). Sin error. */
    SKIPPED:  'skipped',
    /** Se recurrió a una respuesta de contingencia (ej: fallback al usuario). */
    FALLBACK: 'fallback',
    /** Falló inesperadamente (excepción, API externa caída, validación). */
    FAILED:   'failed',
    /** No hubo nada que hacer (ej: evento fuera de scope, silencio voluntario). */
    NOOP:     'noop',
} as const;

export type LogOutcome = (typeof LOG_OUTCOMES)[keyof typeof LOG_OUTCOMES];

// ============================================================================
// Reasons (vocabulario recomendado, extensible)
// ============================================================================
//
// A diferencia de event_code/outcome, `reason` es validado solo por convención:
// usar el enum cuando aplique, y si hace falta uno nuevo, agregarlo acá antes
// de usarlo. La tabla acepta cualquier text para no bloquear iteración rápida.

export const LOG_REASONS = {
    // --- Deduplicación / filtrado ---------------------------------------------
    DUPLICATE_MESSAGE_ID:        'duplicate_message_id',
    EMPTY_EVENT:                 'empty_event',
    OUTBOUND_DIRECTION:          'outbound_direction',

    // --- Fallback por mensaje no legible -------------------------------------
    TYPE_IN_UNREADABLE_SET:      'type_in_unreadable_set_and_no_text',
    UNKNOWN_MESSAGE_TYPE:        'unknown_message_type',

    // --- Loops / guardarraíles -----------------------------------------------
    ASSISTANT_LOOP_THRESHOLD:    'assistant_loop_threshold_reached',
    CONTACT_REPEATING_INPUT:     'contact_repeating_input',
    ASSISTANT_REPEATING_OUTPUT:  'assistant_repeating_output',

    // --- Routing --------------------------------------------------------------
    TENANT_NOT_REGISTERED:       'tenant_not_registered',
    STAFF_MATCHED_BY_PHONE:      'staff_matched_by_phone',

    // --- IA -------------------------------------------------------------------
    AI_PROVIDER_ERROR:           'ai_provider_error',
    AI_TOOL_NOT_FOUND:           'ai_tool_not_found',
    AI_NOREPLY_GUARDRAIL:        'ai_noreply_guardrail',
    AI_EMPTY_AFTER_RETRY:        'ai_empty_after_retry',

    // --- Prompt Rebuild -------------------------------------------------------
    PROMPT_REBUILD_ERROR:        'prompt_rebuild_error',

    // --- Kapso ----------------------------------------------------------------
    KAPSO_24H_WINDOW_CLOSED:     'kapso_24h_window_closed',
    KAPSO_API_ERROR:             'kapso_api_error',

    // --- Sistema --------------------------------------------------------------
    SUPPORT_DEDUPED:             'support_deduped',
    UNHANDLED_EXCEPTION:         'unhandled_exception',
} as const;

export type LogReason = (typeof LOG_REASONS)[keyof typeof LOG_REASONS] | string;
// ^ Permitimos string libre para no frenar al dev; la convención es usar el enum.
