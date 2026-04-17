import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * Logger estructurado para depuración intensiva.
 *
 * Objetivos:
 *  - Correlation IDs: cada webhook (y cada evento dentro de un batch) recibe un
 *    `requestId` corto que se propaga AUTOMÁTICAMENTE a través de await/Promise
 *    chains gracias a AsyncLocalStorage. Así puedes filtrar los logs de un solo
 *    contacto incluso cuando 5 webhooks se procesan en paralelo y los logs se
 *    entremezclan.
 *  - Niveles: DEBUG / INFO / WARN / ERROR / CRITICAL. CRITICAL es para fallos
 *    que pueden dejar a un usuario en visto (process crash, unhandled rejection,
 *    excepciones que rompen el pipeline). Aparecen con separadores visuales.
 *  - Stages: helper para los Steps A-G del controller con timing automático.
 *    Si una etapa falla, queda registrado QUÉ etapa, CUÁNTO tardó y CON QUÉ
 *    contexto.
 *  - Marcadores visibles: todos los errores empiezan con un emoji distintivo
 *    para que sean imposibles de pasar por alto cuando estás depurando.
 *
 * Uso típico:
 *
 *   await logger.runWithContext({ requestId, contacto: from }, async () => {
 *       logger.info('procesando webhook');
 *       await logger.stage('A', 'getOrCreateContacto', () => DbService.getOrCreateContacto(...));
 *       logger.critical('todo se rompió', error, { algo: 'extra' });
 *   });
 */

// ============================================================================
// Tipos y configuración
// ============================================================================

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface LogContext {
    /** Correlation ID corto (8 chars) que identifica un evento webhook puntual. */
    requestId?: string;
    /** Teléfono del contacto, si aplica. */
    contacto?: string;
    /** ID del contacto en BD (numérico). */
    contactoId?: number | string;
    /** ID de la conversación en BD. */
    conversacionId?: number | string;
    /** wamid del mensaje de WhatsApp, si aplica. */
    messageId?: string;
    /** Etapa actual del pipeline (A, B, C, D, E, F, G). */
    stage?: string;
    /** Cualquier metadata adicional. */
    [k: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
    CRITICAL: 50,
};

const LEVEL_MARKER: Record<LogLevel, string> = {
    DEBUG: '·',
    INFO: 'ℹ',
    WARN: '⚠️ ',
    ERROR: '🔴',
    CRITICAL: '💥',
};

// Nivel mínimo a imprimir. Configurable vía env LOG_LEVEL=DEBUG|INFO|WARN|ERROR|CRITICAL.
const MIN_LEVEL: LogLevel =
    (process.env.LOG_LEVEL as LogLevel) && LEVEL_PRIORITY[(process.env.LOG_LEVEL as LogLevel)]
        ? (process.env.LOG_LEVEL as LogLevel)
        : 'INFO';

// ============================================================================
// AsyncLocalStorage: propaga el contexto a través de await/Promise chains
// ============================================================================

const als = new AsyncLocalStorage<LogContext>();

/** Genera un requestId corto (8 chars) basado en UUID v4. */
export function newRequestId(): string {
    return randomUUID().replace(/-/g, '').substring(0, 8);
}

/** Devuelve el contexto activo (o undefined si no hay). */
export function getContext(): LogContext | undefined {
    return als.getStore();
}

// ============================================================================
// Formateo
// ============================================================================

function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function formatContext(ctx: LogContext | undefined): string {
    if (!ctx) return '';
    const parts: string[] = [];
    if (ctx.requestId) parts.push(`req=${ctx.requestId}`);
    if (ctx.contacto) parts.push(`tel=${ctx.contacto}`);
    if (ctx.conversacionId !== undefined) parts.push(`conv=${ctx.conversacionId}`);
    if (ctx.stage) parts.push(`stage=${ctx.stage}`);
    return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

function formatExtra(extra: Record<string, unknown> | undefined): string {
    if (!extra || Object.keys(extra).length === 0) return '';
    try {
        return ` ${JSON.stringify(extra)}`;
    } catch {
        return ' [extra: no serializable]';
    }
}

// ============================================================================
// Sinks: suscriptores que reciben cada log emitido (ej: persistencia en BD).
// ============================================================================
//
// Pattern de "publish-subscribe" para que el logger NO conozca Supabase ni
// ningún otro destino externo. El LogService se registra acá al startup.
//
// Cada sink corre en su propio try/catch: si un sink revienta, los demás
// (y la salida a consola) siguen funcionando intactos. Esto es crítico para
// que un Supabase caído NO se lleve también los logs locales.

/** Forma normalizada de un log que llega a los sinks. */
export interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: string;
    context: LogContext;
    /** Detalle del error si lo hay (separado por conveniencia). */
    error?: { message: string; stack?: string };
    /** Metadata adicional libre. */
    extra?: Record<string, unknown>;
    // ---- Campos estructurados para consumo por IA (opcionales) -------------
    /** Código enumerado del evento (ver src/utils/log-events.ts). */
    eventCode?: string;
    /** ok | skipped | fallback | failed | noop */
    outcome?: string;
    /** snake_case, causa específica de la decisión. */
    reason?: string;
    /** Una línea ≤120 chars, autoexplicativa. */
    summary?: string;
}

/** Payload del método `logger.event()` — log pensado para consumo por IA. */
export interface LogEventPayload {
    /** Código enumerado (usar LOG_EVENTS en src/utils/log-events.ts). */
    code: string;
    /** ok | skipped | fallback | failed | noop */
    outcome: 'ok' | 'skipped' | 'fallback' | 'failed' | 'noop';
    /** Una línea autoexplicativa ≤120 chars. Se trunca si es más larga. */
    summary: string;
    /** Causa específica en snake_case. Opcional pero muy recomendado. */
    reason?: string;
    /** Payload plano y chico (<20 keys, <2KB). */
    data?: Record<string, unknown>;
    /** Error original si el outcome es failed. */
    error?: unknown;
    /**
     * Level explícito si la heurística por defecto no encaja. Por default:
     *   failed   → ERROR
     *   fallback → WARN
     *   skipped  → INFO
     *   ok       → INFO
     *   noop     → DEBUG
     */
    level?: LogLevel;
}

export type LogSink = (entry: LogEntry) => void;

const sinks: LogSink[] = [];

/**
 * Suscribe un sink al logger. Todos los logs emitidos a partir de ahora
 * (de cualquier nivel >= MIN_LEVEL) van a recibir una `LogEntry`.
 *
 * El sink DEBE ser fire-and-forget: no devolver promesas que importen, no
 * lanzar excepciones que importen. Cualquier excepción se silencia.
 */
export function addLogSink(sink: LogSink): void {
    sinks.push(sink);
}

/** Reset (útil para tests). No se usa en runtime normal. */
export function _resetLogSinksForTests(): void {
    sinks.length = 0;
}

function dispatchToSinks(entry: LogEntry): void {
    if (sinks.length === 0) return;
    for (const sink of sinks) {
        try {
            sink(entry);
        } catch {
            // Silenciado a propósito: un sink roto no debe romper el log a consola
            // ni a los demás sinks. Tampoco usamos logger.error acá porque eso
            // podría crear recursión infinita (sink → error → sink → ...).
        }
    }
}

function emit(level: LogLevel, message: string, extra?: Record<string, unknown>) {
    if (!shouldLog(level)) return;

    const ctx = als.getStore();
    const ts = new Date().toISOString();
    const marker = LEVEL_MARKER[level];
    const ctxStr = formatContext(ctx);
    const extraStr = formatExtra(extra);

    const line = `[${level}] ${marker} [${ts}]${ctxStr} ${message}${extraStr}`;

    if (level === 'ERROR' || level === 'CRITICAL') {
        console.error(line);
    } else if (level === 'WARN') {
        console.warn(line);
    } else {
        console.log(line);
    }

    // Despachar a sinks externos (BD, etc.).
    // El campo `error` se reconstruye a partir de extra.error si vino así
    // (lo arma el helper logger.error / logger.critical).
    const entry: LogEntry = {
        level,
        message,
        timestamp: ts,
        context: ctx ? { ...ctx } : {},
        extra,
    };
    if (extra && typeof extra.error === 'string') {
        entry.error = { message: extra.error as string };
    }
    dispatchToSinks(entry);
}

// ============================================================================
// API pública
// ============================================================================

export const logger = {
    /** Nivel mínimo activo (útil para tests/debug). */
    minLevel: MIN_LEVEL,

    debug: (message: string, extra?: Record<string, unknown>) => emit('DEBUG', message, extra),
    info: (message: string, extra?: Record<string, unknown>) => emit('INFO', message, extra),
    warn: (message: string, extra?: Record<string, unknown>) => emit('WARN', message, extra),

    /**
     * Error recuperable: el pipeline tropezó pero el sistema sigue funcionando.
     * Ej: una notificación a comercial falla por la ventana de 24h y queda en
     * outbox. El usuario igual recibe respuesta.
     */
    error: (message: string, err?: unknown, extra?: Record<string, unknown>) => {
        if (!shouldLog('ERROR')) return;
        const ctx = als.getStore();
        const ts = new Date().toISOString();
        const errMsg = err instanceof Error ? err.message : err !== undefined ? String(err) : '';
        const stack = err instanceof Error && err.stack ? err.stack : '';

        // 1. Salida a consola (idéntica a antes: extra.error embebido para grep).
        const merged = { ...(extra || {}), ...(errMsg ? { error: errMsg } : {}) };
        const marker = LEVEL_MARKER.ERROR;
        const ctxStr = formatContext(ctx);
        const extraStr = formatExtra(merged);
        console.error(`[ERROR] ${marker} [${ts}]${ctxStr} ${message}${extraStr}`);

        // 2. Dispatch a sinks con stack separado (no se pierde como sí pasaría
        //    si pasáramos por emit() — emit no tiene acceso al Error original).
        const entry: LogEntry = {
            level: 'ERROR',
            message,
            timestamp: ts,
            context: ctx ? { ...ctx } : {},
            extra,
        };
        if (errMsg) {
            entry.error = { message: errMsg, stack: stack || undefined };
        }
        dispatchToSinks(entry);
    },

    /**
     * Error catastrófico: el pipeline NO pudo darle respuesta al usuario, o
     * peor, el proceso podría estar inestable. Estos errores requieren atención
     * inmediata. Aparecen con separadores visuales prominentes en consola Y
     * también se despachan a los sinks (con stack trace completo).
     */
    critical: (message: string, err?: unknown, extra?: Record<string, unknown>) => {
        if (!shouldLog('CRITICAL')) return;
        const ctx = als.getStore();
        const ts = new Date().toISOString();
        const errMsg = err instanceof Error ? err.message : err !== undefined ? String(err) : '';
        const stack = err instanceof Error && err.stack ? err.stack : '';

        // ----- 1. Salida visual a consola con separadores -----
        const sep = '═'.repeat(78);
        console.error('');
        console.error(`💥 ${sep}`);
        console.error(`💥 [CRITICAL] [${ts}]${formatContext(ctx)}`);
        console.error(`💥 ${message}`);
        if (errMsg) console.error(`💥 Error: ${errMsg}`);
        if (extra && Object.keys(extra).length > 0) {
            try {
                console.error(`💥 Context: ${JSON.stringify(extra)}`);
            } catch {
                console.error(`💥 Context: [no serializable]`);
            }
        }
        if (stack) {
            console.error(`💥 Stack:`);
            for (const line of stack.split('\n').slice(0, 10)) {
                console.error(`💥   ${line.trim()}`);
            }
        }
        console.error(`💥 ${sep}`);
        console.error('');

        // ----- 2. Dispatch a sinks (BD, etc.) con stack completo -----
        const entry: LogEntry = {
            level: 'CRITICAL',
            message,
            timestamp: ts,
            context: ctx ? { ...ctx } : {},
            extra,
        };
        if (errMsg) {
            entry.error = { message: errMsg, stack: stack || undefined };
        }
        dispatchToSinks(entry);
    },

    // ------------------------------------------------------------------------
    // Logs estructurados para consumo por IA
    // ------------------------------------------------------------------------

    /**
     * Emite un log estructurado pensado para ser leído por una IA.
     *
     * A diferencia de `info/warn/error` (mensaje libre), este método exige:
     *   - `code`      : vocabulario cerrado (ver LOG_EVENTS)
     *   - `outcome`   : ok|skipped|fallback|failed|noop
     *   - `summary`   : una línea autoexplicativa
     * y opcionalmente `reason` y `data`.
     *
     * Se persiste en `logs_eventos` poblando las columnas dedicadas
     * (event_code, outcome, reason, summary), para que la IA pueda
     * filtrar/agrupar sin parsear prosa.
     *
     * Uso:
     *   logger.event({
     *       code: LOG_EVENTS.WEBHOOK_FALLBACK_SENT,
     *       outcome: 'fallback',
     *       reason: LOG_REASONS.TYPE_IN_UNREADABLE_SET,
     *       summary: `Fallback enviado: tipo=${messageType} sin texto`,
     *       data: { messageType, rawType: event.type },
     *   });
     */
    event: (payload: LogEventPayload) => {
        // Heurística de nivel por outcome si no vino explícito.
        const level: LogLevel =
            payload.level ??
            (payload.outcome === 'failed'   ? 'ERROR'
             : payload.outcome === 'fallback' ? 'WARN'
             : payload.outcome === 'noop'     ? 'DEBUG'
             : 'INFO');

        if (!shouldLog(level)) return;

        const ctx = als.getStore();
        const ts = new Date().toISOString();

        // Truncar summary defensivo (la columna en DB asume ≤120, pero
        // no pusimos CHECK para no romper flush si alguien se pasa).
        const summary =
            payload.summary.length > 200
                ? payload.summary.substring(0, 197) + '...'
                : payload.summary;

        // Mensaje humano para consola: `[event.code] summary`.
        // Sigue el formato del resto de logs así no rompemos la vista en Railway.
        const humanMessage = `[${payload.code}] ${summary}`;

        // Extra unificado: data + metadata estructural (para que los humanos
        // que miren consola vean contexto también).
        const consoleExtra: Record<string, unknown> = {
            outcome: payload.outcome,
            ...(payload.reason ? { reason: payload.reason } : {}),
            ...(payload.data || {}),
        };

        const marker = LEVEL_MARKER[level];
        const ctxStr = formatContext(ctx);
        const extraStr = formatExtra(consoleExtra);
        const line = `[${level}] ${marker} [${ts}]${ctxStr} ${humanMessage}${extraStr}`;

        if (level === 'ERROR' || level === 'CRITICAL') console.error(line);
        else if (level === 'WARN') console.warn(line);
        else console.log(line);

        // Entry para el sink: campos estructurados poblados.
        const errMsg =
            payload.error instanceof Error ? payload.error.message
            : payload.error !== undefined  ? String(payload.error)
            : undefined;
        const stack = payload.error instanceof Error ? payload.error.stack : undefined;

        const entry: LogEntry = {
            level,
            message: humanMessage,
            timestamp: ts,
            context: ctx ? { ...ctx } : {},
            extra: payload.data,
            eventCode: payload.code,
            outcome: payload.outcome,
            reason: payload.reason,
            summary,
        };
        if (errMsg) entry.error = { message: errMsg, stack };
        dispatchToSinks(entry);
    },

    /**
     * Azúcar para el patrón "registré una decisión del pipeline".
     * Equivalente a `event()` pero con nombres más cortos y un outcome default
     * de 'skipped' (el caso más común al registrar una rama del flujo).
     */
    decision: (
        code: string,
        payload: Omit<LogEventPayload, 'code' | 'outcome'> & { outcome?: LogEventPayload['outcome'] }
    ) => {
        logger.event({
            code,
            outcome: payload.outcome ?? 'skipped',
            summary: payload.summary,
            reason: payload.reason,
            data: payload.data,
            error: payload.error,
            level: payload.level,
        });
    },

    // ------------------------------------------------------------------------
    // Context helpers
    // ------------------------------------------------------------------------

    /**
     * Ejecuta `fn` dentro de un contexto de logging. Todos los logs emitidos
     * durante `fn` (y sus chains async) heredarán automáticamente el `ctx`.
     *
     * Uso típico en el webhook controller:
     *   await logger.runWithContext({ requestId, contacto: from }, async () => {
     *       // ... toda la lógica del evento ...
     *   });
     */
    runWithContext: <T>(ctx: LogContext, fn: () => Promise<T> | T): Promise<T> | T => {
        // Hereda lo que ya hubiera en el store (poco común, pero útil para anidar).
        const merged = { ...(als.getStore() || {}), ...ctx };
        return als.run(merged, fn);
    },

    /**
     * Mezcla campos al contexto activo (mutación in-place del store actual).
     * Útil cuando recién aprendes el contactoId o conversacionId a mitad del
     * pipeline y quieres que los logs subsiguientes lo lleven automáticamente.
     */
    enrichContext: (extra: LogContext) => {
        const store = als.getStore();
        if (store) Object.assign(store, extra);
    },

    /**
     * Wrapper para una "etapa" del pipeline (Step A, B, C, ...).
     *
     * - Loggea inicio (`▶ stage A: ...`)
     * - Ejecuta la función
     * - Loggea fin con duración (`✓ stage A: ... (123ms)`)
     * - Si falla, loggea ERROR con duración + qué stage explotó y RE-LANZA la
     *   excepción para que el caller pueda decidir qué hacer.
     *
     * Uso:
     *   const contacto = await logger.stage('A', 'getOrCreateContacto',
     *       () => DbService.getOrCreateContacto(from, name));
     */
    stage: async <T>(
        id: string,
        nombre: string,
        fn: () => Promise<T>
    ): Promise<T> => {
        const store = als.getStore();
        const prevStage = store?.stage;
        if (store) store.stage = id;

        const t0 = Date.now();
        emit('INFO', `▶ Step ${id}: ${nombre}`);
        try {
            const result = await fn();
            const dur = Date.now() - t0;
            emit('INFO', `✓ Step ${id}: ${nombre} (${dur}ms)`);
            return result;
        } catch (err) {
            const dur = Date.now() - t0;
            const msg = err instanceof Error ? err.message : String(err);
            emit('ERROR', `✗ Step ${id}: ${nombre} FALLÓ tras ${dur}ms: ${msg}`);
            throw err;
        } finally {
            if (store) store.stage = prevStage;
        }
    },
};

// ============================================================================
// Utilidades extra
// ============================================================================

/**
 * Convierte cualquier valor en un string de error razonable. Útil para
 * normalizar `catch (err: unknown)` sin perder información.
 */
export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}
