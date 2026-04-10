import { createHash } from 'crypto';
import { KapsoService } from './kapso.service';
import { logger, getContext } from '../utils/logger';
import { env } from '../config/env';

// ============================================================================
// Rate limiter de notificaciones de soporte (in-memory, fingerprint-based)
// ============================================================================
//
// PROBLEMA:
//   Si Gemini está caído y llegan 50 mensajes al webhook, hoy el equipo de
//   soporte recibe 50 WhatsApps idénticos en pocos minutos. Esto es ruido y
//   puede saturarles el chat — peor aún, puede gatillar bloqueos anti-spam
//   de Meta si la frecuencia es muy alta.
//
// ESTRATEGIA: dedup por fingerprint con digest diferido.
//
//   1. Cada error tiene un `fingerprint` (típicamente: stage + mensaje del
//      error). Errores DISTINTOS son fingerprints distintos y no se afectan
//      entre sí — todos pasan.
//
//   2. La PRIMERA vez que vemos un fingerprint dentro de la ventana → se
//      notifica inmediatamente y arrancamos un timer de la ventana.
//
//   3. Las ocurrencias SUBSIGUIENTES dentro de la ventana → se suprimen y
//      se incrementa un contador interno. El equipo NO recibe nada por cada
//      una.
//
//   4. Cuando el timer expira (5 min por default), si el contador > 0
//      enviamos UN solo digest "este error pasó N veces más" con la primera
//      y última ocurrencia. Si fue 0 (el error no se repitió), no mandamos
//      nada.
//
// CONFIG:
//   - SUPPORT_NOTIFY_WINDOW_MS (env, default 300_000 = 5 min)
//
// EDGE CASES:
//   - Process restart: el state in-memory se pierde. El próximo error después
//     del restart pasa de toque (correcto: queremos saber si el problema
//     persiste tras un reinicio).
//   - Fingerprints distintos no se cruzan: si hay 3 errores diferentes, los
//     3 pasan inmediatamente y cada uno tiene su propia ventana.
//   - Timer.unref() hace que no impida shutdown del proceso (sí podemos
//     perder el último digest si el proceso muere antes de que dispare —
//     trade-off aceptable).

interface SuppressionState {
    fingerprint: string;
    firstSeenAt: number;
    lastSeenAt: number;
    suppressedCount: number;
    /** Snapshot del último cuerpo de notificación, usado en el digest. */
    lastBodyPreview: string;
    timer: NodeJS.Timeout;
}

// Función-flecha (no class static): evita el problema de `this` cuando el
// timer llama a un método. Más fácil de razonar y testear.
const SupportRateLimiter = (() => {
    const store = new Map<string, SuppressionState>();

    function readWindowMs(): number {
        const raw = process.env.SUPPORT_NOTIFY_WINDOW_MS;
        if (!raw) return 5 * 60_000;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
    }

    /**
     * Decide si una notificación con este fingerprint debe enviarse ahora.
     * Si retorna `allow=false`, también devuelve cuántas suprimimos hasta
     * el momento (útil para logs).
     *
     * Side-effect: registra el evento (creando la entrada o incrementando
     * el contador).
     */
    function checkAndRecord(
        fingerprint: string,
        bodyPreview: string,
        onDigestReady: (digest: DigestPayload) => void
    ): { allow: boolean; suppressedCount: number } {
        const now = Date.now();
        const existing = store.get(fingerprint);

        if (!existing) {
            // Primera vez en la ventana actual: dejamos pasar y arrancamos el timer.
            const windowMs = readWindowMs();
            const timer = setTimeout(() => {
                const final = store.get(fingerprint);
                store.delete(fingerprint);
                if (final && final.suppressedCount > 0) {
                    onDigestReady({
                        fingerprint,
                        firstSeenAt: final.firstSeenAt,
                        lastSeenAt: final.lastSeenAt,
                        suppressedCount: final.suppressedCount,
                        bodyPreview: final.lastBodyPreview,
                    });
                }
            }, windowMs);
            timer.unref?.();

            store.set(fingerprint, {
                fingerprint,
                firstSeenAt: now,
                lastSeenAt: now,
                suppressedCount: 0,
                lastBodyPreview: bodyPreview,
                timer,
            });
            return { allow: true, suppressedCount: 0 };
        }

        // Ya hay una entrada activa: suprimimos.
        existing.lastSeenAt = now;
        existing.suppressedCount++;
        existing.lastBodyPreview = bodyPreview;
        return { allow: false, suppressedCount: existing.suppressedCount };
    }

    /**
     * Cancela todos los timers pendientes y vacía el store. Útil para tests
     * y para shutdown gracioso.
     */
    function reset(): void {
        for (const state of store.values()) {
            clearTimeout(state.timer);
        }
        store.clear();
    }

    function stats() {
        return {
            activeFingerprints: store.size,
            windowMs: readWindowMs(),
        };
    }

    return { checkAndRecord, reset, stats };
})();

interface DigestPayload {
    fingerprint: string;
    firstSeenAt: number;
    lastSeenAt: number;
    suppressedCount: number;
    bodyPreview: string;
}

/**
 * Computa un fingerprint estable para dedup. Si el caller no pasa uno, lo
 * derivamos del cuerpo del mensaje (menos preciso pero mejor que nada).
 */
function computeFingerprint(explicit: string | undefined, contenido: string): string {
    const source = explicit && explicit.trim() ? explicit : contenido;
    return createHash('sha1').update(source).digest('hex').substring(0, 12);
}

function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString('es-CO', { hour12: false });
}

/**
 * Reintenta enviar todas las notificaciones WhatsApp pendientes para un
 * comercial. Se llama desde el webhook cuando el comercial escribe al WA
 * Business, lo que reabre la ventana de 24h con ese phone_number_id.
 *
 * - `phoneDestino`  : el phone actual del comercial (no el snapshot al
 *                     momento de crear la notificación).
 * - `phoneNumberId` : el del mensaje entrante del comercial; garantiza que
 *                     la ventana de 24h está abierta para ese par exacto.
 *
 * Envío secuencial: preserva orden cronológico, evita rate limits y permite
 * que un fallo individual no aborte el batch.
 */
export class NotificationService {

    // ========================================================================
    // SOPORTE: notificaciones al equipo cuando el sistema tiene un error.
    // ========================================================================
    //
    // El número de soporte se configura en `env.SUPPORT_PHONE_NUMBER`. Si no
    // está set, las notificaciones degradan a "solo log CRITICAL"
    // (no se rompe nada, pero el equipo no se entera por WhatsApp).

    /**
     * Crea una notificación de soporte y trata de enviarla por WhatsApp.
     * Si falla (típicamente por la ventana de 24h), queda en estado
     * `pendiente` para que `flushPendingForSupport` la reintente cuando
     * alguien del equipo escriba al WA Business.
     *
     * Esta función NUNCA tira excepciones: la idea es llamarla desde dentro
     * de catch blocks y handlers de error, donde un throw extra solo
     * empeoraría el problema.
     *
     * RATE LIMITING:
     *   Si la misma notificación (mismo `dedupeKey`) llega varias veces
     *   dentro de la ventana (`SUPPORT_NOTIFY_WINDOW_MS`, default 5 min),
     *   solo la primera se envía. Las demás se cuentan internamente y
     *   cuando expira la ventana se manda UN solo digest "este error pasó
     *   N veces más". Ver SupportRateLimiter arriba.
     *
     *   Si el caller no pasa `dedupeKey`, se computa uno desde el contenido
     *   completo (menos preciso porque incluye contexto que varía entre
     *   llamadas, pero igual evita el caso degenerado de "manda todo").
     *
     * @param contenido      Texto del WhatsApp a enviar al equipo (ya formateado).
     * @param phoneNumberId  El phone_number_id del WA Business desde el que
     *                       enviamos. Se hereda del evento que disparó el
     *                       error, así Meta ve la misma identidad de bot.
     * @param ctx            Contexto opcional para enriquecer el log y el
     *                       título de la notificación (qué contacto, qué
     *                       conv, qué stage, etc.). `dedupeKey` controla
     *                       el rate limiting (recomendado: "stage:errMsg").
     */
    static async notifySupport(
        contenido: string,
        phoneNumberId: string,
        ctx?: {
            tipo?: string;
            titulo?: string;
            referenciaTabla?: string;
            referenciaId?: number | string | null;
            dedupeKey?: string;
        }
    ): Promise<void> {
        const supportPhone = env.SUPPORT_PHONE_NUMBER;
        if (!supportPhone) {
            // No hay teléfono de soporte configurado: degradamos a CRITICAL
            // log. Esto deja rastro en logs_eventos sin romper el flujo.
            logger.critical(
                'notifySupport: SUPPORT_PHONE_NUMBER no configurado. Notificación NO enviada.',
                undefined,
                { contenidoPreview: contenido.substring(0, 200) }
            );
            return;
        }

        // ----- Rate limiter check -----
        // Si esta notificación viene del mismo error que ya avisamos, suprimimos.
        // El digest se dispara automáticamente cuando expira la ventana.
        const fingerprint = computeFingerprint(ctx?.dedupeKey, contenido);
        const decision = SupportRateLimiter.checkAndRecord(
            fingerprint,
            contenido,
            (digest) => {
                // Cuando la ventana expira y hubo errores suprimidos, mandamos
                // un digest reusando el mismo path de envío (sin re-aplicar
                // dedup, porque NotificationService.sendDigest pasa por el
                // helper interno que sí evita el limiter).
                void NotificationService.sendSupportDigest(digest, phoneNumberId);
            }
        );

        if (!decision.allow) {
            logger.info(
                `[Soporte] Notificación deduplicada (fingerprint=${fingerprint}, ${decision.suppressedCount} suprimidas hasta ahora)`
            );
            return;
        }

        await NotificationService._persistAndSendSupport(contenido, phoneNumberId, supportPhone, {
            tipo: ctx?.tipo || 'sistema_error',
            titulo: ctx?.titulo || 'Error de sistema',
        });
    }

    /**
     * Envía una notificación al equipo de soporte vía Kapso (fire-and-forget).
     * No persiste en BD. Si el envío falla, queda en logs CRITICAL.
     * Nunca tira excepciones.
     */
    private static async _persistAndSendSupport(
        contenido: string,
        phoneNumberId: string,
        supportPhone: string,
        meta: { tipo: string; titulo: string }
    ): Promise<void> {
        try {
            await KapsoService.enviarMensaje(supportPhone, contenido, phoneNumberId);
            logger.info(`[Soporte] Notificación enviada al equipo (${meta.tipo})`);
        } catch (err) {
            logger.critical(
                'notifySupport: envío WA falló',
                err,
                { contenidoPreview: contenido.substring(0, 200) }
            );
        }
    }

    /**
     * Construye y envía un digest de errores suprimidos. Lo invoca el rate
     * limiter cuando expira la ventana de un fingerprint y hubo más de cero
     * supresiones.
     *
     * El digest reusa el path interno `_persistAndSendSupport` (sin pasar
     * de nuevo por el limiter, para evitar loops infinitos). Queda guardado
     * en la tabla `notificaciones` con `tipo='sistema_error_digest'` para
     * poder distinguirlo del primer aviso.
     */
    static async sendSupportDigest(
        digest: DigestPayload,
        phoneNumberId: string
    ): Promise<void> {
        const supportPhone = env.SUPPORT_PHONE_NUMBER;
        if (!supportPhone) return;

        const durationMs = digest.lastSeenAt - digest.firstSeenAt;
        const durationStr = durationMs < 60_000
            ? `${Math.round(durationMs / 1000)}s`
            : `${Math.round(durationMs / 60_000)}min`;

        const cuerpo = [
            '🔁 *Resumen de errores suprimidos*',
            '',
            `El siguiente error ocurrió *${digest.suppressedCount} veces más* en una ventana de ~${durationStr}, después del primer aviso.`,
            '',
            `• Fingerprint: \`${digest.fingerprint}\``,
            `• Primera vez: ${formatTime(digest.firstSeenAt)}`,
            `• Última vez: ${formatTime(digest.lastSeenAt)}`,
            '',
            '*Último cuerpo del error:*',
            digest.bodyPreview.length > 800
                ? digest.bodyPreview.substring(0, 800) + '\n…(truncado)'
                : digest.bodyPreview,
        ].join('\n');

        logger.info(
            `[Soporte] Enviando digest para fingerprint=${digest.fingerprint} (${digest.suppressedCount} ocurrencias suprimidas)`
        );

        await NotificationService._persistAndSendSupport(cuerpo, phoneNumberId, supportPhone, {
            tipo: 'sistema_error_digest',
            titulo: `Resumen: ${digest.suppressedCount} errores suprimidos`,
        });
    }

    /**
     * Stats útiles para healthcheck o debug del rate limiter.
     */
    static getSupportRateLimiterStats() {
        return SupportRateLimiter.stats();
    }

    /**
     * Helper que arma el cuerpo del WhatsApp de error de sistema con todo el
     * contexto disponible (request_id, contacto, stage, error). Usado por el
     * controller cuando captura una excepción en processEvent.
     *
     * Lo dejamos acá (no en el controller) para que el formato sea consistente
     * y testeable, y para mantener al controller delgado.
     */
    static buildSystemErrorBody(args: {
        message: string;
        error: unknown;
        eventPreview?: Record<string, unknown>;
    }): string {
        const ctx = getContext() || {};
        const errMsg =
            args.error instanceof Error
                ? args.error.message
                : args.error
                ? String(args.error)
                : '(sin mensaje)';

        const lines: string[] = [
            '🚨 *Error de sistema*',
            '',
            args.message,
            '',
        ];

        if (ctx.requestId) lines.push(`• Request ID: \`${ctx.requestId}\``);
        if (ctx.contacto) lines.push(`• Contacto: ${ctx.contacto}`);
        if (ctx.contactoId !== undefined) lines.push(`• Contacto ID: ${ctx.contactoId}`);
        if (ctx.conversacionId !== undefined) lines.push(`• Conversación: ${ctx.conversacionId}`);
        if (ctx.stage) lines.push(`• Stage: ${ctx.stage}`);
        if (ctx.tipo) lines.push(`• Tipo de mensaje: ${ctx.tipo}`);

        lines.push('');
        lines.push(`*Error:* ${errMsg.substring(0, 500)}`);

        if (args.eventPreview && Object.keys(args.eventPreview).length > 0) {
            try {
                lines.push('');
                lines.push(`Evento: \`${JSON.stringify(args.eventPreview).substring(0, 300)}\``);
            } catch {
                /* ignore */
            }
        }

        return lines.join('\n');
    }
}
