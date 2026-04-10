# 🤖 Arquitectura de Agentes - MedAgent

Este documento es una guía técnica para agentes de IA (humanos o máquinas) que necesiten entender, mantener o extender la lógica de agentes conversacionales en este proyecto.

---

## 🏗️ Estructura General

El sistema opera bajo una arquitectura **Serverless / Event-Driven** centrada en Webhooks y procesada por un motor de razonamiento (Gemini) con capacidades de **Tool Calling**.

### 📁 Directorios Clave
- `src/controllers/webhook.controller.ts`: Puerta de entrada. Maneja el ruteo de mensajes y separa los flujos (Público vs. Clínicas vs. Admin).
- `src/services/ai.service.ts`: El "Cerebro". Gestiona los prompts, la construcción del historial y la ejecución de herramientas.
- `src/tools/`: Definición de capacidades que la IA puede ejecutar (CRM, Agendamiento, Multimedia).
- `src/services/clinicas-db.service.ts`: Abstracción de base de datos para el esquema `clinicas` (multi-tenant).

---

## 🚦 Pipeline de Procesamiento (Webhook)

Cuando llega un mensaje, el `WebhookController` sigue este flujo de decisión:

1.  **Identificación de Tenant:** Se busca el `phone_number_id` en la tabla `clinicas.companies`.
    -   **Match:** Se desvía al **Pipeline de Clínicas**.
    -   **No Match:** Se procesa por el **Pipeline Público (Bruno)**.
2.  **Detección de Staff (Admin Agent):** Si el remitente (`from`) es un número registrado en `clinicas.staff`, se activa el modo **Agente Admin** (herramientas de gestión).
3.  **Procesamiento de Media:** Si hay imágenes/audios, se descargan y se suben a Supabase Storage antes de llamar a la IA.
4.  **Generación de Respuesta (IA):**
    -   Se construye el `System Prompt` (Instrucciones + Contexto + Herramientas).
    -   Se envía el historial a Gemini.
    -   Se ejecutan herramientas (si aplica) en un loop de hasta 25 pasos.
5.  **Entrega y Registro:** Se envía la respuesta final por WhatsApp (Kapso) y se guarda en la base de datos.

---

## 🤖 Tipos de Agentes

### Clinic Agent (Clínicas - Pacientes)
- **Objetivo:** Filtrar leads, calificar interés y preparar para el agendamiento.
- **Tools:** `updateContactProfile`, `escalateToHuman`, `sendInteractiveButtons`.
- **Instrucciones:** Dinámicas, extraídas de la tabla `clinicas.agents.system_prompt`.

### Admin Agent (Clínicas - Staff)
- **Objetivo:** Asistir al personal de la clínica en tareas operativas por WhatsApp.
- **Herramientas de Poder:**
    - `searchContacts`: Buscar pacientes.
    - `getFreeSlots`: Consultar disponibilidad (GCal + DB).
    - `updateAppointmentStatus`: Cancelar o confirmar citas.
    - `getDailySummary`: Reporte del día.

### Public Agent (Bruno/Clara)
- **Objetivo:** Demo genérica y prospección multi-propósito.
- **Características:** Maneja `media_library` (biblioteca de recursos multimedia) y asignación comercial humana.

---

## 🛠️ Manejo de Herramientas (Tools)

### Reglas de Oro para la IA:
- **Herramientas de Envío (Media/Interactivos):** Si la IA llama a `sendInteractiveButtons`, el sistema descarta cualquier texto adicional para evitar confusión.
- **Herramientas Silenciosas (CRM):** Si la IA llama a `updateContactProfile`, **DEBE** generar un mensaje de texto para que el usuario no sienta un vacío en la charla. El `AiService` fuerza una segunda llamada si el modelo olvida generar este texto.
- **Sanitización de Botones:** Existe una lógica de seguridad (`sanitizeFakeButtons`) que elimina patrones como `[Opción 1]` del texto plano si la IA intenta "simular" botones en lugar de usar la herramienta nativa.

---

## 📊 Modelos de Datos (Contexto para la IA)

El `AiService` inyecta automáticamente:
- **Contexto Temporal:** Fecha, hora y parte del día en Colombia.
- **Historial de Notas:** Notas previas del CRM para que el agente tenga "memoria a largo plazo".
- **Media Reciente:** Análisis de las últimas imágenes enviadas por el usuario.
- **Biblioteca Multimedia:** Lista de PDFs/Imágenes disponibles para enviar al usuario según el flujo.

---

## 🚨 Manejo de Errores y Soporte
- Si el pipeline falla, el error es **silencioso para el usuario** (no se envía mensaje de error).
- Se dispara una notificación inmediata al equipo de soporte vía WhatsApp con el `request_id` y el stack trace.

---
*Documento generado para guía de agentes de codificación - Abril 2026*
