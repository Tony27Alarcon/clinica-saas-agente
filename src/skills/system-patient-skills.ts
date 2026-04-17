// =============================================================================
// System Patient Skills — Catálogo global de skills opcionales
//
// Skills predefinidas que cualquier empresa puede ACTIVAR/DESACTIVAR para su
// agente paciente. Mismo shape que AdminSkill (id, name, trigger, guidelines)
// para mantener un único protocolo en todo el sistema.
//
// Reglas:
// - Estas skills son COMPLEMENTARIAS a buildBaseAgentSkills() (que es no editable).
// - El admin de la empresa decide cuáles activar desde el panel /admin/.../skills.
// - Si una skill está desactivada, el prompt NO la incluye y el agente NO debe
//   "inventar" ese comportamiento (ver REGLAS FUNDAMENTALES).
// - El `id` es el contrato estable: nunca cambiarlo, solo deprecar.
// =============================================================================

import type { AdminSkill } from './admin-agent-skills';

// Reutilizamos la misma interfaz para que el protocolo sea único en el sistema.
export type PatientSkill = AdminSkill;

// ─── Skill: Manejo profesional de objeción de precio ────────────────────────

const objectionPrice: PatientSkill = {
    id: 'objection-price-pro',
    name: 'Manejo Avanzado de Objeción de Precio',
    trigger: 'Cuando el paciente exprese que el precio le parece alto, no tiene presupuesto, o pida descuento.',
    guidelines: `MANEJO DE OBJECIÓN DE PRECIO (NO IMPROVISAR):

1. Validar primero, defender después:
   - "Entiendo, es una inversión importante." → SIEMPRE empezar reconociendo.
   - Nunca decir "es barato" ni minimizar la preocupación.

2. Cambiar el marco de "costo" a "valor":
   - Habla del resultado y la duración del efecto, no del precio puro.
   - Ej: "Los resultados duran entre 6 y 9 meses, así que se traduce en ~X al mes."

3. Ofrecer alternativas concretas (sin inventar):
   - Si la empresa tiene financiación o promociones configuradas, mencionarlas.
   - Si no, ofrecer una valoración sin compromiso.
   - NUNCA prometer descuentos que no estén autorizados explícitamente.

4. No insistir más de 2 veces:
   - Si tras 2 turnos sigue la objeción, agendar valoración o escalar.
   - Presionar más allá daña la marca.`,
};

// ─── Skill: Confirmación y recordatorios anti no-show ───────────────────────

const appointmentConfirmation: PatientSkill = {
    id: 'appointment-confirmation',
    name: 'Confirmación de Cita Anti No-show',
    trigger: 'Inmediatamente después de cerrar una cita, y al enviar recordatorios programados.',
    guidelines: `PROTOCOLO DE CONFIRMACIÓN:

Al cerrar la cita (mismo turno):
- Resume en UNA burbuja: fecha, hora, tratamiento.
- En burbuja separada: dirección y preparación si aplica.
- Termina con micro-compromiso: "¿Te confirmo el turno?" — esto reduce no-show ~30%.

En el recordatorio (24h antes):
- Saludo breve y mención del turno: día y hora.
- Pregunta directa: "¿Sigues pudiendo venir?" (sí/no).
- Si responde NO o no responde en 4h → ofrecer reagendamiento, no insistir.

Anti no-show — qué hace y qué NO:
- SÍ: tono cálido, recordatorio claro, fácil reagendar.
- NO: tono culpabilizante ("recordá que reservás un cupo"), amenazas de cobro.`,
};

// ─── Skill: Reagendamiento sin fricción ─────────────────────────────────────

const rescheduling: PatientSkill = {
    id: 'rescheduling-flow',
    name: 'Reagendamiento Sin Fricción',
    trigger: 'Cuando el paciente pida cambiar, mover o cancelar una cita ya agendada.',
    guidelines: `FLUJO DE REAGENDAMIENTO:

1. Empatía primero, no juicio:
   - "Claro, sin problema. ¿Qué día te queda mejor?"
   - NUNCA: "Tu cita ya estaba confirmada" ni hacer sentir mal al paciente.

2. Ofrecer 2 horarios concretos al mismo tratamiento, no preguntar abierto.

3. Confirmar el cambio explícitamente:
   - "Listo, te muevo del [fecha vieja] al [fecha nueva]." (resumen claro)
   - Liberar el turno anterior internamente (no se le dice al paciente).

4. Si cancela definitivamente:
   - Aceptar sin intentar revertir.
   - Dejar puerta abierta: "Cuando quieras retomarlo, escríbeme."`,
};

// ─── Skill: Cross-sell sutil basado en catálogo ─────────────────────────────

const upsellSuggestion: PatientSkill = {
    id: 'gentle-cross-sell',
    name: 'Sugerencia Cruzada Sutil',
    trigger: 'Cuando el paciente ya confirmó un tratamiento y hay tratamientos complementarios en el catálogo.',
    guidelines: `CROSS-SELL CONSULTIVO (NUNCA AGRESIVO):

- Solo sugerir tratamientos que estén realmente en el catálogo configurado.
- Una sola sugerencia por conversación, después de cerrar la venta principal.
- Formato: "Muchas pacientes que se hacen [X] complementan con [Y]. ¿Te interesa que te cuente?"
- Si el paciente dice no o lo ignora, NO insistir. Cerrar con calidez.
- PROHIBIDO: presentar el cross-sell como si fuera obligatorio o "recomendación médica".`,
};

// =============================================================================
// Registro y helpers
// =============================================================================

export const SYSTEM_PATIENT_SKILLS: PatientSkill[] = [
    objectionPrice,
    appointmentConfirmation,
    rescheduling,
    upsellSuggestion,
];

/**
 * Lookup O(1) por id (estable). Útil para validar toggles y resolver contenido
 * de las skills 'system' guardadas como rows en clinicas.company_skills.
 */
export const SYSTEM_PATIENT_SKILL_INDEX: Record<string, PatientSkill> =
    SYSTEM_PATIENT_SKILLS.reduce<Record<string, PatientSkill>>((acc, s) => {
        acc[s.id] = s;
        return acc;
    }, {});

/**
 * Compila una lista de skills (system + privadas ya resueltas) en una sección
 * inyectable en el system prompt. Si la lista es vacía, retorna ''.
 */
export function buildCompanySkillsSection(skills: PatientSkill[]): string {
    if (skills.length === 0) return '';

    const blocks = skills.map(s =>
        `### ${s.name}\nACTIVAR: ${s.trigger}\n${s.guidelines}`
    );

    return `--- SKILLS HABILITADAS POR LA CLÍNICA ---
Estas skills complementan las REGLAS FUNDAMENTALES (que siempre tienen prioridad). NO inventes comportamientos de skills que no estén listadas aquí.

${blocks.join('\n\n')}`;
}
