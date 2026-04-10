import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { DbService } from './db.service';
import {
    createUpdateContactProfileTool,
    createCreateContactNoteTool,
    createAssignCommercialAndNotifyTool,
    createListMediaTool,
    createSendInteractiveButtonsTool,
    createSendAudioTool,
    createSendImageTool,
    createSendDocumentTool,
    createSendLocationTool,
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
    /**
     * Genera una respuesta utilizando Gemini basado en el historial y las instrucciones.
     */
    static async generarRespuesta(historial: any[], agente: any, contacto: any, conversacion: any, phoneNumberId: string) {
        try {
            const conversacionId = conversacion?.id;
            logger.info(`[IA] Generando respuesta para ${contacto?.telefono || 'desconocido'} (Conv: ${conversacionId})`);
            
            // Extracción robusta de instrucciones (soporta formato plano y por secciones)
            const inst = agente.instrucciones || {};
            
            // Función auxiliar para buscar campos en las secciones del agente v2
            const getField = (fieldName: string, fallback: string = '') => {
                if (inst[fieldName]) return inst[fieldName];
                for (const section in inst) {
                    if (typeof inst[section] === 'object' && inst[section][fieldName]) return inst[section][fieldName];
                }
                return fallback;
            };

            const objetivoCol = getField('objetivo_principal') || getField('objetivo') || 'Atender clientes';
            const contextoEmpresa = inst.seccion_2_contexto_empresa
                ? renderInstrucciones(inst.seccion_2_contexto_empresa)
                : (typeof inst.empresa === 'object' ? renderInstrucciones(inst.empresa) : (inst.empresa || ''));
            const personalidad = inst.seccion_3_personalidad_y_tono
                ? renderInstrucciones(inst.seccion_3_personalidad_y_tono)
                : '';
            const reglasOp = inst.seccion_4_reglas_operativas
                ? renderInstrucciones(inst.seccion_4_reglas_operativas)
                : '';
            const guardrails = inst.seccion_10_guardrails?.limites?.join(' / ') || (Array.isArray(inst.guardrails) ? inst.guardrails.join(' / ') : '');
            const scoring = inst.seccion_8_criterios_calificacion
                ? renderInstrucciones(inst.seccion_8_criterios_calificacion)
                : (inst.scoring ? renderInstrucciones(inst.scoring) : '');
            
            const timeCtx = getColombianContext();

            // Paralelizar las consultas de contexto (eran secuenciales antes)
            const [ultimosMedia, biblioteca, notasCrm, comerciales] = await Promise.all([
                DbService.getUltimosMedia(contacto.id, 5),
                DbService.getBibliotecaMultimedia(),
                DbService.getNotasContacto(contacto.id, 5),
                DbService.getComercialesActivos(),
            ]);

            const mediaContactoCtx = ultimosMedia.length > 0
                ? ultimosMedia.map((m: any, i: number) => {
                    const fecha = new Date(m.created_at).toLocaleString('es-CO');
                    const desc = m.descripcion_ia ? `\n   Descripción/Análisis IA: ${m.descripcion_ia}` : '';
                    return `${i + 1}. [${m.kind}] enviado por ${m.rol === 'user' ? 'el usuario' : 'el agente'} el ${fecha}\n   URL: ${m.url_publica}${desc}`;
                }).join('\n\n')
                : 'No hay archivos multimedia recientes intercambiados con este contacto.';

            const bibliotecaCtx = biblioteca.length > 0
                ? biblioteca.map((r: any) => {
                    const tags = Array.isArray(r.tags) && r.tags.length > 0 ? ` [tags: ${r.tags.join(', ')}]` : '';
                    const instruccion = r.instruccion_uso ? `\n   → CUÁNDO USARLO: ${r.instruccion_uso}` : '';
                    return `• [${r.categoria || 'General'}] "${r.nombre}" (${r.tipo})${tags}\n   URL: ${r.url}${instruccion}`;
                  }).join('\n\n')
                : 'No hay recursos disponibles en este momento.';

            // Render de la lista de comerciales para el system prompt.
            // - Usamos un código corto [CXXXXX] (estable, derivado del id por hash)
            //   en vez del UUID crudo: el LLM lo copia mucho más confiablemente y
            //   no se confunde con otros campos del contexto (p. ej. el teléfono
            //   del contacto, que aparece más arriba en el prompt).
            // - NO incluimos el teléfono del comercial en el render: la tool lo
            //   recupera por su cuenta al momento de notificar por WhatsApp, así
            //   reducimos números en el prompt y la chance de que el modelo los
            //   mezcle.
            const comercialesCtx = comerciales.length > 0
                ? comerciales.map((c: any) => {
                    const zona = c.zona_comercial ? ` · zona: ${c.zona_comercial}` : '';
                    return `• [${c.codigo}] ${c.full_name}${zona}`;
                  }).join('\n')
                : 'No hay comerciales activos disponibles en este momento.';

            // Estado de asignación: si la conversación ya fue tomada por un humano,
            // el agente tiene que SABERLO para no seguir empujando calificación / handoff.
            const asignadoUserId = conversacion?.user_id || null;
            const comercialAsignado = asignadoUserId
                ? comerciales.find((c: any) => c.id === asignadoUserId)
                : null;
            const asignacionCtx = asignadoUserId
                ? (comercialAsignado
                    ? `⚠️ ESTA CONVERSACIÓN YA FUE TRANSFERIDA al comercial humano "${comercialAsignado.full_name}" (userId: ${asignadoUserId}). NO vuelvas a llamar a assignCommercial. Tu rol ahora es secundario: respondé únicamente consultas operativas simples (info del producto, horarios, ubicación). Si el usuario pregunta algo que requiera decisión comercial, decile amablemente que ${comercialAsignado.full_name} le va a responder pronto.`
                    : `⚠️ ESTA CONVERSACIÓN YA FUE TRANSFERIDA a un comercial humano (userId: ${asignadoUserId}, no encontrado en la lista actual). NO vuelvas a llamar a assignCommercial. Respondé solo consultas simples y dejá las decisiones comerciales al humano asignado.`)
                : '';

            // Truncar notas a ~500 chars c/u para no inflar el system prompt
            const MAX_NOTA_LEN = 500;
            const notasCrmCtx = notasCrm.length > 0
                ? notasCrm.map((n: any, i: number) => {
                    const fecha = new Date(n.created_at).toLocaleString('es-CO');
                    const notaTexto = (n.nota || '').length > MAX_NOTA_LEN
                        ? `${(n.nota || '').substring(0, MAX_NOTA_LEN)}… [truncada]`
                        : (n.nota || '');
                    return `${i + 1}. [${fecha}] ${n.titulo}\n   ${notaTexto}`;
                  }).join('\n\n')
                : 'Sin notas previas registradas.';

            // Helper inline: solo agrega el bloque si tiene contenido (evita headers vacíos)
            const seccion = (titulo: string, contenido: string) =>
                contenido && contenido.trim() ? `\n## ${titulo}\n${contenido}\n` : '';

            const systemPrompt = `Eres ${agente.nombre || 'CLARA'}. Rol: ${getField('rol') || agente.rol || 'Asistente'}.
Objetivo: ${objetivoCol}.
${asignacionCtx ? `\n${asignacionCtx}\n` : ''}${seccion('Contexto de la empresa', contextoEmpresa)}${seccion('Personalidad y tono', personalidad)}${seccion('Reglas operativas', reglasOp)}${seccion('Criterios de scoring', scoring)}${seccion('Restricciones clave', guardrails)}
Instrucciones operativas: Habla neutro, amigable, profesional y corto. Pregunta de a 1 sola cosa por mensaje.
EVITA REPETIR SALUDOS: Si el historial muestra que ya saludaste al usuario o ya se saludaron, NO vuelvas a decir "¡Hola!" o "Qué bueno saludarle". Sigue directamente con la respuesta o la siguiente pregunta de calificación.
HERRAMIENTAS INTERACTIVAS (REGLA ESTRICTA):
Tienes tools reales para enviar botones y listas: sendInteractiveButtons y sendInteractiveList. Cuando quieras ofrecer opciones al usuario, DEBES llamar a la tool correspondiente — el sistema las renderiza como botones nativos de WhatsApp, clicables, y eso es lo que espera el usuario.

PROHIBIDO ESCRIBIR BOTONES EN TEXTO PLANO. Nunca generes los siguientes patrones en tu respuesta de texto:
  - "Botones: [Opción 1] [Opción 2]"
  - "Opciones: [A] / [B] / [C]"
  - "[Enviar ubicación] [Sigo buscando] [Tengo una duda]"
  - Listas numeradas o con emojis que simulen botones clicables ("1️⃣ Opción A, 2️⃣ Opción B").
Si el usuario ve corchetes con opciones en un mensaje de texto, eso es un ERROR GRAVE: se ve feo, no puede hacer click y rompe la confianza. Si quieres ofrecer opciones, llama a la tool. Si no puedes o no corresponde, escribe texto normal sin simular botones.

HISTORIAL — MARCADORES DEL SISTEMA: Si en el historial ves un mensaje del asistente que termina con "[[Mensaje interactivo ya enviado por WhatsApp: ...]]", eso es metadata del sistema que te indica que en ese turno YA enviaste botones reales al usuario. NO intentes "reproducir" esos botones ni el marcador en tu respuesta actual: esos corchetes son internos, no son un formato que debas imitar.

OTRAS HERRAMIENTAS (AUDIO, IMÁGENES, DOCUMENTOS, UBICACIONES): úsalas cuando aporten valor, según las variantes de bienvenida y cierres definidos en tus instrucciones (secciones 5, 9 y 11).
ENVÍO DE MEDIA + TEXTO: Cuando uses una herramienta de envío de media (sendImage, sendAudio, sendDocument, sendLocation), PUEDES y DEBES —cuando aporte valor— agregar un mensaje de texto complementario en tu respuesta final: el sistema lo enviará automáticamente como un segundo mensaje después del media (por ejemplo: adjuntar un folleto con sendImage y luego escribir "Te dejo nuestro catálogo. ¿Querés que te cotice alguna opción puntual?"). Mantén ese texto corto, natural y que aporte contexto o una pregunta de seguimiento; no repitas literalmente lo que ya dice el caption del media.
EXCEPCIÓN — INTERACTIVOS: Cuando uses sendInteractiveButtons o sendInteractiveList, NO añadas texto adicional: esos mensajes ya contienen body, footer y botones, y un texto extra después confundiría al usuario rompiendo el flujo interactivo.
HERRAMIENTAS DE CRM (updateContactProfile, createContactNote, assignCommercial): son SILENCIOSAS — el usuario no ve nada cuando las llamas. Por eso, DESPUÉS de llamarlas SIEMPRE debes generar un mensaje de texto final que continúe la conversación: responde la pregunta o duda del usuario si la hubo, y/o avanza con la siguiente pregunta de calificación. NUNCA termines tu turno solo con tool calls de CRM sin texto.

--- CONTEXTO TEMPORAL (COLOMBIA) ---
Hoy es: ${timeCtx.fullDate}
Hora actual: ${timeCtx.time}
Parte del día: ${timeCtx.partOfDay}
------------------------------------

--- CONTEXTO DEL CONTACTO ACTUAL ---
Nombre: ${contacto?.nombre || 'Desconocido'}
Teléfono: ${contacto?.telefono || 'Desconocido'}
Temperatura actual: ${contacto?.temperatura || 'No definida'}
Notas Previas: ${contacto?.nota || 'Ninguna'}

NOTAS PREVIAS DEL CRM (handoffs, resúmenes, observaciones de turnos anteriores):
${notasCrmCtx}

ÚLTIMOS ARCHIVOS MULTIMEDIA INTERCAMBIADOS CON ESTE CONTACTO:
${mediaContactoCtx}
------------------------------------

--- BIBLIOTECA DE RECURSOS MULTIMEDIA (Media Library) ---
Tienes acceso a los siguientes recursos que PUEDES enviar proactivamente usando tus herramientas (sendImage, sendDocument).
Cada recurso incluye instrucciones de cuándo usarlo. Síguelas con criterio.

${bibliotecaCtx}
---------------------------------------------------------

--- COMERCIALES DISPONIBLES (para handoff) ---
Cuando un lead esté calificado y listo para hablar con un humano, llama a la tool assignCommercial pasando el CÓDIGO entre corchetes (ej: "C9F2D") del comercial que mejor encaje según zona/criterio. NUNCA inventes un código — solo se aceptan los listados acá. Copia el código TAL CUAL aparece, sin los corchetes.

${comercialesCtx}
-----------------------------------------------`;

            // LOG DE CONTEXTO (Depuración)
            logger.info(`[IA] Enviando ${historial.length} mensajes de historial a Gemini.`);
            if (historial.length > 0) {
                const last = historial[historial.length - 1];
                logger.info(`[IA] Último mensaje del historial (${last.role}): "${typeof last.content === 'string' ? last.content.substring(0, 50) : '[Media/Partes]'}"`);
            }

            const result = await generateText({
                model: google(env.GEMINI_MODEL),
                system: systemPrompt,
                messages: historial,
                temperature: 0.7,
                maxSteps: 5,
                tools: {
                    updateContactProfile: createUpdateContactProfileTool(contacto.id),
                    createContactNote: createCreateContactNoteTool(contacto.id),
                    assignCommercial: createAssignCommercialAndNotifyTool(
                        conversacionId,
                        agente.id,
                        phoneNumberId,
                        contacto.telefono || contacto.phone,
                        contacto.nombre
                    ),
                    sendInteractiveButtons: createSendInteractiveButtonsTool(contacto.telefono || contacto.phone, phoneNumberId, conversacionId),
                    sendAudio: createSendAudioTool(contacto.telefono || contacto.phone, phoneNumberId, conversacionId),
                    sendImage: createSendImageTool(contacto.telefono || contacto.phone, phoneNumberId, conversacionId),
                    sendDocument: createSendDocumentTool(contacto.telefono || contacto.phone, phoneNumberId, conversacionId),
                    sendLocation: createSendLocationTool(contacto.telefono || contacto.phone, phoneNumberId, conversacionId),
                    sendInteractiveList: createSendInteractiveListTool(contacto.telefono || contacto.phone, phoneNumberId, conversacionId),
                    listMedia: createListMediaTool(contacto.id)
                }
            } as any);

            const resultText = result.text || "";

            // Detectar si la IA usó herramientas
            const steps = (result as any).steps || [];
            const allToolCalls = steps.flatMap((step: any) => step.toolCalls || []);
            const usedAnyTool = allToolCalls.length > 0;
            
            // Herramientas de media (permiten co-enviar texto complementario en la misma respuesta)
            const mediaSendingTools = ['sendAudio', 'sendImage', 'sendDocument', 'sendLocation'];
            // Herramientas interactivas (el texto adicional se descarta: ya contienen body/footer/botones)
            const interactiveSendingTools = ['sendInteractiveButtons', 'sendInteractiveList'];

            const usedMediaTool = allToolCalls.some((tc: any) => mediaSendingTools.includes(tc.toolName));
            const usedInteractiveTool = allToolCalls.some((tc: any) => interactiveSendingTools.includes(tc.toolName));
            const usedSendingTool = usedMediaTool || usedInteractiveTool;

            // Si usó un interactivo, descartamos cualquier texto residual (el interactivo ya contiene el mensaje).
            if (usedInteractiveTool) {
                if (resultText) {
                    logger.info(`[IA] Descartando texto residual tras herramienta interactiva: "${resultText.substring(0, 60)}..."`);
                }
                return '';
            }

            // Si usó una herramienta de media y además generó texto, devolvemos el texto: el controller
            // lo enviará como segundo mensaje después del media. Esto permite media + texto.
            if (usedMediaTool && resultText) {
                logger.info(`[IA] Media enviada vía tool + texto complementario: "${resultText.substring(0, 60)}..."`);
                const san = sanitizeFakeButtons(resultText);
                if (san.detected) {
                    logger.warn(`[IA] Botones simulados detectados tras media+texto. Sanitizando.`);
                    return san.cleanedText || '';
                }
                return resultText;
            }

            if (!resultText && usedMediaTool) {
                // Usó la tool de media pero no produjo texto. Hacemos una segunda llamada SIN tools
                // para darle al modelo la oportunidad de generar un texto complementario contextual
                // (saludo, respuesta a la pregunta del usuario, follow-up). Si aun así no genera
                // nada, aceptamos que el media se envió solo (puede ser intencional).
                logger.info(`[IA] Media enviada sin texto. Forzando segunda llamada para generar texto complementario...`);

                const intermediateMessages = (result as any).response?.messages || [];
                const continuationMessages = [...historial, ...intermediateMessages];

                const followUp = await generateText({
                    model: google(env.GEMINI_MODEL),
                    system: systemPrompt,
                    messages: continuationMessages,
                    temperature: 0.7,
                    // SIN tools: forzamos al modelo a producir texto final.
                } as any);

                const followUpText = followUp.text || "";
                if (followUpText) {
                    logger.info(`[IA] Segunda llamada produjo texto complementario al media: "${followUpText.substring(0, 80)}${followUpText.length > 80 ? '...' : ''}"`);
                    const san = sanitizeFakeButtons(followUpText);
                    if (san.detected) {
                        logger.warn(`[IA] Botones simulados detectados en followUp tras media. Sanitizando.`);
                        return san.cleanedText || '';
                    }
                    return followUpText;
                }

                logger.info(`[IA] Segunda llamada también vacía. Media enviada sin texto complementario.`);
                return '';
            }

            if (!resultText && usedAnyTool && !usedSendingTool) {
                // La IA usó herramientas de CRM (ej. updateContactProfile) pero no generó texto de cierre.
                // En lugar de devolver un string genérico hardcoded (que ignora el mensaje del usuario),
                // hacemos una segunda llamada SIN tools para forzar al modelo a producir texto contextual.
                logger.info(`[IA] CRM tools usadas sin texto final. Forzando segunda llamada para generar respuesta contextual...`);

                // El AI SDK v6 expone los mensajes intermedios (assistant con tool calls + tool results)
                // en result.response.messages. Los concatenamos al historial para que la segunda llamada
                // tenga visibilidad de lo que ya se ejecutó en background.
                const intermediateMessages = (result as any).response?.messages || [];
                const continuationMessages = [...historial, ...intermediateMessages];

                const followUp = await generateText({
                    model: google(env.GEMINI_MODEL),
                    system: systemPrompt,
                    messages: continuationMessages,
                    temperature: 0.7,
                    // SIN tools: forzamos al modelo a producir texto final.
                } as any);

                const followUpText = followUp.text || "";
                if (followUpText) {
                    logger.info(`[IA] Segunda llamada produjo texto contextual: "${followUpText.substring(0, 80)}${followUpText.length > 80 ? '...' : ''}"`);
                    const san = sanitizeFakeButtons(followUpText);
                    if (san.detected) {
                        logger.warn(`[IA] Botones simulados detectados en followUp tras CRM. Sanitizando.`);
                        return san.cleanedText || '¿En qué más te puedo ayudar?';
                    }
                    return followUpText;
                }

                // Si incluso la segunda llamada vuelve vacía, recién ahí caemos al fallback hardcoded.
                logger.warn(`[IA] Segunda llamada también vacía. Usando fallback genérico. FinishReason: ${(followUp as any).finishReason}`);
                return '¡Entendido! He actualizado la información. ¿En qué más puedo ayudarte?';
            }

            if (!resultText && !usedAnyTool) {
                // La IA no generó nada: esto es un error real.
                logger.warn(`[IA] Respuesta vacía sin herramientas. FinishReason: ${result.finishReason}`);
                return '¡Hola! Recibí tu mensaje. ¿En qué puedo ayudarte? 😊';
            }

            // Guardrail final: sanitizar botones simulados aunque el prompt los prohíba.
            const { detected: fakeBtnsDetected, cleanedText: sanitizedText } = sanitizeFakeButtons(resultText);
            if (fakeBtnsDetected) {
                logger.warn(`[IA] Botones simulados detectados en respuesta del agente. Original: "${resultText.substring(0, 120)}${resultText.length > 120 ? '...' : ''}" → sanitizado: "${sanitizedText.substring(0, 120)}${sanitizedText.length > 120 ? '...' : ''}"`);
                if (!sanitizedText) {
                    // Tras sanear no queda nada útil: devolvemos un cierre contextual mínimo.
                    return '¿En qué más te puedo ayudar?';
                }
                return sanitizedText;
            }

            logger.info(`[IA] Respuesta generada: "${resultText.substring(0, 80)}${resultText.length > 80 ? '...' : ''}"`);
            return resultText;

        } catch (error) {
            // CAMBIO: antes devolvíamos un fallback "tengo un pequeño inconveniente"
            // que confundía al lead. Ahora re-lanzamos el error para que el
            // controller lo capture, deje al usuario en silencio (sin mensaje
            // raro), y notifique al equipo de soporte vía WhatsApp.
            // Ver: webhook.controller.ts processBatch catch + NotificationService.notifySupport
            logger.error(`Error en generarRespuesta (Gemini)`, error);
            throw error;
        }
    }

    /**
     * Genera una respuesta para el pipeline de clínicas estéticas (schema `clinicas`).
     *
     * A diferencia de generarRespuesta() que renderiza instrucciones desde JSONB complejo,
     * este método usa el system_prompt del agente directamente — ya viene compilado desde
     * clinicas.agents. Solo agrega contexto de fecha y datos del contacto encima.
     *
     * Tools disponibles en Fase 1:
     *   - updateContactProfile: actualiza status/temperature/nombre/email del lead
     *   - escalateToHuman: marca la conversación como escalada
     */
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
                maxSteps: 5,
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
                } as any);
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

HERRAMIENTAS DISPONIBLES (7):
1. searchContacts — Busca pacientes/leads por nombre, teléfono o estado.
2. getUpcomingAppointments — Consulta citas próximas (próximos N días).
3. getFreeSlots — Slots disponibles para agendar.
4. updateAppointmentStatus — Marca una cita como completada, cancelada, no-show, etc.
5. getContactSummary — Resumen completo de un paciente (perfil + citas + historial).
6. sendMessageToPatient — Envía un mensaje WhatsApp a un paciente desde la clínica.
7. getDailySummary — Resumen del día: citas, leads nuevos, escalaciones, follow-ups.

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
                maxSteps: 5,
                tools: {
                    searchContacts:          createAdminSearchContactsTool(company.id),
                    getUpcomingAppointments: createAdminGetAppointmentsTool(company.id),
                    getFreeSlots:            createAdminGetFreeSlotsTool(company.id),
                    updateAppointmentStatus: createAdminUpdateAppointmentTool(company.id),
                    getContactSummary:       createAdminGetContactSummaryTool(company.id),
                    sendMessageToPatient:    createAdminSendMessageToPatientTool(company.id, phoneNumberId),
                    getDailySummary:         createAdminGetDailySummaryTool(company.id, company.timezone || 'America/Bogota'),
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
