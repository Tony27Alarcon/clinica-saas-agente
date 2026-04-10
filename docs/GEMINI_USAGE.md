# Uso de Gemini AI SDK en MUNDO SOS (Agentes Backend)

Este mini documento detalla cómo se integra Gemini en nuestro proyecto actual, tomando las mejores prácticas de arquitecturas modulares con el AI SDK de Vercel.

## Qué SDK se usa
- **SDK principal**: `AI SDK` (`ai`) + proveedor Google `@ai-sdk/google`.
- **Inicialización**: Se realiza a través de `createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY })`.
- **Archivo central**: `src/services/ai.service.ts`.
- **Funcionalidades habilitadas**:
  - `generateText(...)` para procesar el historial y obtener respuesta en lenguaje natural.
  - `maxSteps: 5` para habilitar un bucle futuro de razonamiento (útil cuando agreguemos *tools* como "cotizador" o "validador_red").

## Flujo real de un envío a Gemini en este proyecto
- **Entrada principal**:
  - El webhook de Kapso impacta en `src/controllers/webhook.controller.ts`.
  - Allí llamamos a `AiService.generarRespuesta(historial, agente)`.
- **Preparación del contexto**:
  - `DbService.getHistorialMensajes` formatea las conversaciones extraídas de Supabase y las convierte a la interfaz de `CoreMessage` del AI SDK (`user`, `assistant`, o `system`).
- **Llamada al modelo**:
  - Se ejecuta `generateText` en `ai.service.ts`.
  - **system**: Prompt estructurado automáticamente sacando datos de la DB (instrucciones, guardrails, scoring).
  - **messages**: El historial de interacción.
- **Salida**:
  - Generamos una string natural (respuesta) para enviar a Kapso a través de `KapsoService.enviarMensaje`.
  - En caso de falla técnica (excepción de Vercel AI), tenemos un fallback de texto amigable integrado en el `try/catch`.

## Archivos y variables de entorno (`src/config/env.ts`)
- Obligatoria: `GEMINI_API_KEY` mapeada preferiblemente de `GOOGLE_GENERATIVE_AI_API_KEY`.
- Todo está tipado y validado en el arranque, si falta esta variable el log lo advertirá ("Faltan variables de entorno críticas").

## Proyecciones Futuras (Multimodal y Tools)
- Si el usuario (lead de WhatsApp) envía una imagen (ej. foto de su factura), se debe interceptar la URL de la imagen en Kapso, descargar el Buffer y adjuntarlo al array `messages` como objeto `{ type: "image", image: Buffer }`.
- Próximamente se podrá estructurar la salida a Kapso inyectando botones o listas, para eso cambiaremos progresivamente de `generateText` a `generateObject` con `zod`.
