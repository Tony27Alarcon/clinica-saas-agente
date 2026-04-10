import { supabase } from '../config/supabase';
import type { LogEntry, LogLevel } from '../utils/logger';

/**
 * Sink que persiste los logs del backend en la tabla `public.logs_eventos`
 * de Supabase, con buffer en memoria + batch insert.
 *
 * ¿Por qué buffer en memoria?
 *   Hacer un INSERT por log mata Supabase: cada webhook puede emitir 10-30
 *   logs en pocos cientos de milisegundos. Bufferear y batchear baja eso a
 *   1 INSERT por segundo (aprox), preservando el orden cronológico.
 *
 * Garantías:
 *   - NUNCA llama al logger (usa console.error directamente para sus propios
 *     errores). Esto evita recursión infinita si Supabase está caído.
 *   - NUNCA tira excepciones hacia arriba (todos los errores se silencian o
 *     se imprimen a console.error). El sink debe ser fire-and-forget.
 *   - Hard cap de buffer (1000 entries por defecto): si supabase está caído
 *     mucho tiempo, descartamos los más viejos antes que comerse toda la RAM.
 *   - Flush gracioso vía `LogService.flush()` para llamarlo desde SIGTERM y
 *     no perder el último batch al reiniciar.
 *
 * Configuración (env vars opcionales):
 *   - LOG_PERSIST_LEVEL    : nivel mínimo a persistir (default: INFO)
 *   - LOG_BATCH_SIZE       : flush cuando el buffer llegue a este size (default: 50)
 *   - LOG_FLUSH_INTERVAL_MS: flush cada N ms aunque el buffer no esté lleno (default: 2000)
 *   - LOG_BUFFER_HARD_CAP  : tamaño máximo del buffer antes de descartar viejos (default: 1000)
 */

// ============================================================================
// Tipos
// ============================================================================

/** Forma exacta que se inserta en `public.logs_eventos`. */
interface LogRow {
    created_at: string;
    level: string;
    message: string;
    request_id: string | null;
    contacto_id: number | null;
    conversacion_id: number | null;
    stage: string | null;
    tipo: string | null;
    error_message: string | null;
    error_stack: string | null;
    extra: Record<string, unknown> | null;
}

// ============================================================================
// Configuración
// ============================================================================

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
    CRITICAL: 50,
};

function readEnvLevel(): LogLevel {
    const raw = process.env.LOG_PERSIST_LEVEL as LogLevel | undefined;
    if (raw && raw in LEVEL_PRIORITY) return raw;
    return 'INFO';
}

function readEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

const PERSIST_LEVEL: LogLevel = readEnvLevel();
const BATCH_SIZE: number = readEnvNumber('LOG_BATCH_SIZE', 50);
const FLUSH_INTERVAL_MS: number = readEnvNumber('LOG_FLUSH_INTERVAL_MS', 2000);
const HARD_CAP: number = readEnvNumber('LOG_BUFFER_HARD_CAP', 1000);

// ============================================================================
// Service
// ============================================================================

export class LogService {
    private static buffer: LogRow[] = [];
    private static flushTimer: NodeJS.Timeout | null = null;
    private static isFlushing = false;
    private static droppedCount = 0;

    /**
     * Sanitiza datos sensibles (PII/PHI) antes de persistirlos.
     * Limpia teléfonos, emails, tokens y campos clínicos conocidos.
     */
    private static sanitize<T>(input: T): T {
        if (!input) return input;

        const PII_PATTERNS = {
            // Teléfonos: busca secuencias de 8+ dígitos que parecen números
            phone: /\b(?:\+?(\d{1,3}))?[-. (]*(\d{3})[-. )]*(\d{3})[-. ]*(\d{2,4})\b/g,
            // Emails: patrón estándar
            email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
            // Secretos: busca asignaciones a variables tipo token/key/secret
            secrets: /(token|key|secret|auth|password|password_id)["']?\s*[:=]\s*["']?([^"'\s,]+)["']?/gi,
        };

        const PHI_FIELDS = new Set([
            'allergies', 'medications', 'contraindications', 'expectations',
            'previous_treatments', 'notes', 'extra_data', 'reason'
        ]);

        const maskText = (text: string): string => {
            return text
                .replace(PII_PATTERNS.email, '[EMAIL_REDACTED]')
                .replace(PII_PATTERNS.phone, '[PHONE_REDACTED]')
                .replace(PII_PATTERNS.secrets, (match, key) => `${key}: [SECRET_REDACTED]`);
        };

        const maskObject = (obj: any): any => {
            if (obj === null || typeof obj !== 'object') return obj;
            if (Array.isArray(obj)) return obj.map(maskObject);

            const result: any = {};
            for (const [key, value] of Object.entries(obj)) {
                // Si el campo es PHI conocido, lo redactamos por completo
                if (PHI_FIELDS.has(key.toLowerCase())) {
                    result[key] = '[PHI_REDACTED]';
                    continue;
                }

                if (typeof value === 'string') {
                    result[key] = maskText(value);
                } else if (typeof value === 'object') {
                    result[key] = maskObject(value);
                } else {
                    result[key] = value;
                }
            }
            return result;
        };

        if (typeof input === 'string') return maskText(input) as unknown as T;
        if (typeof input === 'object') return maskObject(input) as unknown as T;
        return input;
    }

    /**
     * Convierte una `LogEntry` del logger a una row de la tabla. Tolerante a
     * tipos: si `contactoId` viene como string lo intenta parsear, si no lo
     * deja en null.
     */
    private static toRow(entry: LogEntry): LogRow {
        const ctx = entry.context || {};

        const toIntOrNull = (v: unknown): number | null => {
            if (v === undefined || v === null) return null;
            const n = typeof v === 'number' ? v : Number(v);
            return Number.isFinite(n) ? n : null;
        };

        // Limpia `extra`: si vino con `error` adentro (lo agrega logger.error
        // como string para grep en consola), lo sacamos para no duplicarlo
        // con la columna error_message dedicada.
        let cleanedExtra: Record<string, unknown> | null = null;
        if (entry.extra && typeof entry.extra === 'object') {
            const { error: _ignore, ...rest } = entry.extra as Record<string, unknown>;
            if (Object.keys(rest).length > 0) {
                // Aplicar sanitización profunda a la metadata extra
                cleanedExtra = LogService.sanitize(rest);
            }
        }

        return {
            created_at: entry.timestamp,
            level: entry.level,
            // Sanitizar el mensaje principal y los stacks de error
            message: LogService.sanitize(entry.message),
            request_id: typeof ctx.requestId === 'string' ? ctx.requestId : null,
            contacto_id: toIntOrNull(ctx.contactoId),
            conversacion_id: toIntOrNull(ctx.conversacionId),
            stage: typeof ctx.stage === 'string' ? ctx.stage : null,
            tipo: typeof ctx.tipo === 'string' ? ctx.tipo : null,
            error_message: entry.error?.message ? LogService.sanitize(entry.error.message) : null,
            error_stack: entry.error?.stack ? LogService.sanitize(entry.error.stack) : null,
            extra: cleanedExtra,
        };
    }

    /**
     * Punto de entrada del sink. NO ES async (debe retornar inmediato para no
     * bloquear al logger).
     */
    static enqueue(entry: LogEntry): void {
        // Filtro por nivel: si LOG_PERSIST_LEVEL=WARN, no persistir DEBUG/INFO.
        if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[PERSIST_LEVEL]) return;

        // Hard cap: si el buffer está saturado (Supabase caído por mucho tiempo),
        // tiramos los más viejos. Es preferible perder logs viejos a OOM-killear
        // el proceso entero.
        if (LogService.buffer.length >= HARD_CAP) {
            LogService.buffer.shift();
            LogService.droppedCount++;
            // Cada 100 descartes, gritamos a consola para que sea visible.
            if (LogService.droppedCount % 100 === 0) {
                console.error(
                    `[LogService] ⚠️  Descartados ${LogService.droppedCount} logs por buffer saturado (${HARD_CAP}). Supabase puede estar caído.`
                );
            }
        }

        try {
            LogService.buffer.push(LogService.toRow(entry));
        } catch (err) {
            // Algo raro pasó al serializar. Lo ignoramos para no romper al sink.
            console.error(
                `[LogService] No se pudo serializar entry: ${(err as Error).message}`
            );
            return;
        }

        // Disparar flush inmediato si llegamos al batch size.
        if (LogService.buffer.length >= BATCH_SIZE) {
            // Sin await: queremos retornar al logger ya. El flush corre en bg.
            void LogService.flush();
            return;
        }

        // Si no, asegurarse de que haya un timer pendiente.
        if (!LogService.flushTimer) {
            LogService.flushTimer = setTimeout(() => {
                LogService.flushTimer = null;
                void LogService.flush();
            }, FLUSH_INTERVAL_MS);
            // unref() para que el timer no impida que el proceso muera si todo
            // lo demás terminó (relevante para tests y para SIGTERM rápido).
            LogService.flushTimer.unref?.();
        }
    }

    /**
     * Vacía el buffer al BD. Idempotente y reentrant-safe (si ya hay un flush
     * en vuelo, esta llamada es noop). Siempre resuelve sin throw.
     */
    static async flush(): Promise<void> {
        if (LogService.isFlushing) return;
        if (LogService.buffer.length === 0) return;

        LogService.isFlushing = true;
        // Tomamos el batch ENTERO actual y dejamos el buffer vacío para que el
        // sink pueda seguir aceptando logs durante el insert.
        const batch = LogService.buffer.splice(0, LogService.buffer.length);

        try {
            const { error } = await supabase.from('logs_eventos').insert(batch);
            if (error) {
                // No usamos logger.* acá → recursión infinita si supabase está
                // caído. console.error directo.
                console.error(
                    `[LogService] Insert batch falló (${batch.length} entries): ${error.message}`
                );
                // Reinsertar al frente para reintentar en el próximo flush.
                // Si el buffer ya creció en el ínterin, los nuevos quedan
                // detrás de los reintentos (preserva orden cronológico).
                LogService.buffer.unshift(...batch);
            }
        } catch (err) {
            console.error(
                `[LogService] Excepción inesperada en flush: ${(err as Error).message}`
            );
            LogService.buffer.unshift(...batch);
        } finally {
            LogService.isFlushing = false;
        }

        // Si quedan entries (porque entró más tráfico durante el insert, o
        // porque el insert falló y reinsertamos), agendamos otro flush.
        if (LogService.buffer.length > 0 && !LogService.flushTimer) {
            LogService.flushTimer = setTimeout(() => {
                LogService.flushTimer = null;
                void LogService.flush();
            }, FLUSH_INTERVAL_MS);
            LogService.flushTimer.unref?.();
        }
    }

    /**
     * Para llamar desde SIGTERM/SIGINT: hace un flush sincrónico (best-effort)
     * antes de que el proceso muera.
     */
    static async drain(timeoutMs = 5000): Promise<void> {
        // Cancelar timer pendiente si lo hubiera.
        if (LogService.flushTimer) {
            clearTimeout(LogService.flushTimer);
            LogService.flushTimer = null;
        }

        const deadline = Date.now() + timeoutMs;
        while (LogService.buffer.length > 0 && Date.now() < deadline) {
            await LogService.flush();
            // Pequeña pausa para no spinear si flush falla.
            if (LogService.buffer.length > 0) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
    }

    /** Stats útiles para healthcheck o debug. */
    static stats() {
        return {
            bufferSize: LogService.buffer.length,
            droppedCount: LogService.droppedCount,
            persistLevel: PERSIST_LEVEL,
            batchSize: BATCH_SIZE,
            flushIntervalMs: FLUSH_INTERVAL_MS,
            hardCap: HARD_CAP,
        };
    }
}
