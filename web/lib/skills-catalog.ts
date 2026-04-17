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
    {
        id: 'lead-qualification-soft',
        name: 'Calificación Suave de Lead',
        trigger: 'Primer mensaje del paciente sin contexto previo, o cuando diga "quiero info", "me interesa", "cuánto cuesta" sin especificar tratamiento.',
        guidelines: 'Calificación en 3 pasos: necesidad → 2-3 opciones del catálogo → ventana de tiempo. Una pregunta por mensaje. No pedir datos personales antes de intención clara.',
    },
    {
        id: 'clinical-intake-pre-cita',
        name: 'Intake Clínico Pre-Cita',
        trigger: 'Inmediatamente después de un bookAppointment exitoso, antes del recordatorio de 24h.',
        guidelines: 'Recolectar alergias/medicación/embarazo en una burbuja cálida, persistir vía addNote, escalar si hay contraindicación. No diagnosticar.',
    },
    {
        id: 'dormant-lead-recovery',
        name: 'Recuperación de Lead Dormido',
        trigger: 'Activado por scheduleReminder (one-shot a 30/60 días) sobre un lead que nunca agendó, o cuando el staff pida revivirlo manualmente.',
        guidelines: 'Mensaje cálido sin reproche, revisar historial primero, ofrecer motivo concreto, aceptar un no, NO reintentar en menos de 1 trimestre.',
    },
    {
        id: 'post-treatment-follow-up',
        name: 'Seguimiento Post-Tratamiento',
        trigger: 'Activado por scheduleReminder disparado a 3/7/30 días post-cita completada.',
        guidelines: 'Tres toques con propósito distinto: T+3 bienestar, T+7 resultado, T+30 próxima sesión. Escalar cualquier síntoma anormal. Respetar opt-out.',
    },
    {
        id: 'referral-ask-natural',
        name: 'Pedido Natural de Referidos',
        trigger: 'A los 30 días post-cita con feedback positivo guardado, o cuando el paciente exprese satisfacción espontánea.',
        guidelines: 'Pedir UNA vez con botones interactivos. No inventar incentivos no configurados. No re-pedir en menos de 90 días.',
    },
    {
        id: 'third-party-booking',
        name: 'Agendamiento para Terceros',
        trigger: 'Cuando quien escribe dice que la cita es para otra persona (esposa, hija, amiga, regalo).',
        guidelines: 'Capturar nombre del paciente real, definir canal (intermediario o directo), persistir en addNote + notes de appointment, dirigir intake clínico al paciente real.',
    },
];

export const SYSTEM_PATIENT_SKILL_INDEX: Record<string, SystemSkill> =
    SYSTEM_PATIENT_SKILLS.reduce<Record<string, SystemSkill>>((acc, s) => {
        acc[s.id] = s;
        return acc;
    }, {});
