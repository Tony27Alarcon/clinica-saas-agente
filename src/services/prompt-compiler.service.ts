// =============================================================================
// PromptCompilerService — buildSystemPrompt()
//
// Función PURA: sin acceso a BD, sin efectos secundarios.
// Mismo input → mismo output, siempre. 100% testeable con datos mock.
//
// El llamador (PromptRebuildService) se encarga de cargar los datos desde
// la BD y pasar el objeto PromptCompilerInput completo.
// =============================================================================

// ─── Interfaces de entrada ───────────────────────────────────────────────────

export interface PromptScheduleSlot {
    days:  string[];   // ['lun','mar','mie','jue','vie']
    open:  string;     // '09:00'
    close: string;     // '19:00'
}

export interface PromptTreatment {
    name:                     string;
    description?:             string;
    price_min?:               number | null;
    price_max?:               number | null;
    duration_min?:            number | null;
    category?:                string | null;
    contraindications?:       string | null;
    preparation_instructions?: string | null;
}

export interface PromptStaffMember {
    name:       string;
    role?:      string | null;
    specialty?: string | null;
}

export interface PromptCompilerInput {
    company: {
        name:          string;
        city?:         string | null;
        address?:      string | null;
        timezone:      string;
        currency:      string;
        country_code:  string;
        schedule?:     PromptScheduleSlot[] | null;
    };
    agent: {
        name:                  string;
        tone:                  'formal' | 'amigable' | 'casual';
        persona_description?:  string | null;
        clinic_description?:   string | null;
        booking_instructions?: string | null;
        prohibited_topics?:    string[] | null;
        qualification_criteria: {
            excluded_keywords?:  string[];
            min_budget_usd?:     number;
        };
        escalation_rules: {
            trigger_keywords?:          string[];
            max_turns_without_intent?:  number;
        };
        objections_kb: Array<{
            objection: string;
            response:  string;
        }>;
    };
    treatments: PromptTreatment[];
    staff:      PromptStaffMember[];
}

// ─── Función principal ───────────────────────────────────────────────────────

export function buildSystemPrompt(input: PromptCompilerInput): string {
    const sections: string[] = [];

    sections.push(buildSection1_Identity(input));
    sections.push(buildSection2_ClinicContext(input));
    sections.push(buildSection3_Treatments(input));

    const s4 = buildSection4_Staff(input);
    if (s4) sections.push(s4);

    const s5 = buildSection5_ScheduleAndLocation(input);
    if (s5) sections.push(s5);

    sections.push(buildSection6_OperationPipeline(input));
    sections.push(buildSection7_Rules(input));

    const s8 = buildSection8_Objections(input);
    if (s8) sections.push(s8);

    return sections.join('\n\n');
}

// ─── Sección 1: Identidad ────────────────────────────────────────────────────

function buildSection1_Identity(input: PromptCompilerInput): string {
    const { agent, company } = input;

    const locationStr = company.city
        ? ` ubicada en ${company.city}`
        : '';

    const toneInstructions = toneToInstructions(agent.tone);

    const personaBlock = agent.persona_description?.trim()
        ? `\n${agent.persona_description.trim()}`
        : '';

    return `Eres ${agent.name}, asistente virtual de ${company.name}${locationStr}.
Tu objetivo principal es convertir consultas de WhatsApp en citas agendadas, brindando una experiencia cálida, profesional y sin fricciones.
${toneInstructions}${personaBlock}`;
}

// ─── Sección 2: Contexto de la clínica ───────────────────────────────────────

function buildSection2_ClinicContext(input: PromptCompilerInput): string {
    const { agent, company } = input;

    const description = agent.clinic_description?.trim()
        || `${company.name} es una clínica especializada en medicina estética.`;

    return `--- SOBRE ${company.name.toUpperCase()} ---
${description}`;
}

// ─── Sección 3: Catálogo de tratamientos ─────────────────────────────────────

function buildSection3_Treatments(input: PromptCompilerInput): string {
    const { treatments, company } = input;

    if (treatments.length === 0) {
        return `--- CATÁLOGO DE TRATAMIENTOS ---
(Sin tratamientos configurados aún. No ofrezcas ni inventes servicios.)`;
    }

    // Agrupar por categoría si al menos uno tiene category
    const hasCategories = treatments.some(t => t.category);

    let catalogBody: string;
    if (hasCategories) {
        const groups = groupByCategory(treatments);
        catalogBody = Object.entries(groups)
            .map(([cat, items]) => {
                const catTitle = cat === '_sin_categoria' ? 'Otros tratamientos' : cat.toUpperCase();
                return `${catTitle}:\n${items.map(t => formatTreatmentLine(t, company.currency)).join('\n')}`;
            })
            .join('\n\n');
    } else {
        catalogBody = treatments.map(t => formatTreatmentLine(t, company.currency)).join('\n');
    }

    return `--- CATÁLOGO DE TRATAMIENTOS ---
${catalogBody}

REGLA CRÍTICA: No inventes precios, duraciones ni tratamientos fuera de esta lista. Si te preguntan por algo que no está aquí, responde: "Ese servicio no está disponible actualmente, pero puedo contarte sobre [tratamiento similar]."`;
}

// ─── Sección 4: Equipo (condicional) ─────────────────────────────────────────

function buildSection4_Staff(input: PromptCompilerInput): string | null {
    const { staff } = input;
    if (staff.length === 0) return null;

    const lines = staff.map(s => {
        const parts = [s.name];
        if (s.role) parts.push(s.role);
        if (s.specialty) parts.push(`especialista en ${s.specialty}`);
        return `- ${parts.join(' — ')}`;
    });

    return `--- NUESTRO EQUIPO ---
${lines.join('\n')}`;
}

// ─── Sección 5: Horarios y ubicación (condicional) ───────────────────────────

function buildSection5_ScheduleAndLocation(input: PromptCompilerInput): string | null {
    const { company } = input;

    const hasSchedule = Array.isArray(company.schedule) && company.schedule.length > 0;
    const hasLocation = company.address || company.city;

    if (!hasSchedule && !hasLocation) return null;

    const parts: string[] = [];

    if (hasSchedule) {
        const scheduleText = formatSchedule(company.schedule!);
        parts.push(`Horario de atención: ${scheduleText}`);
    }

    if (company.address) {
        parts.push(`Dirección: ${company.address}${company.city ? `, ${company.city}` : ''}`);
    } else if (company.city) {
        parts.push(`Ciudad: ${company.city}`);
    }

    return `--- HORARIOS Y UBICACIÓN ---
${parts.join('\n')}`;
}

// ─── Sección 6: Pipeline de operación ────────────────────────────────────────

function buildSection6_OperationPipeline(input: PromptCompilerInput): string {
    const { agent } = input;

    const bookingBlock = agent.booking_instructions?.trim()
        ? `\nINSTRUCCIONES ESPECÍFICAS DE AGENDAMIENTO:\n${agent.booking_instructions.trim()}`
        : `\n- Ofrece siempre exactamente 2 opciones de horario disponibles, nunca preguntes "¿cuándo puedes?" de forma abierta.
- Si el paciente no puede en ninguna opción, ofrece 2 más.
- Solicita solo los datos estrictamente necesarios: nombre y el número para confirmar.`;

    return `--- FASES DE OPERACIÓN ---

FASE 1 — CALIFICACIÓN:
- Pregunta de forma natural qué desea mejorar el paciente.
- Presenta el catálogo de servicios relevante.
- Detecta si hay intención real de agendar o es solo curiosidad.
- Si el paciente menciona palabras que lo descalifican (ver Sección 7), no inviertas más tiempo en calificarlo.

FASE 2 — AGENDAMIENTO:${bookingBlock}
- Crea urgencia amable: "Tenemos pocos turnos disponibles esta semana."
- Una vez confirmada la cita, reitera: fecha, hora y preparación necesaria.

FASE 3 — ANTI NO-SHOW:
- 24 horas antes de la cita, envía un recordatorio con la información del turno.
- Si el paciente necesita reagendar, resuélvelo inmediatamente ofreciendo alternativas.
- Envía instrucciones de preparación si el tratamiento las tiene.

FASE 4 — SEGUIMIENTO POST-TRATAMIENTO:
- A los 3 días: pregunta por bienestar y evolución.
- A los 7 días: evaluación de resultados.
- A los 30 días: solicita reseña y ofrece próxima sesión.

REGLA GENERAL — MENSAJES CORTOS:
- Máximo 3-4 líneas por mensaje. Nunca Wall of Text.
- Usa saltos de línea para separar ideas.
- No repitas información que ya se dijo en el mismo turno.

REGLA GENERAL — DIAGNÓSTICO PROHIBIDO:
- Nunca diagnostiques condiciones médicas por WhatsApp.
- Si el paciente envía fotos de condiciones o pide diagnóstico: "Por protocolo médico no puedo diagnosticarte por este medio. Con gusto te agendo una consulta de valoración con el especialista."`;
}

// ─── Sección 7: Reglas de escalamiento y calificación ────────────────────────

function buildSection7_Rules(input: PromptCompilerInput): string {
    const { agent } = input;

    const triggerKeywords = agent.escalation_rules.trigger_keywords ?? [];
    const maxTurns        = agent.escalation_rules.max_turns_without_intent ?? 6;
    const excludedKw      = agent.qualification_criteria.excluded_keywords ?? [];
    const minBudget       = agent.qualification_criteria.min_budget_usd;
    const prohibited      = agent.prohibited_topics ?? [];

    const escalationLines: string[] = [];
    if (triggerKeywords.length > 0) {
        escalationLines.push(`- Si el paciente dice "${triggerKeywords.join('" o "')}", usa la herramienta escalateToHuman inmediatamente.`);
    }
    escalationLines.push(`- Si después de ${maxTurns} mensajes no hay intención clara de agendar, usa escalateToHuman.`);

    const qualificationLines: string[] = [];
    if (excludedKw.length > 0) {
        qualificationLines.push(`- Palabras que indican lead no calificado: ${excludedKw.map(k => `"${k}"`).join(', ')}. Si aparecen, no sigas invirtiendo tiempo en calificarlo.`);
    }
    if (minBudget) {
        qualificationLines.push(`- Presupuesto mínimo estimado del lead: $${minBudget} USD. Si indica presupuesto menor, ofrece opciones más accesibles del catálogo.`);
    }

    const prohibitedLines = prohibited.length > 0
        ? `\nTEMAS PROHIBIDOS:\n${prohibited.map(t => `- ${t}`).join('\n')}`
        : '';

    return `--- REGLAS DE ESCALAMIENTO Y CALIFICACIÓN ---

CUÁNDO ESCALAR A HUMANO:
${escalationLines.join('\n')}

CALIFICACIÓN DE LEADS:
${qualificationLines.length > 0 ? qualificationLines.join('\n') : '- Sin criterios de descarte configurados. Atiende a todos los leads.'}${prohibitedLines}`;
}

// ─── Sección 8: Objeciones (condicional) ─────────────────────────────────────

function buildSection8_Objections(input: PromptCompilerInput): string | null {
    const { agent } = input;
    if (!agent.objections_kb || agent.objections_kb.length === 0) return null;

    const lines = agent.objections_kb.map(o => `- "${o.objection}"\n  → ${o.response}`);

    return `--- MANEJO DE OBJECIONES ---
Cuando el paciente exprese las siguientes objeciones, responde exactamente así:
${lines.join('\n')}`;
}

// ─── Helpers privados ────────────────────────────────────────────────────────

function toneToInstructions(tone: 'formal' | 'amigable' | 'casual'): string {
    const map: Record<string, string> = {
        formal:   'Tono: profesional y respetuoso. Usa "usted", evita diminutivos y coloquialismos.',
        amigable: 'Tono: cálido y cercano. Usa "tú", puedes incluir emojis suaves (✨, 🤍, 📅) sin saturar.',
        casual:   'Tono: natural y relajado, como un amigo del equipo. Usa lenguaje coloquial latinoamericano.',
    };
    return map[tone] ?? map.amigable;
}

function formatTreatmentLine(t: PromptTreatment, currency: string): string {
    const parts: string[] = [`- ${t.name}`];

    if (t.price_min != null) {
        const priceStr = (t.price_max != null && t.price_max !== t.price_min)
            ? `desde $${t.price_min} hasta $${t.price_max} ${currency}`
            : `desde $${t.price_min} ${currency}`;
        parts.push(priceStr);
    }

    if (t.duration_min != null) {
        parts.push(`duración ~${t.duration_min} min`);
    }

    if (t.description) {
        parts.push(t.description.trim());
    }

    if (t.contraindications) {
        parts.push(`Contraindicaciones: ${t.contraindications.trim()}`);
    }

    if (t.preparation_instructions) {
        parts.push(`Preparación: ${t.preparation_instructions.trim()}`);
    }

    return parts.join('. ').replace(/\.\./g, '.');
}

function formatSchedule(schedule: PromptScheduleSlot[]): string {
    const DAY_NAMES: Record<string, string> = {
        lun: 'lunes', mar: 'martes', mie: 'miércoles', jue: 'jueves',
        vie: 'viernes', sab: 'sábados', dom: 'domingos',
    };

    return schedule.map(slot => {
        const days = slot.days.map(d => DAY_NAMES[d.toLowerCase()] ?? d);
        const daysStr = days.length === 1
            ? days[0]
            : `${days.slice(0, -1).join(', ')} y ${days[days.length - 1]}`;
        return `${daysStr} de ${slot.open} a ${slot.close}`;
    }).join(', ');
}

function groupByCategory(treatments: PromptTreatment[]): Record<string, PromptTreatment[]> {
    return treatments.reduce<Record<string, PromptTreatment[]>>((acc, t) => {
        const key = t.category?.trim() || '_sin_categoria';
        if (!acc[key]) acc[key] = [];
        acc[key].push(t);
        return acc;
    }, {});
}
