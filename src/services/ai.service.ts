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
        phoneNumberId: string
    ): Promise<string> {
        try {
            logger.info(`[IA Clinicas] Generando respuesta para ${contact?.phone} (Conv: ${conversation?.id})`);

            const timeCtx = getColombianContext();

            // Objeciones formateadas para inyectar en el sistema
            const objectionsList = Array.isArray(agent.objections_kb) && agent.objections_kb.length > 0
                ? agent.objections_kb
                    .map((o: any) => `- "${o.objection}" → ${o.response}`)
                    .join('\n')
                : '';

            const systemPrompt = `${agent.system_prompt}

--- CONTEXTO OPERATIVO ---
Fecha: ${timeCtx.fullDate}
Hora: ${timeCtx.time} (${timeCtx.partOfDay})

--- CONTACTO ACTUAL ---
Nombre: ${contact?.name || 'Desconocido'}
Teléfono: ${contact?.phone || 'Desconocido'}
Estado en pipeline: ${contact?.status || 'prospecto'}
Temperatura: ${contact?.temperature || 'frio'}

--- HERRAMIENTAS ---
Tienes dos herramientas silenciosas (el paciente no las ve):
1. updateContactProfile — Úsala cuando descubras datos del lead (nombre real, nivel de interés, email). SIEMPRE agrega un mensaje de texto después.
2. escalateToHuman — Úsala cuando el paciente lo pida o cuando las reglas de escalamiento lo indiquen. Después de llamarla, avisa amablemente al paciente que un miembro del equipo lo contactará pronto.

REGLA: Nunca termines tu turno solo con tool calls. Siempre genera un mensaje de texto final que continúe la conversación.
${objectionsList ? `\n--- MANEJO DE OBJECIONES ---\n${objectionsList}` : ''}`;

            const result = await generateText({
                model: google(env.GEMINI_MODEL),
                system: systemPrompt,
                messages: historial,
                temperature: 0.7,
                maxSteps: 25,
                tools: {
                    updateContactProfile: createClinicasUpdateContactTool(contact.id),
                    escalateToHuman: createClinicasEscalateTool(conversation.id),
                    sendInteractiveButtons: createSendInteractiveButtonsTool(contact.phone, phoneNumberId, conversation.id),
                    sendInteractiveList: createSendInteractiveListTool(contact.phone, phoneNumberId, conversation.id),
                },
            } as any);

            const resultText = result.text || '';

            const steps = (result as any).steps || [];
            const allToolCalls = steps.flatMap((s: any) => s.toolCalls || []);
            const usedInteractive = allToolCalls.some((tc: any) =>
                ['sendInteractiveButtons', 'sendInteractiveList'].includes(tc.toolName)
            );

            // Si usó interactivos, descartar texto residual (el interactivo ya tiene el mensaje)
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
                        updateContactProfile: createClinicasUpdateContactTool(contact.id),
                        escalateToHuman: createClinicasEscalateTool(conversation.id),
                        sendInteractiveButtons: createSendInteractiveButtonsTool(contact.phone, phoneNumberId, conversation.id),
                        sendInteractiveList: createSendInteractiveListTool(contact.phone, phoneNumberId, conversation.id),
                    },
                } as any);

                const followUpSteps = (followUp as any).steps || [];
                const followUpToolCalls = followUpSteps.flatMap((s: any) => s.toolCalls || []);
                const followUpUsedInteractive = followUpToolCalls.some((tc: any) =>
                    ['sendInteractiveButtons', 'sendInteractiveList'].includes(tc.toolName)
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
