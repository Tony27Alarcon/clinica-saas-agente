# Mundo SOS - Agentes Backend 🚀

Este proyecto es el "cerebro" modular que conecta las interacciones de los clientes desde **Kapso (WhatsApp)** con la inteligencia artificial de **Gemini** y el sistema de gestión de **Supabase**. Está diseñado para ser escalable, rápido y fácil de desplegar en **Railway**.

## 🧠 Arquitectura y Flujo

El flujo de un mensaje funciona de la siguiente manera:

1.  **Entrada**: Kapso envía un webhook al endpoint `/webhook`.
2.  **Identificación**: El sistema busca o crea al contacto en Supabase usando su número de teléfono.
3.  **Conversación**: Se asocia el mensaje a una conversación abierta con el agente **CLARA**.
4.  **Contexto e IA**: Se recupera el historial de mensajes, se procesan datos adjuntos (imágenes/multimodal) y se le envía todo a **Gemini** con las instrucciones de CLARA.
5.  **Respuesta**: Gemini genera la respuesta y el sistema la envía de vuelta al cliente a través de Kapso.
6.  **Memoria**: Todo queda registrado en las tablas de `mensajes` de Supabase para futuras interacciones.

## 🛠️ Tecnologías Usadas

*   **Node.js & TypeScript**: Base del servidor.
*   **Express**: Framework para el endpoint del webhook.
*   **Supabase (PostgreSQL)**: Base de datos y CRM.
*   **Vercel AI SDK**: Para la comunicación fluida con LLMs.
*   **Gemini (Google AI)**: El motor de inteligencia artificial.
*   **Axios & Sharp**: Para el procesamiento de imágenes multimodales.

## 📁 Estructura del Proyecto

*   `src/index.ts`: Punto de entrada del servidor.
*   `src/controllers/`: Lógica de control del webhook.
*   `src/services/`: 
    *   `ai.service.ts`: Integración con Gemini.
    *   `db.service.ts`: Consultas y registros en Supabase.
    *   `kapso.service.ts`: Conector de salida para mensajes.
    *   `media.service.ts`: Descarga y optimización de imágenes.
*   `src/config/`: Manejo de variables de entorno y clientes.
*   `docs/`: Documentación técnica extendida.

## ⚙️ Configuración (Variables de Entorno)

Para que el proyecto funcione, debes configurar las siguientes variables en un archivo `.env` o en el panel de Railway:

| Variable | Descripción |
| :--- | :--- |
| `SUPABASE_URL` | URL de tu proyecto en Supabase. |
| `SUPABASE_SERVICE_KEY` | Key de Service Role para acceso a la DB. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Tu API Key de Google Gemini. |
| `KAPSO_API_URL` | URL del endpoint de Kapso para enviar mensajes. |
| `KAPSO_API_TOKEN` | Token de autorización de Kapso. |
| `KAPSO_WEBHOOK_SECRET` | Secreto para validar que las peticiones vienen de Kapso. |
| `PORT` | Puerto del servidor (por defecto 3000). |

## 🚀 Despliegue en Railway

1.  Conecta este repositorio de GitHub a tu cuenta de Railway.
2.  Crea un nuevo servicio desde el repositorio.
3.  Agrega las variables de entorno mencionadas arriba.
4.  Railway detectará automáticamente el comando `npm start` y levantará el servicio.

---
**Generamos más que energía.** ☀️
