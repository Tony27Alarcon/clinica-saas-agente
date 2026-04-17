// =============================================================================
// Catálogo de System Skills (espejo para el admin Next.js)
//
// Fuente de verdad: src/skills/system-patient-skills.ts (backend).
// Mantener SINCRONIZADO. El admin lo usa para mostrar el catálogo y validar
// colisiones de skill_id en skills privadas.
//
// Tipo idéntico a backend AdminSkill/PatientSkill: { id, name, trigger, guidelines }.
// =============================================================================

export interface SystemSkill {
    id:         string;
    name:       string;
    trigger:    string;
    guidelines: string;
}

export const SYSTEM_PATIENT_SKILLS: SystemSkill[] = [
    {
        id: 'objection-price-pro',
        name: 'Manejo Avanzado de Objeción de Precio',
        trigger: 'Cuando el paciente exprese que el precio le parece alto, no tiene presupuesto, o pida descuento.',
        guidelines: 'Manejo profesional de objeción de precio: validar primero, reformular costo→valor, ofrecer alternativas configuradas (financiación/promociones), no insistir más de 2 veces.',
    },
    {
        id: 'appointment-confirmation',
        name: 'Confirmación de Cita Anti No-show',
        trigger: 'Inmediatamente después de cerrar una cita, y al enviar recordatorios programados.',
        guidelines: 'Resumen de cita en 1-2 burbujas, micro-compromiso de confirmación, recordatorio 24h antes con tono cálido (no culpabilizante).',
    },
    {
        id: 'rescheduling-flow',
        name: 'Reagendamiento Sin Fricción',
        trigger: 'Cuando el paciente pida cambiar, mover o cancelar una cita ya agendada.',
        guidelines: 'Empatía primero, ofrecer 2 horarios concretos del mismo tratamiento, confirmar el cambio explícitamente, no presionar si cancela definitivamente.',
    },
    {
        id: 'gentle-cross-sell',
        name: 'Sugerencia Cruzada Sutil',
        trigger: 'Cuando el paciente ya confirmó un tratamiento y hay tratamientos complementarios en el catálogo.',
        guidelines: 'Cross-sell consultivo: una sola sugerencia tras cerrar venta principal, basada en catálogo real, sin insistencia ni framing médico obligatorio.',
    },
];

export const SYSTEM_PATIENT_SKILL_INDEX: Record<string, SystemSkill> =
    SYSTEM_PATIENT_SKILLS.reduce<Record<string, SystemSkill>>((acc, s) => {
        acc[s.id] = s;
        return acc;
    }, {});
