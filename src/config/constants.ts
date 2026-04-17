/**
 * Constantes generales del runtime. Valores "mágicos" que necesitan nombre
 * para ser reutilizados y entendidos sin contexto extra.
 */

// ── Modo Test (staff → /test) ───────────────────────────────────────────────
/** TTL de una sesión de test: 20 min desde que se abre. */
export const TEST_MODE_TTL_MS = 20 * 60 * 1000;

/** Comandos que el staff puede mandar por WhatsApp (case-insensitive, trim). */
export const TEST_MODE_COMMANDS = {
    START: '/test',
    EXIT:  '/exit',
} as const;

/** Copys estándar del modo test. */
export const TEST_MODE_COPY = {
    start: (minutes: number) =>
        `🧪 *Modo test activado.*\n` +
        `Ahora estás conversando con el agente público como si fueras un paciente nuevo.\n` +
        `Dura *${minutes} min* o hasta que mandes */exit*.`,
    alreadyActive: (remaining: number) =>
        `Ya estás en modo test. Te quedan ~${remaining} min. Mandá */exit* para salir.`,
    exited: (summary: string) =>
        `✅ *Modo test cerrado.*\n\n*Resumen de la prueba:*\n${summary}`,
    timeoutOnNextMessage:
        `⌛ Tu modo test expiró por tiempo. Lo cerré y te dejé el resumen en admin.`,
    noActiveSession:
        `No tenés una sesión de test activa. Mandá */test* para abrir una.`,
} as const;
