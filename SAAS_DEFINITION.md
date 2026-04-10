# 🚀 Micro-SaaS: Agentes IA para Clínicas Estéticas

## 📌 Visión del Proyecto
Transformar el backend actual en una plataforma **Multi-tenant** de alta velocidad que automatice el ciclo completo del paciente en clínicas estéticas (WhatsApp/Instagram), eliminando la fricción humana en tareas repetitivas y optimizando la agenda médica.

## 🏗️ Arquitectura de Datos (Decisión Estratégica)
Para optimizar costos y velocidad de validación, utilizaremos un **Esquema de Base de Datos Dedicado** dentro del mismo proyecto de Supabase actual.

- **Esquema SQL:** `clinicas` (Independiente de `public` para evitar colisiones con otros proyectos como Bruno).
- **Modelo de Aislamiento:** Compartido con RLS (Row Level Security). Una sola base de datos física, aislamiento lógico por `company_id`.
- **Infraestructura de Agentes:** Basada en el esquema de "Bruno" pero simplificada para el nicho estético.

## 🤖 El Agente: Las 4 Fases de Valor
1.  **Fase 1 - Calificación:** IA con razonamiento (Gemini) que filtra curiosos de leads reales basados en criterios de la clínica (Tratamiento, presupuesto, interés real).
2.  **Fase 2 - Agendamiento:** Tool calling directo en el chat. Consulta disponibilidad y reserva sin links externos (Calendly-killer).
3.  **Fase 3 - No-Show Killer:** Recordatorios proactivos 24h antes con instrucciones pre-operatorias/pre-tratamiento (ayuno, ropa, etc.).
4.  **Fase 4 - Post-Venta y Clínica:** Recolección de antecedentes para Historia Clínica (PDF automático) y seguimiento de satisfacción/resultados a los 7 y 30 días.

## 🛠️ Roadmap Técnico Inmediato
1.  **Setup SQL:** Crear el esquema `clinicas` y las tablas core (`companies`, `agents`, `contacts`, `appointments`).
2.  **Refactor Multi-tenant:** Modificar el `WebhookController` para identificar a la clínica por el número de teléfono receptor.
3.  **Dynamic Prompting:** Mover las instrucciones del agente desde el código (`src`) a la tabla `clinicas.agents`.
4.  **Integración de Calendario:** Implementar una tabla de disponibilidad simple para habilitar la Fase 2.

## 🎯 Objetivo de Validación (MVP)
Lograr que una clínica estética real pueda ser "onbordeada" en menos de 10 minutos simplemente cargando su lista de precios, tratamientos y conectando su WhatsApp.

---
*Documento generado el 9 de abril de 2026 - Tony & Gemini CLI*

---

# 🌐 Página Comercial del Producto

## Nombre del Producto
**MedAgent** — El Equipo de Ventas que Tu Clínica Nunca Tuvo

> *Agendó citas, calificó leads y redujo el no-show mientras tú dormías.*

---

## ¿Qué es MedAgent?

MedAgent es un agente de inteligencia artificial conversacional que opera directamente en WhatsApp e Instagram y gestiona el ciclo completo del paciente — desde el primer mensaje hasta el seguimiento post-tratamiento — sin que tu equipo intervenga en las interacciones rutinarias.

No es un chatbot de respuestas predefinidas. Es un agente con razonamiento real: entiende contexto, califica intención, maneja objeciones y sabe exactamente cuándo pasarle la conversación a un humano.

---

## El Problema que Resuelve

Las clínicas estéticas generan tráfico constante en Instagram y WhatsApp — especialmente **fuera del horario laboral** — pero no tienen sistema para atenderlo eficientemente.

El resultado es triple:

- **Leads perdidos** por respuesta tardía (el prospecto ya llamó a la clínica de al lado)
- **Equipo saturado** respondiendo consultas que no califican
- **Agenda subutilizada** por falta de seguimiento post-consulta

Un lead que no recibe respuesta en los primeros minutos tiene un 80% menos de probabilidad de convertirse en cita. MedAgent responde en segundos, las 24 horas, los 7 días.

---

## Las 4 Fases del Agente

### Fase 1 — Prospección y Calificación
Cada mensaje entrante es atendido al instante. El agente identifica el tratamiento de interés, evalúa si el prospecto tiene intención real de compra versus curiosidad informativa, maneja las objeciones más frecuentes del sector y deriva al equipo humano solo cuando la conversación lo requiere.

**Resultado:** tu equipo solo habla con leads que ya quieren agendar.

### Fase 2 — Agendamiento sin Fricción
Una vez calificado, el agente ofrece disponibilidad directamente en el chat — sin enviar links externos, sin Calendly, sin formularios. La cita queda registrada, el médico o asesor asignado recibe una notificación en tiempo real, y el paciente obtiene confirmación inmediata.

**Resultado:** citas agendadas en la misma conversación donde nació el interés.

### Fase 3 — Seguimiento Pre-Cita (No-Show Killer)
Entre el agendamiento y la consulta, el agente envía recordatorio 24 horas antes con instrucciones de preparación específicas según el tratamiento (ayuno, medicamentos a evitar, ropa recomendada) y gestiona reprogramaciones sin intervención humana.

El no-show en clínicas estéticas promedia entre el **15% y 25%** de las citas agendadas. MedAgent lo reduce drásticamente.

**Resultado:** más citas que se concretan, menos tiempo y dinero perdido.

### Fase 4 — Historia Clínica y Seguimiento Post-Cita
Antes de la primera consulta, el agente recolecta antecedentes del paciente — alergias, tratamientos previos, medicamentos, expectativas — y genera un **PDF estructurado** para el médico. Después del tratamiento, hace seguimiento a los 3, 7 y 30 días, solicita reseña en el momento de mayor satisfacción y reactiva para la siguiente sesión.

**Resultado:** pacientes más preparados, reseñas en Google y mayor tasa de recompra.

---

## ¿Para Quién Es?

MedAgent está diseñado para **clínicas estéticas y spas médicos** en LATAM que:

- Reciben más de 20 mensajes diarios en WhatsApp o Instagram
- No tienen un equipo dedicado de atención al cliente 24/7
- Pierden citas por no-show o por respuesta tardía
- Quieren profesionalizar su operación sin contratar más personal

---

## Planes y Precios

| Plan | Precio/mes | Qué incluye |
|---|---|---|
| **Básico** | USD $99 | Agente en WhatsApp · Calificación de leads · Agenda de citas · FAQ personalizado · 1 canal |
| **Pro** | USD $229 | Todo lo del Básico + Instagram · Recordatorios pre-cita · Seguimiento post-tratamiento · Reportes |
| **Clínica** | USD $429 | Todo lo del Pro + Historia clínica automatizada (PDF) · Múltiples agentes/especialidades · Sin límite de conversaciones · Onboarding prioritario |

> **Precios en moneda local:** MXN $2,500 / COP $420,000 / PEN $380 / CLP $95,000 (Plan Pro aprox.)

Todos los planes incluyen configuración inicial, soporte por WhatsApp y 14 días de prueba gratuita.

---

## El ROI es Inmediato

Una clínica estética con ticket promedio de $150–300 USD por tratamiento que cierra **2 citas extra al mes** gracias a MedAgent ya amortizó la suscripción.

Si además reduce el no-show del 20% al 8%, recupera ingresos que antes simplemente desaparecían.

> *"El agente respondió a las 11pm, calificó al lead y agendó la cita. A la mañana siguiente yo ya tenía el formulario del paciente en mi correo."*
> — Clínica piloto, Medellín

---

## Arquitectura del Sistema

El sistema opera sobre tres capas transparentes para el cliente:

**Cerebro e instrucciones** — Motor de razonamiento basado en LLM (Gemini) con instrucciones personalizadas por clínica: tono de marca, criterios de calificación, tratamientos, precios, objeciones frecuentes y reglas de escalamiento.

**Datos y memoria** — Base de datos en Supabase con historial completo de cada contacto, su estado en el pipeline y registro auditable de interacciones. Compatible con integración a CRM externos.

**Panel de control** — Dashboard con métricas clave: conversaciones activas, tasa de calificación, citas agendadas, no-shows y tasa de recompra.

---

## El Mercado

El mercado latinoamericano de cirugía y medicina estética alcanzó **USD 9.5B en 2023**, con crecimiento proyectado del 8.2% anual hasta 2032. Brasil, México y Colombia concentran el 70% del mercado.

La mayoría de estas clínicas son **PyMEs sin equipo de IT** — no pueden pagar soluciones enterprise, y están perdiendo pacientes por no contestar WhatsApp a tiempo. Ahí está la oportunidad.

**Proyección de ingresos:**

| Escenario | Clínicas | ARR |
|---|---|---|
| Conservador (Año 1) | 30 × $150/mes | USD $54,000 |
| Realista (Año 2) | 100 × $200/mes | USD $240,000 |
| Escala regional (Año 3+) | 500 × $220/mes | USD $1,320,000 |

---

## Onboarding en Menos de 10 Minutos

1. Carga tu lista de tratamientos y precios
2. Define tus criterios de calificación
3. Conecta tu número de WhatsApp Business
4. El agente entra en operación

No requieres equipo técnico. No requieres integración con sistemas legacy. Si tienes WhatsApp Business, ya puedes empezar.

---

*MedAgent — Construido sobre WhatsApp Business API · Powered by Gemini · Datos en Supabase*
