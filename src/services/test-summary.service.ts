import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { ClinicasDbService } from './clinicas-db.service';

const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });

/**
 * Sub-agente dedicado que resume la conversación de test del staff.
 *
 * Aislado, sin tools, temperatura baja, ~120 tokens. El output se guarda como
 * `summary` en clinicas.test_sessions (auditoría) y se inyecta como mensaje
 * `system` en la conversación admin del staff para que Bruno pueda comentarlo.
 */
export class TestSummaryService {
    static async summarize(testConversationId: string): Promise<string> {
        try {
            const historial = await ClinicasDbService.getHistorial(testConversationId, 80);

            if (!historial || historial.length === 0) {
                return '_(No hubo mensajes en la sesión de test.)_';
            }

            // Serializar la conversación para el resumen. Usamos etiquetas claras
            // porque el modelo resumidor no tiene contexto del sistema.
            const transcript = historial
                .map(m => `${m.role === 'user' ? 'STAFF-TEST' : 'AGENTE'}: ${m.content}`)
                .join('\n');

            const system =
                `Sos un analista que resume sesiones de prueba del agente de una clínica. ` +
                `El STAFF estaba probando al agente público haciéndose pasar por un paciente nuevo. ` +
                `Resumí la conversación en 4-6 bullets en español:\n` +
                `  • Qué probó el staff\n` +
                `  • Cómo respondió el agente\n` +
                `  • Aciertos\n` +
                `  • Fallos o fricción\n` +
                `Máximo ~120 palabras. Sin preámbulo, sólo los bullets.`;

            const result = await generateText({
                model: google(env.GEMINI_MODEL),
                system,
                messages: [{ role: 'user', content: transcript }],
                temperature: 0.3,
            } as any);

            const text = (result.text || '').trim();
            return text || '_(El resumidor no produjo salida.)_';
        } catch (err) {
            logger.error('[TestSummary] summarize falló', err, { testConversationId });
            return '_(No se pudo generar el resumen automático.)_';
        }
    }
}
