# 🚀 MedAgent - Estrategia Comercial y de Producto

Este documento centraliza la visión de negocio, el análisis de mercado y las tácticas de venta para **MedAgent**.

---

## 💎 Propuesta de Valor Core
**MedAgent** no es un chatbot; es un **Agente de Operaciones** con razonamiento que automatiza el ciclo de vida del paciente/cliente en WhatsApp e Instagram, eliminando la fricción administrativa y maximizando la ocupación de la agenda.

> *"El equipo de ventas y recepción que trabaja 24/7, califica leads y reduce el no-show sin intervención humana."*

---

## 🎯 Segmentación de Nichos (Targeting)

### 🥇 Nicho Primario: Medicina y Estética (Product-Market Fit)
*   **Clínicas Estéticas:** Botox, rellenos, láser, tratamientos faciales/corporales.
*   **Odontología Estética:** Diseño de sonrisa, implantes, ortodoncia.
*   **Dermatología Especializada:** Consultas privadas y procedimientos menores.
*   **Spas Médicos (MedSpas):** Bienestar de alto ticket.

### 🥈 Nicho Secundario: Salud y Bienestar de Alto Valor
*   **Fisioterapia y Rehabilitación:** Agendamiento de sesiones recurrentes.
*   **Nutrición y Control de Peso:** Filtro inicial y seguimiento de planes.
*   **Veterinarias Premium:** Recordatorios de vacunas y cirugías (ayuno/preparación).

### 🥉 Nicho Terciario: Servicios de Alta Fricción (Potencial)
*   **Inmobiliarias (Real Estate):** Calificación de intención de compra/renta antes de visita física.
*   **Talleres de Detailing Automotriz:** Cotización de servicios estéticos vehiculares.
*   **Asesorías Legales/Contables:** Primer filtro de casos y venta de consultoría.

---

## 🛠️ El "Patient Journey" (Las 4 Fases de Valor)

| Fase | Nombre | Objetivo Comercial | Herramienta Técnica |
| :--- | :--- | :--- | :--- |
| **Fase 1** | **Calificación** | Filtrar "curiosos" de leads reales con presupuesto. | `updateContactProfile` |
| **Fase 2** | **Agendamiento** | Cerrar la cita en el momento de mayor interés. | `getFreeSlots` + GCal |
| **Fase 3** | **No-Show Killer** | Garantizar la asistencia y rentabilidad de la sala. | Automatización de Recordatorios |
| **Fase 4** | **Post-Venta** | Generar recompra y recolección de testimonios. | `getContactSummary` + Follow-ups |

---

## 💰 Planes y Monetización (Estructura de Precios)

| Plan | Target | Precio Sugerido (USD) | Diferenciador Clave |
| :--- | :--- | :--- | :--- |
| **Starter** | Clínicas pequeñas / Independientes | $99/mes | Solo WhatsApp + Agendamiento básico. |
| **Growth** | Clínicas en crecimiento | $199/mes | WA + Recordatorios No-Show + Fases Operativas. |
| **Enterprise** | Redes de clínicas / Consultorios | $399+/mes | Multi-agente + PDF Historia Clínica + API. |

---

## 📈 Argumentos de Venta (Sales Hooks)
1.  **"El lead se enfría en 5 minutos":** MedAgent responde en 10 segundos a las 2 AM.
2.  **"Tu recepcionista es un cuello de botella":** La IA maneja 100 conversaciones simultáneas sin cansarse.
3.  **"El No-Show es dinero quemado":** Reducimos el ausentismo del 25% al 8% mediante recordatorios educativos.
4.  **"Onboarding en 10 minutos":** "Dame tu lista de precios y conectamos tu WhatsApp. Eso es todo."

---

## 📝 Biblioteca de Mensajes (Scripts de Venta/Outbound)

### Hook de Prospección Fría (WhatsApp/LinkedIn)
> *"Hola [Nombre del Dueño/Director], noté que en [Nombre de la Clínica] tienen mucha actividad en Instagram. ¿Cuántos pacientes potenciales pierden a la semana por no responder a tiempo fuera de horario? Tengo un agente IA que está agendando citas en piloto automático para clínicas similares. ¿Te interesa ver cómo funciona?"*

### Mensaje de Cierre de Venta (ROI focus)
> *"Si MedAgent solo rescata 2 citas de botox al mes, la suscripción ya se pagó sola. Todo lo demás es pura utilidad neta para tu clínica."*

---

## 🚀 Roadmap de Marketing
- [ ] **Landing Page:** Enfocada en conversiones (MedAgent.ai).
- [ ] **Casos de Éxito:** Documentar métricas de la primera clínica piloto (Medellín).
- [ ] **Ads Strategy:** Campañas en Meta dirigidas a dueños de negocios estéticos.
- [ ] **Alianzas:** Distribuidores de equipos médicos (Láser, máquinas de cavitación).

---
*Documento vivo - Actualizado el 10 de abril de 2026 por Tony & Gemini CLI*
