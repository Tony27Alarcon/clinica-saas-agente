import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
    createSendInteractiveButtonsTool,
    createSendInteractiveListTool
} from '../tools';
import {
    createClinicasUpdateContactTool,
    createClinicasEscalateTool,
    createClinicasGetServicesTool,
    createClinicasGetSlotsTool,
    createClinicasBookAppointmentTool,
    createClinicasGetNotesTool,
    createClinicasAddNoteTool,
    createClinicasEditNoteTool,
    createClinicasArchiveNoteTool,
} from '../tools/clinicas.tools';
import {
    createAdminSearchContactsTool,
    createAdminGetAppointmentsTool,
    createAdminGetFreeSlotsTool,
    createAdminUpdateAppointmentTool,
    createAdminGetContactSummaryTool,
    createAdminSendMessageToPatientTool,
    createAdminGetDailySummaryTool,
    createAdminConnectGoogleCalendarTool,
} from '../tools/clinicas-admin.tools';

const google = createGoogleGenerativeAI({
    apiKey: env.GEMINI_API_KEY,
});

import { getColombianContext } from '../utils/time';

/**
 * Detecta patrones de "botones simulados en texto" que el modelo a veces genera
 * cuando debería haber llamado a sendInteractiveButtons/sendInteractiveList.
 * Sanea el texto eliminando las líneas ofensoras y devuelve un flag para telemetría.
 *
 * Patrones detectados:
 *  - Línea que empieza con "Botones:", "Opciones:", "Lista:", "Menú:", "Elige:" seguida de corchetes.
 *  - Dos o más "[texto]" contiguos en la misma línea (ej: "[Opción 1] [Opción 2]").
 *
 * NO sanea corchetes legítimos de una sola vez (ej: "[Ver más aquí]") ni los marcadores
 * internos "[[Mensaje interactivo ...]]" que usamos en el historial.
 */
function sanitizeFakeButtons(text: string): { detected: boolean; cleanedText: string } {
    if (!text) return { detected: false, cleanedText: text };

    // Ignorar líneas con marcadores internos "[[...]]" para no tocarlos.
    const labelPattern = /^\s*(botones?|opciones?|lista|menú|menu|elige|elija)\s*:\s*\[[^\n]*\]\s*$/gim;
    const bracketRunPattern = /(?<!\[)(\[[^\[\]\n]{1,40}\]\s*){2,}(?!\])/g;

    let cleaned = text;
    let detected = false;

    if (labelPattern.test(cleaned)) {
        detected = true;
        cleaned = cleaned.replace(labelPattern, '');
    }

    if (bracketRunPattern.test(cleaned)) {
        detected = true;
        cleaned = cleaned.replace(bracketRunPattern, '');
    }

    // Colapsar saltos de línea múltiples y recortar
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return { detected, cleanedText: cleaned };
}

/**
 * Convierte una key tipo "seccion_2_contexto_empresa" o "tono_de_voz"
 * en un label legible: "Contexto empresa", "Tono de voz".
 */
function humanizeKey(key: string): string {
    return key
        .replace(/^seccion_\d+_/i, '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^./, c => c.toUpperCase());
}

/**
 * Renderiza recursivamente un valor de `agente.instrucciones` (JSONB) a markdown legible.
 * Diseñado para reemplazar JSON.stringify y ahorrar tokens en el system prompt.
 *
 * - string/number/boolean → as-is
 * - array de primitivos   → bullets "- item"
 * - array de objetos      → bullets indentados con sub-render
 * - objeto                → "Label: valor" o "Label:\n  sub-render" si es complejo
 * - null/undefined        → ""
 */
function renderInstrucciones(value: any, depth: number = 0): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    const indent = '  '.repeat(depth);

    if (Array.isArray(value)) {
        if (value.length === 0) return '';
        return value
            .map(item => {
                const rendered = renderInstrucciones(item, depth + 1);
                if (rendered.includes('\n')) {
                    // Sub-objeto: primer línea con bullet, resto indentado
                    const lines = rendered.split('\n');
                    return `${indent}- ${lines[0]}\n${lines.slice(1).map(l => `${indent}  ${l}`).join('\n')}`;
                }
                return `${indent}- ${rendered}`;
            })
            .join('\n');
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '');
        if (entries.length === 0) return '';
        return entries
            .map(([key, v]) => {
                const label = humanizeKey(key);
                const rendered = renderInstrucciones(v, depth + 1);
                if (rendered.includes('\n')) {
                    // Sub-render multilínea: indentamos 2 espacios para que cuelgue del label
                    const indented = rendered.split('\n').map(l => `  ${l}`).join('\n');
                    return `${label}:\n${indented}`;
                }
                return `${label}: ${rendered}`;
            })
            .join('\n');
    }

    return String(value);
}

export class AiService {
    static async generarRespuestaClinicas(
        historial: Array<{ role: 'user' | 'assistant'; content: string }>,
        agent: any,
        contact: any,
        conversation: any,
        phoneNumberId: string,
        company: any
    ): Promise<string> {
        try {
            logger.info(`[IA Clinicas] Generando respuesta para ${contact?.phone} (Conv: ${conversation?.id})`);

            const timeCtx = getColombianContext();

            // system_prompt viene compilado desde la BD (buildSystemPrompt).
            // Aquí agregamos contexto dinámico por mensaje: fecha, estado del contacto y
            // guía de uso de tools. NO repetir lógica de las 4 fases (ya está en el prompt compilado).
            const contactStatus  = contact?.status || 'prospecto';
            const isKnownContact = contactStatus !== 'prospecto';

            const systemPrompt = `${agent.system_prompt}

--- CONTEXTO OPERATIVO ---
Fecha: ${timeCtx.fullDate}
Hora: ${timeCtx.time} (${timeCtx.partOfDay})

--- CONTACTO ACTUAL ---
Nombre: ${contact?.name || 'Desconocido'}
Teléfono: ${contact?.phone || 'Desconocido'}
Estado: ${contactStatus}
Temperatura: ${contact?.temperature || 'frio'}
${isKnownContact ? '⚠️ Contacto con historial previo — carga notas antes de responder (ver reglas de notas).' : ''}

--- HERRAMIENTAS DISPONIBLES ---

CRM (silenciosas — no las menciones al paciente):
  • updateContactProfile → Actualizar nombre, email, status o temperatura cuando lo descubras en la conversación.
  • escalateToHuman      → Escalar según las reglas definidas en el sistema.

Servicios y agenda (silenciosas — genera siempre un mensaje de texto después):
  • getServices                           → Catálogo en tiempo real con IDs reales. Úsala cuando el paciente pregunte por servicios, precios o duraciones, y siempre antes de llamar getAvailableSlots.
  • getAvailableSlots(treatment_id?)      → Disponibilidad real desde Google Calendar. Ofrece EXACTAMENTE 2 opciones. Nunca preguntes "¿cuándo puedes?" de forma abierta.
  • bookAppointment(slot_id, starts_at, ends_at) → SOLO si el paciente confirmó el horario de forma explícita ("ese me sirve", "perfecto", "agéndame ahí"). Pasa el slot_id y los timestamps exactos del slot.

Notas internas (silenciosas — el paciente nunca sabe que existen):
  • getNotes(include_archived?)  → Recuperar notas activas del contacto. Ver regla de cuándo llamarla.
  • addNote(content)             → Guardar observaciones clínicas relevantes: alergias, historial, preferencias, motivo de consulta.
  • editNote(note_id, content)   → Corregir una nota existente. Requiere note_id obtenido con getNotes.
  • archiveNote(note_id)         → Marcar nota como obsoleta. La nota se conserva, deja de aparecer en contexto activo.

Interactivas (el mensaje va DENTRO de la tool — NO generes texto adicional en el mismo turno):
  • sendInteractiveButtons → Hasta 3 opciones de respuesta.
  • sendInteractiveList    → Más de 3 opciones.

--- ORDEN DE EJECUCIÓN EN CADA TURNO ---
1. NOTAS (si aplica): Si el estado del contacto no es "prospecto", llama getNotes UNA SOLA VEZ al inicio del turno para cargar contexto previo antes de responder.
2. RESPUESTA: Genera tu respuesta usando el contexto de las notas y el historial.
3. SERVICIOS/AGENDA (si el paciente lo pidió): getServices → getAvailableSlots → ofrece 2 opciones → espera confirmación → bookAppointment.
4. REGISTRO: Al final del turno, si aprendiste algo relevante sobre el paciente → addNote y/o updateContactProfile.

--- MANEJO DE CASOS ESPECIALES ---
• getAvailableSlots vacío     → "No tenemos turnos disponibles en los próximos días. Te aviso cuando se libere uno, ¿te parece?" Luego escalateToHuman.
• bookAppointment fallido     → "Ese horario acaba de ocuparse. Déjame buscarte otra opción." Luego llama getAvailableSlots de nuevo.
• editNote / archiveNote sin note_id → Llama getNotes primero para obtener el ID correcto.

--- REGLAS ABSOLUTAS DE RESPUESTA ---
• Silenciosas: SIEMPRE genera un mensaje de texto después — el paciente no puede quedar en silencio.
• Interactivas exitosas: NO generes texto adicional — el mensaje ya está dentro de la tool.
• Nunca llames la misma tool dos veces en el mismo turno.
• Nunca menciones las tools, el sistema, ni las notas al paciente.`;

            const result = await generateText({
                model: google(env.GEMINI_MODEL),
                system: systemPrompt,
                messages: historial,
                temperature: 0.7,
                maxSteps: 25,
                tools: {
                    updateContactProfile:   createClinicasUpdateContactTool(contact.id),
                    escalateToHuman:        createClinicasEscalateTool(conversation.id),
                    getServices:            createClinicasGetServicesTool(company.id),
                    getAvailableSlots:      createClinicasGetSlotsTool(company.id),
                    bookAppointment:        createClinicasBookAppointmentTool(company.id, contact.id, phoneNumberId),
                    getNotes:               createClinicasGetNotesTool(company.id, contact.id),
                    addNote:                createClinicasAddNoteTool(company.id, contact.id),
                    editNote:               createClinicasEditNoteTool(company.id, contact.id),
                    archiveNote:            createClinicasArchiveNoteTool(company.id, contact.id),
                    sendInteractiveButtons: createSendInteractiveButtonsTool(contact.phone, phoneNumberId, conversation.id),
                    sendInteractiveList:    createSendInteractiveListTool(contact.phone, phoneNumberId, conversation.id),
                },
            } as any);

            const resultText = result.text || '';

            const steps = (result as any).steps || [];
            const allToolCalls = steps.flatMap((s: any) => s.toolCalls || []);
            const allToolResults = steps.flatMap((s: any) => s.toolResults || []);

            // Solo descartar el texto si el tool interactivo tuvo ÉXITO (ok: true).
            // Si Kapso no está configurado, el tool retorna { ok: false } y debemos
            // preservar el texto para guardarlo en DB y que el polling lo encuentre.
            const usedInteractive = allToolResults.some((tr: any) =>
                ['sendInteractiveButtons', 'sendInteractiveList'].includes(tr.toolName) && tr.result?.ok === true
            );

            // Si usó interactivos exitosamente, descartar texto residual (el interactivo ya tiene el mensaje)
            if (usedInteractive) {
                if (resultText) logger.info(`[IA Clinicas] Descartando texto residual tras interactivo.`);
                return '';
            }

            // Si no hay texto pero sí hubo tool calls de CRM, forzar segunda llamada contextual
            if (!resultText && allToolCalls.length > 0) {
                logger.info(`[IA Clinicas] Tool calls sin texto. Forzando segunda llamada...`);
                const intermediateMessages = (result as any).response?.messages || [];
                const followUp = await generateText({
                    model: google(env.GEMINI_MODEL),
                    system: systemPrompt,
                    messages: [...historial, ...intermediateMessages],
                    temperature: 0.7,
                    maxSteps: 10,
                    tools: {
                        updateContactProfile:   createClinicasUpdateContactTool(contact.id),
                        escalateToHuman:        createClinicasEscalateTool(conversation.id),
                        getServices:            createClinicasGetServicesTool(company.id),
                        getAvailableSlots:      createClinicasGetSlotsTool(company.id),
                        bookAppointment:        createClinicasBookAppointmentTool(company.id, contact.id, phoneNumberId),
                        getNotes:               createClinicasGetNotesTool(company.id, contact.id),
                        addNote:                createClinicasAddNoteTool(company.id, contact.id),
                        editNote:               createClinicasEditNoteTool(company.id, contact.id),
                        archiveNote:            createClinicasArchiveNoteTool(company.id, contact.id),
                        sendInteractiveButtons: createSendInteractiveButtonsTool(contact.phone, phoneNumberId, conversation.id),
                        sendInteractiveList:    createSendInteractiveListTool(contact.phone, phoneNumberId, conversation.id),
                    },
                } as any);

                const followUpSteps = (followUp as any).steps || [];
                const followUpToolResults = followUpSteps.flatMap((s: any) => s.toolResults || []);
                const followUpUsedInteractive = followUpToolResults.some((tr: any) =>
                    ['sendInteractiveButtons', 'sendInteractiveList'].includes(tr.toolName) && tr.result?.ok === true
                );
                if (followUpUsedInteractive) {
                    if (followUp.text) logger.info(`[IA Clinicas] Descartando texto residual tras interactivo (follow-up).`);
                    return '';
                }

                return followUp.text || '¿En qué más puedo ayudarte?';
            }

            if (!resultText) {
                logger.warn(`[IA Clinicas] Respuesta vacía. FinishReason: ${result.finishReason}`);
                return '¡Hola! Recibí tu mensaje. ¿En qué puedo ayudarte?';
            }

            const { detected, cleanedText } = sanitizeFakeButtons(resultText);
            if (detected) {
                logger.warn(`[IA Clinicas] Botones simulados detectados. Sanitizando.`);
                return cleanedText || '¿En qué más puedo ayudarte?';
            }

            logger.info(`[IA Clinicas] Respuesta: "${resultText.substring(0, 80)}${resultText.length > 80 ? '...' : ''}"`);
            return resultText;

        } catch (error) {
            logger.error(`[IA Clinicas] Error en generarRespuestaClinicas`, error);
            throw error;
        }
    }

    /**
     * Genera una respuesta para el agente admin de clínicas.
     *
     * Se activa cuando quien escribe es un miembro del staff (identificado por
     * su teléfono en clinicas.staff). El system prompt se construye en código,
     * no en BD. Tiene 7 herramientas administrativas disponibles.
     */
    static async generarRespuestaAdmin(
        historial: Array<{ role: 'user' | 'assistant'; content: string }>,
        staffMember: any,
        company: any,
        contact: any,
        conversation: any,
        phoneNumberId: string
    ): Promise<string> {
        try {
            logger.info(`[IA Admin] Generando respuesta para staff "${staffMember?.name}" (Conv: ${conversation?.id})`);

            const timeCtx = getColombianContext();

            const systemPrompt = `Eres el asistente administrativo de ${company.name}.
Hablas con ${staffMember.name}${staffMember.role ? ` (${staffMember.role})` : ''}.
Fecha: ${timeCtx.fullDate} — Hora: ${timeCtx.time}
Zona horaria: ${company.timezone || 'America/Bogota'} — Moneda: ${company.currency || 'COP'}

TONO: Directo y profesional. Respuestas concisas. Sin saludos repetidos en cada turno.

HERRAMIENTAS DISPONIBLES (8):
1. searchContacts — Busca pacientes/leads por nombre, teléfono o estado.
2. getUpcomingAppointments — Consulta citas próximas (próximos N días).
3. getFreeSlots — Slots disponibles para agendar.
4. updateAppointmentStatus — Marca una cita como completada, cancelada, no-show, etc.
5. getContactSummary — Resumen completo de un paciente (perfil + citas + historial).
6. sendMessageToPatient — Envía un mensaje WhatsApp a un paciente desde la clínica.
7. getDailySummary — Resumen del día: citas, leads nuevos, escalaciones, follow-ups.
8. connectGoogleCalendar — Envía al staff un link para conectar su Google Calendar. Usar cuando diga "conectar calendario", "vincular Google Calendar" o cuando quiera que el agente cree citas en su agenda personal.

REGLAS:
- Después de cada tool call, genera texto que resuma el resultado para el staff.
- Nunca termines un turno solo con tool calls. Siempre agrega texto de cierre.
- Para sendMessageToPatient: solo ejecutar con confirmación explícita del staff en este turno. Si el staff pide enviar un mensaje pero no especificó el texto exacto, pregunta antes de enviar.
- Solo accedes a datos de ${company.name}. No puedes modificar configuraciones del sistema ni del agente.`;

            const result = await generateText({
                model: google(env.GEMINI_MODEL),
                system: systemPrompt,
                messages: historial,
                temperature: 0.5,
                maxSteps: 25,
                tools: {
                    searchContacts:          createAdminSearchContactsTool(company.id),
                    getUpcomingAppointments: createAdminGetAppointmentsTool(company.id),
                    getFreeSlots:            createAdminGetFreeSlotsTool(company.id),
                    updateAppointmentStatus: createAdminUpdateAppointmentTool(company.id),
                    getContactSummary:       createAdminGetContactSummaryTool(company.id),
                    sendMessageToPatient:    createAdminSendMessageToPatientTool(company.id, phoneNumberId),
                    getDailySummary:         createAdminGetDailySummaryTool(company.id, company.timezone || 'America/Bogota'),
                    connectGoogleCalendar:   createAdminConnectGoogleCalendarTool(
                        staffMember.id,
                        company.id,
                        staffMember.phone,
                        phoneNumberId
                    ),
                },
            } as any);

            const resultText = result.text || '';

            const steps = (result as any).steps || [];
            const allToolCalls = steps.flatMap((s: any) => s.toolCalls || []);

            // Si no hay texto pero sí hubo tool calls, forzar segunda llamada contextual
            if (!resultText && allToolCalls.length > 0) {
                logger.info(`[IA Admin] Tool calls sin texto. Forzando segunda llamada...`);
                const intermediateMessages = (result as any).response?.messages || [];
                const followUp = await generateText({
                    model: google(env.GEMINI_MODEL),
                    system: systemPrompt,
                    messages: [...historial, ...intermediateMessages],
                    temperature: 0.5,
                } as any);
                return followUp.text || '¿En qué más puedo ayudarte?';
            }

            if (!resultText) {
                logger.warn(`[IA Admin] Respuesta vacía. FinishReason: ${result.finishReason}`);
                return '¡Hola! Estoy listo para ayudarte. ¿Qué necesitas?';
            }

            const { detected, cleanedText } = sanitizeFakeButtons(resultText);
            if (detected) {
                logger.warn(`[IA Admin] Botones simulados detectados. Sanitizando.`);
                return cleanedText || '¿En qué más puedo ayudarte?';
            }

            logger.info(`[IA Admin] Respuesta: "${resultText.substring(0, 80)}${resultText.length > 80 ? '...' : ''}"`);
            return resultText;

        } catch (error) {
            logger.error(`[IA Admin] Error en generarRespuestaAdmin`, error);
            throw error;
        }
    }
}
