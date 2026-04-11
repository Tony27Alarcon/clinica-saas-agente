import { AiService } from './src/services/ai.service';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
    console.log("Testing AiService.generarRespuestaClinicas...");
    const contact = { phone: '5551234', name: 'Pepe', status: 'prospecto', temperature: 'frio' };
    const conversation = { id: 1234 };
    const agent = {
        system_prompt: 'Eres un bot amable.',
        objections_kb: []
    };
    const historial = [{ role: 'user', content: 'Hola' } as any];

    try {
        const response = await AiService.generarRespuestaClinicas(historial, agent, contact, conversation, "PHONE_1");
        console.log("RESPONSE:", response);
    } catch (e) {
        console.error("ERROR:", e);
    }
}
test();
